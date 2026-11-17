/**
 * Library entry for `@meghjs/mcp`. Importing it has no side effects; the
 * stdio executable lives in `bin.ts`.
 */
export { createServer, GENERATORS } from "./server";
export type { ServerOptions } from "./server";
export { Docs, findDocsDir } from "./docs";
export type { DocPage, DocHit } from "./docs";
export { runMegh, runNode, resolveProject, projectInfo, projectStructure, isProduction, cliBin, tscBin } from "./megh";
export type { CliResult } from "./megh";
