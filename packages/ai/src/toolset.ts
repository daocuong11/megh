import type { ToolDefinition, ToolFilter, JsonSchema } from "./registry";
import { matches } from "./registry";

/** Settings from `app.useTools(...)`. */
export interface ToolsConfig {
  /**
   * Largest response, in characters, sent back to the model. A longer one is
   * cut and marked `truncated`, so one tool can't flood the context (and the
   * bill). Default 20 000. `@Tool({ maxOutput })` overrides it per tool.
   */
  maxOutput?: number;
  /**
   * Request headers copied from `call(..., { request })`, so the tool runs
   * as the same user. Default: `authorization`, `cookie`, `x-api-key` and
   * `x-request-id`.
   */
  forwardHeaders?: string[];
  /**
   * Log each call's arguments in the audit line. Off by default, since
   * arguments can hold personal data.
   */
  logArguments?: boolean;
}

export interface ToolCallOptions {
  /** The incoming request to act for: its auth headers are forwarded. */
  request?: { headers: Record<string, string | string[] | undefined> };
  /** Extra headers for the tool's request, such as `authorization`. */
  headers?: Record<string, string>;
  /** A person approved this call. Needed for `confirm: true` tools. */
  confirmed?: boolean;
}

export interface ToolResult {
  /** The route answered 2xx. */
  ok: boolean;
  /** HTTP status of the route's response, or 0 when the call never reached it. */
  status: number;
  /** The parsed response body (JSON when possible). */
  data?: unknown;
  /** The text to send back to the model. */
  content: string;
  /** `content` was cut to the output limit. */
  truncated?: boolean;
  /** The tool needs approval: call again with `confirmed: true`. Nothing ran. */
  needsConfirmation?: boolean;
}

/** @internal What a ToolSet needs from the app. */
export interface ToolRuntime {
  tools(): ToolDefinition[];
  config(): ToolsConfig;
  inject(opts: {
    method: string;
    url: string;
    query?: Record<string, string | string[]>;
    payload?: unknown;
    headers: Record<string, string>;
  }): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }>;
  log(entry: Record<string, unknown>, message: string): void;
}

const DEFAULT_FORWARD = ["authorization", "cookie", "x-api-key", "x-request-id"];
const DEFAULT_MAX_OUTPUT = 20_000;

/** The tools picked by `app.tools(filter)`, read when used, so routes added later show up. */
export class ToolSet {
  /** @internal */
  constructor(
    private readonly runtime: ToolRuntime,
    private readonly selection?: ToolFilter,
  ) {}

  /** A narrower set: the tools in this one that also match `filter`. */
  filter(filter: ToolFilter): ToolSet {
    const outer = this.selection;
    return new ToolSet(
      { ...this.runtime, tools: () => this.runtime.tools().filter((t) => matches(t, outer)) },
      filter,
    );
  }

  /** The tools in this set. */
  list(): ToolDefinition[] {
    return this.runtime.tools().filter((t) => matches(t, this.selection));
  }

  get(name: string): ToolDefinition | undefined {
    return this.list().find((t) => t.name === name);
  }

  /** Anthropic Messages API `tools`. */
  forAnthropic(): { name: string; description: string; input_schema: JsonSchema }[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  /** OpenAI Chat Completions `tools`. */
  forOpenAI(): {
    type: "function";
    function: { name: string; description: string; parameters: JsonSchema };
  }[] {
    return this.list().map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  /** MCP `tools/list` entries, with read-only and destructive hints. */
  forMcp(): {
    name: string;
    description: string;
    inputSchema: JsonSchema;
    annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  }[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { readOnlyHint: t.readOnly, destructiveHint: !t.readOnly && t.confirm },
    }));
  }

  /**
   * Run a tool as an HTTP request to its route, through the full pipeline.
   * Errors from the route (400, 403, 404, ...) come back as a result with
   * `ok: false`, in a form the model can correct itself from; they don't throw.
   */
  async call(name: string, args: unknown, options: ToolCallOptions = {}): Promise<ToolResult> {
    const tool = this.get(name);
    if (!tool) return fail(0, `Unknown tool "${name}".`);
    if (tool.confirm && options.confirmed !== true) {
      return {
        ok: false,
        status: 0,
        needsConfirmation: true,
        content: `The tool "${name}" needs a person's approval before it runs. It did not run.`,
      };
    }

    const built = buildRequest(tool, args);
    if ("error" in built) return fail(0, built.error);

    const config = this.runtime.config();
    const headers: Record<string, string> = {};
    for (const h of config.forwardHeaders ?? DEFAULT_FORWARD) {
      const v = options.request?.headers?.[h.toLowerCase()];
      if (typeof v === "string") headers[h.toLowerCase()] = v;
      else if (Array.isArray(v) && v.length) headers[h.toLowerCase()] = v.join(", ");
    }
    for (const [k, v] of Object.entries(options.headers ?? {})) headers[k.toLowerCase()] = v;
    headers["x-megh-tool"] = tool.name;

    const started = Date.now();
    const res = await this.runtime.inject({ ...built, method: tool.method, headers });
    const data = parse(res.body);
    const ok = res.statusCode >= 200 && res.statusCode < 300;

    this.runtime.log(
      {
        tool: tool.name,
        status: res.statusCode,
        ok,
        durationMs: Date.now() - started,
        requestId: res.headers["x-request-id"],
        ...(config.logArguments ? { args } : {}),
      },
      `tool ${tool.name} → ${res.statusCode}`,
    );

    const raw =
      data === undefined
        ? `${res.statusCode} (no content)`
        : typeof data === "string"
          ? data
          : JSON.stringify(data);
    const text = ok ? raw : `Error ${res.statusCode}: ${raw}`;
    const max = tool.maxOutput ?? config.maxOutput ?? DEFAULT_MAX_OUTPUT;
    const truncated = text.length > max;
    return {
      ok,
      status: res.statusCode,
      data,
      content: truncated
        ? `${text.slice(0, max)}\n[truncated: ${text.length - max} more characters]`
        : text,
      ...(truncated && { truncated }),
    };
  }

  /**
   * Run the `tool_use` blocks of an Anthropic response and return the
   * `tool_result` blocks for the next user message. A `confirm` tool that
   * wasn't approved comes back as an error result telling the model so.
   */
  async anthropicResults(
    content: readonly { type: string; id?: string; name?: string; input?: unknown }[],
    options: ToolCallOptions = {},
  ): Promise<{ type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }[]> {
    const uses = content.filter((b) => b.type === "tool_use" && b.id && b.name);
    return Promise.all(
      uses.map(async (b) => {
        const r = await this.call(b.name!, b.input, options);
        return { type: "tool_result" as const, tool_use_id: b.id!, content: r.content, is_error: !r.ok };
      }),
    );
  }

  /**
   * Run the `tool_calls` of an OpenAI Chat Completions message and return
   * the `tool` messages to append.
   */
  async openAIResults(
    toolCalls: readonly { id: string; function: { name: string; arguments: string } }[] | undefined,
    options: ToolCallOptions = {},
  ): Promise<{ role: "tool"; tool_call_id: string; content: string }[]> {
    return Promise.all(
      (toolCalls ?? []).map(async (c) => {
        let args: unknown;
        try {
          args = c.function.arguments ? JSON.parse(c.function.arguments) : {};
        } catch {
          return { role: "tool" as const, tool_call_id: c.id, content: "Error: the arguments are not valid JSON." };
        }
        const r = await this.call(c.function.name, args, options);
        return { role: "tool" as const, tool_call_id: c.id, content: r.content };
      }),
    );
  }
}

function fail(status: number, content: string): ToolResult {
  return { ok: false, status, content: `Error: ${content}` };
}

function parse(body: string): unknown {
  if (body === "") return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** @internal Map the model's arguments onto the route's URL, query and body. */
export function buildRequest(
  tool: ToolDefinition,
  args: unknown,
):
  | { url: string; query?: Record<string, string | string[]>; payload?: unknown }
  | { error: string } {
  const input = args ?? {};
  if (typeof input !== "object" || Array.isArray(input))
    return { error: "the arguments must be a JSON object." };
  const a = input as Record<string, unknown>;
  const { layout } = tool;

  const known = new Set([
    ...layout.path,
    ...layout.query,
    ...(layout.body === "flat" ? layout.bodyKeys : layout.body === "nested" ? ["body"] : []),
  ]);
  const unknown = Object.keys(a).filter((k) => !known.has(k));
  if (unknown.length)
    return {
      error: `unknown argument${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")}. Expected: ${[...known].join(", ") || "none"}.`,
    };

  let url = tool.url;
  for (const p of layout.path) {
    const v = a[p];
    if (v === undefined || v === null || v === "")
      return { error: `missing required argument "${p}".` };
    url = url.replace(`:${p}`, encodeURIComponent(String(v)));
  }

  const query: Record<string, string | string[]> = {};
  for (const q of layout.query) {
    const v = a[q];
    if (v === undefined || v === null) continue;
    query[q] = Array.isArray(v)
      ? v.map((x) => String(x))
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
  }

  let payload: unknown;
  if (layout.body === "nested") payload = a.body;
  else if (layout.body === "flat") {
    const body: Record<string, unknown> = {};
    for (const k of layout.bodyKeys) if (k in a) body[k] = a[k];
    payload = body;
  }

  return {
    url,
    ...(Object.keys(query).length && { query }),
    ...(payload !== undefined && { payload }),
  };
}
