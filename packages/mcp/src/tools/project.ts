import fs from "fs";
import path from "path";
import { runChecks } from "@meghjs/cli";
import { z } from "zod";
import { projectInfo, projectStructure, runMegh, runNode, tscBin } from "../megh";
import { cwdArg, fromCli, jsonFromCli, safe, text } from "../result";
import type { ToolContext } from "./context";

/** Tools that read the project or check it compiles. None of them change source files. */
export function registerProjectTools({ server, project, readOnly }: ToolContext): void {
  server.registerTool(
    "megh_project_info",
    {
      title: "Project info",
      description:
        "Show the Megh project's root, its @meghjs/* dependencies (declared and installed), npm scripts, `megh` settings from package.json and whether it runs in production.",
      inputSchema: { cwd: cwdArg },
      annotations: { readOnlyHint: true },
    },
    safe(({ cwd }) => text(projectInfo(project(cwd)))),
  );

  server.registerTool(
    "megh_project_structure",
    {
      title: "Project structure",
      description:
        "List the project's source files grouped by kind (controllers, services, models, dtos, migrations, seeders, middlewares, events, queues, tests, ...), with counts and the app's entry file.",
      inputSchema: { cwd: cwdArg },
      annotations: { readOnlyHint: true },
    },
    safe(({ cwd }) => text(projectStructure(project(cwd)))),
  );

  server.registerTool(
    "megh_doctor",
    {
      title: "Doctor",
      description:
        "Check the project's setup: Node.js version, @meghjs/core, reflect-metadata and the TypeScript decorator settings. Each check is ok, warn or fail.",
      inputSchema: { cwd: cwdArg },
      annotations: { readOnlyHint: true },
    },
    safe(({ cwd }) => text(runChecks(project(cwd)))),
  );

  server.registerTool(
    "megh_list_routes",
    {
      title: "List routes",
      description:
        "List the app's HTTP routes (method, path, controller, handler, file). By default the sources are compiled and each *.controller.ts is loaded to read its route metadata, which needs @meghjs/core installed; set static to scan the decorators in the source instead.",
      inputSchema: {
        cwd: cwdArg,
        static: z
          .boolean()
          .optional()
          .describe("Scan @ApiController/@Get/... decorators without running code (only string-literal paths)."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ cwd, static: isStatic }) =>
      jsonFromCli(await runMegh(project(cwd), ["route:list", "--json", ...(isStatic ? ["--static"] : [])])),
    ),
  );

  server.registerTool(
    "megh_list_templates",
    {
      title: "List model templates",
      description:
        "List the model templates by domain (e.g. ecommerce/product). Give a domain to see each template's columns. Use them with megh_make (kind model or resource) or megh_scaffold_domain.",
      inputSchema: {
        cwd: cwdArg,
        domain: z.string().optional().describe("Show only this domain, with each template's columns."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ cwd, domain }) =>
      jsonFromCli(await runMegh(project(cwd), ["template:list", ...(domain ? [domain] : []), "--json"])),
    ),
  );

  server.registerTool(
    "megh_typecheck",
    {
      title: "Type-check",
      description:
        "Run the project's TypeScript compiler without emitting (tsc --noEmit) and return the errors. Use it after changing code to check it still compiles.",
      inputSchema: {
        cwd: cwdArg,
        project: z.string().optional().describe("tsconfig to use, relative to the project. Defaults to tsconfig.json."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ cwd, project: tsconfig }) => {
      const root = project(cwd);
      const config = tsconfig ?? "tsconfig.json";
      if (!fs.existsSync(path.join(root, config))) return text(`No ${config} in ${root}.`, true);
      const r = await runNode(root, tscBin(root), ["--noEmit", "--pretty", "false", "-p", config]);
      if (r.exitCode === 0) return text("No type errors.");
      const errors = r.stdout.split(/\r?\n/).filter((l) => /error TS\d+/.test(l)).length;
      return text(`${errors} type error(s):\n\n${r.stdout.trim()}${r.stderr ? `\n\n${r.stderr.trim()}` : ""}`, true);
    }),
  );

  if (readOnly) return;

  server.registerTool(
    "megh_build",
    {
      title: "Build",
      description:
        "Run megh build: compile with tsc (tsconfig.build.json, else tsconfig.json) into the output folder and copy assets. Writes build output only, not sources.",
      inputSchema: {
        cwd: cwdArg,
        project: z.string().optional().describe("tsconfig to use instead of the default."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    safe(async ({ cwd, project: tsconfig }) =>
      fromCli(await runMegh(project(cwd), ["build", ...(tsconfig ? ["--project", tsconfig] : [])])),
    ),
  );
}
