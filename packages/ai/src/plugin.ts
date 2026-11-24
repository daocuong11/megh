import { definePlugin, getRouteDescriptor, type RouteDescriptor } from "@meghjs/core";
import { toDefinition, type ToolDefinition, type ToolFilter } from "./registry";
import { defaultToolName, getToolOptions } from "./tool";
import { ToolSet, type ToolRuntime, type ToolsConfig } from "./toolset";
import { assertMcpOptions, createMcpEndpoint, loadSdk, type McpOptions } from "./mcp";
import type { IncomingMessage } from "http";

declare module "@meghjs/core" {
  interface MeghApplication {
    /**
     * The `@Tool` routes, for an LLM: `app.tools({ tags: ['orders'] }).forAnthropic()`.
     * The set is read when used, so it's complete once the app has started.
     */
    tools(filter?: ToolFilter): ToolSet;
    /** Settings for every tool call: output limit, forwarded headers, audit logging. */
    useTools(config: ToolsConfig): this;
    /**
     * Serve `@Tool` routes as an MCP server over Streamable HTTP, at `/mcp` by
     * default. Clients sign in like any API client (bearer token, API key);
     * each tool call runs as that caller, through the tool route's own
     * authentication and authorization. Needs `@modelcontextprotocol/sdk`.
     */
    useMcp(options: McpOptions): this;
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const aiPlugin = definePlugin({
  name: "@meghjs/ai",
  register(ctx) {
    const tools = new Map<string, ToolDefinition>();
    const seen = new WeakSet<RouteDescriptor>();
    let config: ToolsConfig = {};

    ctx.http.addHook("onRoute", (route) => {
      const descriptor = getRouteDescriptor(route);
      if (!descriptor || seen.has(descriptor)) return;
      const options = getToolOptions(descriptor.controller, descriptor.handler);
      if (!options) return;
      const method = (Array.isArray(route.method) ? route.method[0] : route.method).toUpperCase();
      // Fastify adds a HEAD route for each GET; versioned routes register
      // several URLs. The first registration is the tool.
      if (method === "HEAD") return;
      seen.add(descriptor);

      const where = `${descriptor.controller.name}.${descriptor.handler}`;
      if (Array.isArray(route.method) && route.method.length > 1) {
        throw new Error(`[Megh] @Tool on ${where}: a tool needs a route with one HTTP method, not @All().`);
      }
      const name = options.name ?? defaultToolName(descriptor.controller, descriptor.handler);
      const existing = tools.get(name);
      if (existing) {
        throw new Error(
          `[Megh] Two tools are named "${name}" (${existing.controller}.${existing.handler} and ${where}). ` +
            "Give one a name with @Tool({ name }).",
        );
      }
      if (MUTATING.has(method) && options.confirm === undefined && ctx.app.isDevelopment()) {
        ctx.logger.warn(
          `@Tool on ${method} ${route.url} (${where}) has side effects but doesn't set confirm. ` +
            "Set confirm: true to require a person's approval, or confirm: false to allow it without one.",
        );
      }
      tools.set(name, toDefinition(descriptor, options, name, method, route.url));
    });

    const runtime: ToolRuntime = {
      tools: () => [...tools.values()],
      config: () => config,
      inject: async (opts) => {
        const res = await ctx.http.inject({
          method: opts.method as any,
          url: opts.url,
          query: opts.query,
          payload: opts.payload as any,
          headers: opts.headers,
        });
        return { statusCode: res.statusCode, body: res.body, headers: res.headers };
      },
      log: (entry, message) => ctx.logger.info(entry, message),
    };
    const all = new ToolSet(runtime);
    // Injectable: `constructor(private readonly tools: ToolSet)`.
    ctx.container.set(ToolSet, all);
    ctx.extend("tools", (filter?: ToolFilter) => (filter ? all.filter(filter) : all));

    // useMcp's handler takes over the raw response; Megh passes it the request only.
    const replies = new WeakMap<IncomingMessage, any>();
    let mcp = false;
    ctx.http.addHook("onRequest", (request, reply, done) => {
      if (mcp) replies.set(request.raw, reply);
      done();
    });

    ctx.extend("useMcp", (options: McpOptions) => {
      if (mcp) throw new Error("[Megh] app.useMcp() can only be called once.");
      assertMcpOptions(options);
      const sdk = loadSdk();
      mcp = true;
      const endpoint = createMcpEndpoint({ sdk, tools: all, options, reply: (raw) => replies.get(raw) });
      ctx.app.useControllers([endpoint.controller as any]);
      ctx.onClose(() => endpoint.close());
      return ctx.app;
    });

    ctx.extend("useTools", (next: ToolsConfig) => {
      config = { ...config, ...next };
      return ctx.app;
    });
  },
});

export default aiPlugin;
