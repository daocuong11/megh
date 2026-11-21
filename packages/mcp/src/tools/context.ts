import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Docs } from "../docs";

/** What each group of tools is given when it registers. */
export type ToolContext = {
  server: McpServer;
  /** Resolve a tool's `cwd` argument to a project root. */
  project: (cwd?: string) => string;
  docs: Docs;
  /** When true, tools that write files or change the database are not registered. */
  readOnly: boolean;
};
