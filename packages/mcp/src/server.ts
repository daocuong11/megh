import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Docs } from "./docs";
import { resolveProject } from "./megh";
import { registerPrompts } from "./prompts";
import { registerDatabaseTools } from "./tools/database";
import { registerDocs } from "./tools/docs";
import { registerGenerateTools } from "./tools/generate";
import { registerProjectTools } from "./tools/project";
import type { ToolContext } from "./tools/context";

export { GENERATORS } from "./tools/generate";

export type ServerOptions = {
  /** Project used when a tool call gives no `cwd`. Defaults to `MEGH_PROJECT_ROOT`, else `process.cwd()`. */
  projectRoot?: string;
  /** Version reported to clients. */
  version?: string;
  /**
   * Leave out the tools that write files or change the database (generators,
   * build, migrate, rollback, seed). Defaults to `MEGH_MCP_READ_ONLY=1`.
   */
  readOnly?: boolean;
  /** Docs to serve. Defaults to the bundled docs. */
  docs?: Docs;
};

export function createServer(opts: ServerOptions = {}): McpServer {
  const defaultRoot = opts.projectRoot ?? process.env.MEGH_PROJECT_ROOT ?? process.cwd();
  const readOnly = opts.readOnly ?? process.env.MEGH_MCP_READ_ONLY === "1";

  const server = new McpServer(
    { name: "megh", version: opts.version ?? "0.0.0" },
    {
      instructions:
        "Tools for Megh (@meghjs/core) applications, a TypeScript web framework on Fastify. " +
        "Start with megh_project_info, megh_doctor and megh_project_structure to understand the project, " +
        "and megh_list_routes to see its HTTP API. Before writing Megh code, look up the API with " +
        "megh_search_docs and megh_read_doc rather than guessing. " +
        "Routes exposed to LLMs with @Tool() (@meghjs/ai) are listed, with safety warnings, by megh_list_ai_tools. " +
        (readOnly
          ? "This server is read-only: it cannot write files or change the database."
          : "Generate code with megh_make and the megh_scaffold_* tools, the way the megh CLI does, " +
            "and check it with megh_typecheck."),
    },
  );

  const ctx: ToolContext = {
    server,
    project: (cwd) => resolveProject(cwd, defaultRoot),
    docs: opts.docs ?? new Docs(),
    readOnly,
  };
  registerProjectTools(ctx);
  registerGenerateTools(ctx);
  registerDatabaseTools(ctx);
  registerDocs(ctx);
  registerPrompts(ctx);
  return server;
}
