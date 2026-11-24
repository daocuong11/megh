import fs from "fs";
import path from "path";
import { runChecks } from "@meghjs/cli";
import { z } from "zod";
import { parseJsonOutput, projectInfo, projectStructure, runMegh, runNode, tscBin } from "../megh";
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
        "List the app's HTTP routes (method, path, controller, handler, file). By default the sources are compiled and each *.controller.ts is loaded to read its route metadata, which needs @meghjs/core installed; set static to scan the decorators in the source instead. Routes marked @Tool() (@meghjs/ai) have a tool field with the name the model sees.",
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
    "megh_list_ai_tools",
    {
      title: "List LLM tools",
      description:
        "List the routes exposed to LLMs with @Tool() from @meghjs/ai: tool name, description, method, path, auth and whether it needs a person's approval (confirm). " +
        "Each tool comes with warnings for risky setups, such as a tool that changes data without confirm or without authorization. Takes the same static option as megh_list_routes.",
      inputSchema: {
        cwd: cwdArg,
        static: z
          .boolean()
          .optional()
          .describe("Scan the decorators without running code (only string-literal names and descriptions)."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ cwd, static: isStatic }) => {
      const r = await runMegh(project(cwd), ["route:list", "--json", ...(isStatic ? ["--static"] : [])]);
      if (r.exitCode !== 0) return fromCli(r);
      const routes = parseJsonOutput(r.stdout) as RouteWithTool[];
      const tools = routes.filter((route) => route.tool).map(describeTool);
      return text(
        tools.length
          ? tools
          : "No @Tool routes. Install @meghjs/ai and mark routes with @Tool({ description }) to expose them to LLMs.",
      );
    }),
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

type RouteWithTool = {
  method: string;
  path: string;
  controller: string;
  handler: string;
  file: string;
  auth: string;
  tool?: { name: string; description?: string; confirm: boolean };
};

/** A tool from `route:list`, with warnings an assistant should raise. */
export function describeTool(route: RouteWithTool) {
  const tool = route.tool!;
  const mutating = route.method !== "GET";
  const warnings: string[] = [];
  if (mutating && !tool.confirm)
    warnings.push("Changes data but runs without a person's approval; consider @Tool({ confirm: true }).");
  if (mutating && route.auth === "public")
    warnings.push("Changes data and is @Public(): anyone who can call the tools can run it, signed in or not.");
  if (mutating && route.auth === "default")
    warnings.push(
      "Changes data and has no @Authorized(); it is protected only if the app sets useAuthorization(handler, { default }).",
    );
  if (tool.description !== undefined && tool.description.trim().length < 20)
    warnings.push("Short description: say what the tool does, when to use it and what it returns.");
  return {
    name: tool.name,
    ...(tool.description !== undefined && { description: tool.description }),
    method: route.method,
    path: route.path,
    handler: `${route.controller}.${route.handler}`,
    file: route.file,
    auth: route.auth,
    confirm: tool.confirm,
    warnings,
  };
}
