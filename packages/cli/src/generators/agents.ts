import fs from "fs";
import path from "path";
import { CliError } from "../errors";
import { log } from "../utils/log";
import { requireProjectRoot } from "../utils/project";

/** What AGENTS.md describes about a project. */
export type AgentsProfile = {
  name: string;
  pm: "npm" | "yarn" | "pnpm";
  /** Minimal app: one functional route, no controllers or tests. */
  minimal: boolean;
  /** Server-rendered views in views/. */
  mvc: boolean;
  /** MeghORM with migrations in src/database/migrations. */
  orm: boolean;
  /** @meghjs/ai is installed. */
  ai: boolean;
};

/** Claude Code reads CLAUDE.md; it imports AGENTS.md so both stay one file. */
export const CLAUDE_MD = "@AGENTS.md\n";

const run = (pm: AgentsProfile["pm"], script: string) => (pm === "npm" ? `npm run ${script}` : `${pm} ${script}`);
const test = (pm: AgentsProfile["pm"]) => (pm === "npm" ? "npm test" : `${pm} test`);

/**
 * AGENTS.md for a Megh app: the commands to run, where things go, and the
 * Megh rules an agent can't learn from TypeScript errors.
 */
export function renderAgentsMd(p: AgentsProfile): string {
  const out: string[] = [];
  const line = (s = "") => out.push(s);

  line(`# ${p.name}`);
  line();
  line(
    "A [Megh](https://meghjs.github.io) app: a TypeScript web framework on Fastify with decorator routing, " +
      "dependency injection, validation and OpenAPI. Megh versions are in `package.json`.",
  );
  line();
  line("## Commands");
  line();
  line("| Task | Command |");
  line("|---|---|");
  line(`| Dev server, reloads on change | \`${run(p.pm, "start:dev")}\` |`);
  line("| Type-check | `npx tsc --noEmit` |");
  if (!p.minimal) {
    line(`| Unit tests (\`*.spec.ts\`) | \`${test(p.pm)}\` |`);
    line(`| End-to-end tests | \`${run(p.pm, "test:e2e")}\` |`);
  }
  line(`| Build | \`${run(p.pm, "build")}\` |`);
  line("| Check the setup (Node, decorators, reflect-metadata) | `npx megh doctor` |");
  line("| List routes, with auth | `npx megh route:list` |");
  if (p.orm) {
    line("| New migration | `npx megh make:migration create_posts_table` |");
    line("| Run migrations (and seeders) | `npx megh migrate` (`--seed`) |");
    line("| Migration status | `npx megh migrate:status` |");
  }
  line();
  line(
    "Generate code instead of writing it by hand, so it follows Megh's conventions: " +
      "`npx megh make:controller`, `make:service`, `make:dto`, `make:middleware`, `make:config`, " +
      "`make:event`, `make:listener`, `make:queue`, `make:task`, `make:mail`" +
      (p.orm ? ", `make:model`, `make:resource` (DTOs, service and controller for a model), `make:seeder`, `make:factory`" : "") +
      (p.mvc ? ", `make:view`" : "") +
      (p.minimal ? "" : ", `make:test`") +
      ". `npx megh --help` lists them all.",
  );
  line();
  line("## Layout");
  line();
  if (p.minimal) {
    line("- `src/app.ts`: the app and its routes. `src/serve.ts`: the entry point.");
  } else {
    line("- `src/app.ts`: creates the app and registers everything (`app.useX(...)`). `src/serve.ts`: the entry point.");
    line("- `src/controllers/*.controller.ts`: routes. `src/services/*.service.ts`: business logic.");
    line("- `src/dtos/*.dto.ts`: request bodies and queries. `src/config/*.config.ts`: typed settings from `.env`.");
    if (p.orm) line("- `src/models/`, `src/database/migrations/`, `src/database/seeders/`: MeghORM models and schema.");
    if (p.mvc) line("- `views/**/*.megh.html`: server-rendered views, returned with `Results.View('pages.home', data)`.");
    line("- Tests sit next to the code: `home.controller.spec.ts` beside `home.controller.ts`.");
  }
  line("- `megh-env.d.ts`: types added by Megh plugins. Don't edit it.");
  line();
  line("## Megh rules TypeScript won't catch");
  line();
  line("These compile cleanly and fail at runtime:");
  line();
  if (!p.minimal) {
    line(
      "- **Register new controllers.** `make:controller` and `make:resource` don't edit `src/app.ts`: " +
        "add the class to `app.useControllers([...])`, or its routes don't exist.",
    );
  }
  line(
    "- **Every DTO property needs a validation decorator** (`@IsString()`, `@IsInt()`, `@IsOptional()`, ...). " +
      "Unknown properties are rejected with 400, so a field with no decorator fails every request that sends it. " +
      "Import the decorators from `@meghjs/core`, not `class-validator`.",
  );
  line("- **Route params must match the path:** `@Param('id')` needs `:id` in the route's path.");
  line(
    "- **Inject classes, not interfaces or type aliases.** Constructor injection reads the parameter's runtime type; " +
      "an interface becomes `Object` and injection fails. Use a `Token` for non-class values.",
  );
  line(
    "- **`@Authorized()` needs `app.useAuthorization(...)`,** or every request to the route gets 403. " +
      "A named `@Authorized('admin')` needs that name in `useAuthorization({ admin: ... })`.",
  );
  line("- **Call every `app.useX()` before `app.run()`.**");
  line(
    "- **Keep `experimentalDecorators` and `emitDecoratorMetadata` on** in `tsconfig.json`, and `reflect-metadata` installed. " +
      "`npx megh doctor` checks both.",
  );
  line("- **Read settings through `@AppConfig` classes** and add new keys to `.env` (never commit secrets).");
  if (p.ai) {
    line(
      "- **`@Tool()` routes are callable by LLMs** (`@meghjs/ai`), with the caller's rights. Give a tool that changes data " +
        "`@Authorized()` and `@Tool({ confirm: true })`. `npx megh route:list` shows the TOOL column.",
    );
  }
  line();
  line("## Before you finish");
  line();
  line(`1. \`npx tsc --noEmit\` has no errors.`);
  if (!p.minimal) line(`2. \`${test(p.pm)}\` passes. Add or update the \`*.spec.ts\` next to code you changed.`);
  line(`${p.minimal ? 2 : 3}. \`npx megh route:list\` shows the routes you expect, protected the way you expect.`);
  line();
  line("## Docs");
  line();
  line(
    "Look up the API instead of guessing: https://meghjs.github.io (an index for agents: https://meghjs.github.io/llms.txt). " +
      "The Megh MCP server gives an assistant the docs for this version, the project's routes and the generators: " +
      "`claude mcp add megh -- npx -y @meghjs/mcp`.",
  );
  return out.join("\n") + "\n";
}

/** Work out the profile of an existing project from its files. */
export function detectProfile(root: string): AgentsProfile {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const exists = (rel: string) => fs.existsSync(path.join(root, rel));
  return {
    name: pkg.name || path.basename(root),
    pm: exists("pnpm-lock.yaml") ? "pnpm" : exists("yarn.lock") ? "yarn" : "npm",
    minimal: !pkg.scripts?.test,
    mvc: exists("views"),
    orm: exists("src/database/migrations"),
    ai: "@meghjs/ai" in deps,
  };
}

export type MakeAgentsOptions = { cwd?: string; force?: boolean };

/**
 * `megh make:agents`: write AGENTS.md, and a CLAUDE.md that imports it.
 * Existing files are kept unless `force`; a CLAUDE.md of the user's own is
 * never replaced, only reported.
 */
export function makeAgents(opts: MakeAgentsOptions = {}): string[] {
  const root = requireProjectRoot(opts.cwd ?? process.cwd());
  const written: string[] = [];
  const agents = path.join(root, "AGENTS.md");
  if (fs.existsSync(agents) && !opts.force) {
    throw new CliError("AGENTS.md already exists. Use --force to replace it.");
  }
  fs.writeFileSync(agents, renderAgentsMd(detectProfile(root)), "utf8");
  written.push("AGENTS.md");
  log.step("AGENTS.md", "");

  const claude = path.join(root, "CLAUDE.md");
  if (!fs.existsSync(claude)) {
    fs.writeFileSync(claude, CLAUDE_MD, "utf8");
    written.push("CLAUDE.md");
    log.step("CLAUDE.md", "");
  } else if (!/^@AGENTS\.md\s*$/m.test(fs.readFileSync(claude, "utf8"))) {
    log.info("  CLAUDE.md exists and doesn't import AGENTS.md: add a line `@AGENTS.md` to it so Claude Code reads it.");
  }
  return written;
}
