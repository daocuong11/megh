import { createHash, randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import {
  ApiController,
  Authorized,
  Delete,
  Get,
  MeghRequest,
  OpenApi,
  Post,
  RateLimit,
  type IRequest,
} from "@meghjs/core";
import type { ToolFilter } from "./registry";
import type { ToolSet } from "./toolset";

/** Options of `app.useMcp(...)`. */
export interface McpOptions {
  /**
   * Which tools to serve. Required, so nothing is exposed by accident: a
   * filter such as `{ tags: ["public"] }`, or `"all"` for every `@Tool` route.
   */
  tools: ToolFilter | "all";
  /** URL of the MCP endpoint. Default `/mcp`. */
  path?: string;
  /**
   * Protect the endpoint itself with `@Authorized`: `true` for the default
   * authorizer, or a name / options object as `@Authorized()` takes. Each
   * tool call is authorized by its own route either way; this also keeps
   * the list of tools private.
   */
  authorize?: true | string | { name?: string; [key: string]: unknown };
  /** `@RateLimit` options for the endpoint. */
  rateLimit?: Parameters<typeof RateLimit>[0];
  /**
   * How a `confirm: true` tool gets a person's approval:
   * - `"elicit"` (default): the server asks the user through the client
   *   (MCP elicitation). A client that can't ask gets an error instead.
   *   Needs sessions.
   * - `"client"`: rely on the client's own tool approval. MCP clients such as
   *   Claude Code ask before each call; the tool is marked destructive.
   * - `"refuse"`: leave confirm tools out of the server.
   */
  confirm?: "elicit" | "client" | "refuse";
  /**
   * Keep a session per client (default `true`). Sessions live in this
   * process, so run one instance or use sticky sessions. `false` makes the
   * server stateless, so any instance can answer, but it can't ask the user
   * for approval: set `confirm` to `"client"` or `"refuse"`.
   */
  sessions?: boolean;
  /** Close a session after this many milliseconds without a request. Default 30 minutes. */
  sessionTimeout?: number;
  /** Server name reported to clients. Default `"megh"`. */
  name?: string;
  /** Server version reported to clients. Default `"1.0.0"`. */
  version?: string;
  /** Instructions for the model, sent when a client connects. */
  instructions?: string;
}

/** @internal The SDK modules, loaded when `useMcp` is called. */
export interface McpSdk {
  Server: any;
  StreamableHTTPServerTransport: any;
  ListToolsRequestSchema: any;
  CallToolRequestSchema: any;
}

export function loadSdk(): McpSdk {
  const load = (sub: string) => {
    const id = `@modelcontextprotocol/sdk/${sub}`;
    const resolved = require.resolve(id, { paths: [process.cwd(), __dirname] });
    return require(resolved);
  };
  try {
    return {
      Server: load("server/index.js").Server,
      StreamableHTTPServerTransport: load("server/streamableHttp.js").StreamableHTTPServerTransport,
      ListToolsRequestSchema: load("types.js").ListToolsRequestSchema,
      CallToolRequestSchema: load("types.js").CallToolRequestSchema,
    };
  } catch {
    throw new Error("[Megh] app.useMcp() needs the MCP SDK: npm install @modelcontextprotocol/sdk");
  }
}

/** Throw on options that can't work together. */
export function assertMcpOptions(options: McpOptions): void {
  if (!options || (options.tools !== "all" && (typeof options.tools !== "object" || options.tools === null))) {
    throw new Error(
      '[Megh] app.useMcp() needs tools: a filter such as { tags: ["public"] }, or "all" to serve every @Tool route.',
    );
  }
  if (options.sessions === false && (options.confirm ?? "elicit") === "elicit") {
    throw new Error(
      '[Megh] app.useMcp({ sessions: false }) can\'t ask the user to approve confirm tools. Set confirm: "client" or "refuse".',
    );
  }
}

type Reply = { hijack(): void; raw: ServerResponse; getHeaders(): Record<string, unknown> };

/** @internal */
export interface McpContext {
  sdk: McpSdk;
  tools: ToolSet;
  options: McpOptions;
  /** The Fastify reply of a request, stashed by an onRequest hook. */
  reply(raw: IncomingMessage): Reply | undefined;
}

interface Session {
  transport: any;
  server: any;
  /** Hash of the credentials that opened the session. */
  owner: string;
  lastSeen: number;
}

/** @internal The MCP endpoint: a controller, plus `close()` for shutdown. */
export function createMcpEndpoint(ctx: McpContext): { controller: Function; close(): Promise<void> } {
  const path = ctx.options.path ?? "/mcp";
  const stateful = ctx.options.sessions !== false;
  const timeout = ctx.options.sessionTimeout ?? 30 * 60_000;
  const sessions = new Map<string, Session>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastSeen > timeout) void closeSession(id);
  }, Math.min(timeout, 60_000));
  sweep.unref();

  async function closeSession(id: string) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await s.transport.close();
    await s.server.close();
  }

  async function handle(req: IRequest, method: "POST" | "GET" | "DELETE") {
    const reply = take(ctx, req);
    const raw = (req as any).raw as IncomingMessage;
    const body = (req as any).body;

    if (!stateful) {
      if (method !== "POST") return jsonRpcError(reply, 405, "This MCP server is stateless; use POST.", { allow: "POST" });
      const server = createMcpServer(ctx);
      const transport = new ctx.sdk.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      reply.raw.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      return transport.handleRequest(raw, reply.raw, body);
    }

    const id = raw.headers["mcp-session-id"];
    if (typeof id === "string") {
      const s = sessions.get(id);
      // 404 tells the client to start a new session.
      if (!s) return jsonRpcError(reply, 404, "Session not found.");
      // A session ID alone isn't enough: the same credentials must come with it.
      if (s.owner !== owner(raw)) return jsonRpcError(reply, 403, "This session belongs to another client.");
      s.lastSeen = Date.now();
      return s.transport.handleRequest(raw, reply.raw, body);
    }

    if (method !== "POST" || !isInitialize(body)) {
      return jsonRpcError(reply, 400, "No session: send an initialize request first.");
    }
    const server = createMcpServer(ctx);
    const transport = new ctx.sdk.StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        sessions.set(sid, { transport, server, owner: owner(raw), lastSeen: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return transport.handleRequest(raw, reply.raw, body);
  }

  // Left out of the OpenAPI document: it speaks JSON-RPC, not REST.
  @OpenApi({ exclude: true } as any)
  @ApiController(path)
  class MeghMcpController {
    @Post("/")
    post(@MeghRequest() req: IRequest) {
      return handle(req, "POST");
    }

    /** The server-to-client stream of a session. */
    @Get("/")
    stream(@MeghRequest() req: IRequest) {
      return handle(req, "GET");
    }

    /** Ends a session. */
    @Delete("/")
    end(@MeghRequest() req: IRequest) {
      return handle(req, "DELETE");
    }
  }

  const { authorize, rateLimit } = ctx.options;
  if (authorize) (Authorized as any)(authorize === true ? {} : authorize)(MeghMcpController);
  if (rateLimit !== undefined) RateLimit(rateLimit)(MeghMcpController);

  return {
    controller: MeghMcpController,
    async close() {
      clearInterval(sweep);
      await Promise.all([...sessions.keys()].map(closeSession));
    },
  };
}

function isInitialize(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((m) => m && typeof m === "object" && (m as any).method === "initialize");
}

/** Who opened a session: a hash of its credentials, never the credentials themselves. */
function owner(raw: IncomingMessage): string {
  const parts = ["authorization", "x-api-key"].map((h) => String(raw.headers[h] ?? ""));
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** Take over the response, keeping headers set so far (CORS, request ID, security headers). */
function take(ctx: McpContext, req: IRequest): Reply {
  const reply = ctx.reply((req as any).raw);
  if (!reply) throw new Error("[Megh] MCP request without a reply; is the @meghjs/ai plugin registered?");
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value as any);
  }
  reply.hijack();
  return reply;
}

function jsonRpcError(reply: Reply, status: number, message: string, headers: Record<string, string> = {}) {
  reply.raw.writeHead(status, { "content-type": "application/json", ...headers });
  reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/** The tools this endpoint serves. */
function served(ctx: McpContext): ToolSet {
  const { tools, confirm } = ctx.options;
  const set = tools === "all" ? ctx.tools : ctx.tools.filter(tools);
  return confirm === "refuse" ? set.filter({ confirm: false }) : set;
}

/** @internal An MCP server. Each tool call runs as the HTTP request that carried it. */
export function createMcpServer(ctx: McpContext): any {
  const { sdk, options } = ctx;
  const server = new sdk.Server(
    { name: options.name ?? "megh", version: options.version ?? "1.0.0" },
    {
      capabilities: { tools: {} },
      ...(options.instructions && { instructions: options.instructions }),
    },
  );
  const tools = served(ctx);
  const mode = options.confirm ?? "elicit";

  server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({
    tools: tools.forMcp(),
  }));

  server.setRequestHandler(sdk.CallToolRequestSchema, async (request: any, extra: any) => {
    const name: string = request.params.name;
    const args = request.params.arguments ?? {};
    const tool = tools.get(name);
    if (!tool) return error(`Unknown tool "${name}".`);

    let confirmed = false;
    if (tool.confirm) {
      if (mode === "client") confirmed = true;
      else {
        if (!server.getClientCapabilities()?.elicitation) {
          return error(`The tool "${name}" needs the user's approval, but this client can't ask for it. It did not run.`);
        }
        const answer = await server.elicitInput({
          message: `Allow "${name}" to run?\n${tool.description}\n\nArguments: ${JSON.stringify(args)}`,
          requestedSchema: {
            type: "object",
            properties: { approve: { type: "boolean", title: "Approve", description: "Run this tool" } },
            required: ["approve"],
          },
        });
        if (answer.action !== "accept" || answer.content?.approve !== true) {
          return error(`The user did not approve "${name}". It did not run.`);
        }
        confirmed = true;
      }
    }

    // The headers of the HTTP request carrying this call, so the tool's route
    // authenticates the caller, even in a long-lived session.
    const headers = extra?.requestInfo?.headers ?? {};
    const result = await tools.call(name, args, { request: { headers }, confirmed });
    return { content: [{ type: "text", text: result.content }], ...(!result.ok && { isError: true }) };
  });

  return server;
}

function error(text: string) {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}
