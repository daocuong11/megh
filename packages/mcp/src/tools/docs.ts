import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { projectInfo, projectStructure } from "../megh";
import { safe, text } from "../result";
import type { ToolContext } from "./context";

const NO_DOCS = "The Megh docs are not bundled with this server build.";

/** Tools and resources for the bundled Megh documentation, plus project resources. */
export function registerDocs({ server, project, docs }: ToolContext): void {
  server.registerTool(
    "megh_search_docs",
    {
      title: "Search the Megh docs",
      description:
        "Search the Megh documentation (controllers, validation, DI, ORM, migrations, auth, queues, mail, CLI, ...) and return the best-matching pages with snippets. Read a page with megh_read_doc.",
      inputSchema: {
        query: z.string().min(1).describe("What to look for, e.g. 'validate request body' or 'belongsTo relation'."),
        limit: z.number().int().min(1).max(20).optional().describe("How many pages to return (default 5)."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(({ query, limit }) => {
      if (!docs.available) return text(NO_DOCS, true);
      const hits = docs.search(query, limit ?? 5);
      return text(hits.length ? hits : `No docs pages match "${query}". List them with megh_read_doc and no page.`);
    }),
  );

  server.registerTool(
    "megh_read_doc",
    {
      title: "Read a Megh docs page",
      description:
        "Read a page of the Megh documentation as markdown, by path, e.g. core-concept/controller or cli/generators. Without a page, list every page with its title and description.",
      inputSchema: {
        page: z.string().optional().describe("Page path, e.g. advanced/orm. Omit to list the pages."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(({ page }) => {
      if (!docs.available) return text(NO_DOCS, true);
      if (!page) return text(docs.list());
      const body = docs.read(page);
      return body ? text(body) : text(`No docs page "${page}". Call megh_read_doc without a page to list them.`, true);
    }),
  );

  if (docs.available) {
    server.registerResource(
      "megh-docs",
      new ResourceTemplate("megh://docs/{+page}", {
        list: () => ({
          resources: docs.list().map((p) => ({
            uri: `megh://docs/${p.path}`,
            name: p.path,
            title: p.title,
            description: p.description || undefined,
            mimeType: "text/markdown",
          })),
        }),
      }),
      { title: "Megh docs", description: "Pages of the Megh documentation.", mimeType: "text/markdown" },
      (uri, { page }) => {
        const body = docs.read(String(page));
        if (!body) throw new Error(`No docs page ${uri.href}`);
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: body }] };
      },
    );
  }

  const json = (uri: URL, value: unknown) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
  });

  server.registerResource(
    "megh-project",
    "megh://project/info",
    { title: "Project info", description: "The server's Megh project: dependencies, scripts and settings.", mimeType: "application/json" },
    (uri) => json(uri, projectInfo(project())),
  );

  server.registerResource(
    "megh-structure",
    "megh://project/structure",
    { title: "Project structure", description: "The server's project source files, grouped by kind.", mimeType: "application/json" },
    (uri) => json(uri, projectStructure(project())),
  );
}
