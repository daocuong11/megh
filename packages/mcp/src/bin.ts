#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server";
import { version } from "./version";

const USAGE = `Usage: megh-mcp [project-dir] [--read-only]

Serve the Megh tools over stdio for an MCP client.

  project-dir   The Megh project (default: MEGH_PROJECT_ROOT, else the current directory)
  --read-only   Leave out the tools that write files or change the database
                (or set MEGH_MCP_READ_ONLY=1)
  -v, --version Print the version
  -h, --help    Show this help`;

/** stdout carries the protocol, so anything else must go to stderr. */
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) return void console.error(USAGE);
  if (args.includes("-v") || args.includes("--version")) return void console.error(version);

  const unknown = args.find((a) => a.startsWith("-") && a !== "--read-only");
  if (unknown) {
    console.error(`Unknown option ${unknown}\n\n${USAGE}`);
    process.exit(1);
  }
  const projectRoot = args.find((a) => !a.startsWith("-")) ?? process.env.MEGH_PROJECT_ROOT;
  const readOnly = args.includes("--read-only") || process.env.MEGH_MCP_READ_ONLY === "1";

  const server = createServer({ projectRoot, version, readOnly });
  await server.connect(new StdioServerTransport());
  console.error(`megh-mcp ${version} ready (project: ${projectRoot ?? process.cwd()}${readOnly ? ", read-only" : ""})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
