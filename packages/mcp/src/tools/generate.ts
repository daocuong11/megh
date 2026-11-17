import { z } from "zod";
import { runMegh } from "../megh";
import { cwdArg, fromCli, safe } from "../result";
import type { ToolContext } from "./context";

/** The `make:*` generators the `megh_make` tool can run. */
export const GENERATORS = [
  "model",
  "controller",
  "service",
  "resource",
  "dto",
  "config",
  "middleware",
  "mail",
  "event",
  "listener",
  "queue",
  "worker",
  "task",
  "migration",
  "seeder",
  "factory",
] as const;

/** Values `megh scaffold:auth --strategy` accepts. */
export const AUTH_STRATEGIES = ["jwt", "api-key", "both"] as const;

const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;

/** `--flag` when true, `--no-flag` when false, nothing when unset. */
const tri = (flag: string, value: boolean | undefined) => (value === undefined ? [] : [value ? `--${flag}` : `--no-${flag}`]);

/**
 * Tools that write source files through the megh generators. Every call passes
 * `--yes`: the CLI never prompts, and existing files are only replaced with `force`.
 */
export function registerGenerateTools({ server, project, readOnly }: ToolContext): void {
  if (readOnly) return;

  server.registerTool(
    "megh_make",
    {
      title: "Generate code",
      description:
        "Run a megh make:<kind> generator, e.g. kind=controller name=User writes src/controllers/user.controller.ts (admin/User writes src/admin/controllers/user.controller.ts). " +
        "resource writes a model's DTOs, CRUD service and controller. Files that exist are left alone unless force is set. " +
        "Returns the CLI output listing the files written.",
      inputSchema: {
        cwd: cwdArg,
        kind: z.enum(GENERATORS).describe("Which generator to run."),
        name: z.string().min(1).describe("Name, optionally nested, e.g. User, admin/User, create_users_table."),
        force: z.boolean().optional().describe("Overwrite files that already exist."),
        table: z
          .string()
          .optional()
          .describe("model, resource, migration: the table name (for migration, an alter-table migration)."),
        create: z.string().optional().describe("migration: generate a create-table migration for this table."),
        template: z
          .string()
          .optional()
          .describe("model, resource: create the table from a template, e.g. ecommerce/product (see megh_list_templates)."),
        fields: z
          .string()
          .optional()
          .describe('model, resource: columns to add, e.g. "title,price:money,status:in(draft|live),user_id:cascade".'),
        factory: z.boolean().optional().describe("model with template or fields: also write a factory."),
      },
      annotations: writes,
    },
    safe(async ({ cwd, kind, name, force, table, create, template, fields, factory }) => {
      const args = [`make:${kind}`, name, "--yes"];
      if (force) args.push("--force");
      if (table) args.push("--table", table);
      if (create) args.push("--create", create);
      if (template) args.push("--template", template);
      if (fields) args.push("--fields", fields);
      if (factory) args.push("--factory");
      return fromCli(await runMegh(project(cwd), args));
    }),
  );

  server.registerTool(
    "megh_sync_model",
    {
      title: "Sync model with migrations",
      description:
        "Run megh sync:model after an alter-table migration: adds new columns to the model, removes dropped ones and updates the ones still as make:model wrote them. Customized fields are kept and reported. Use dryRun to see the changes first.",
      inputSchema: {
        cwd: cwdArg,
        name: z.string().min(1).describe("Model name, optionally nested, e.g. User or admin/User."),
        table: z.string().optional().describe("Table to read (default: the model's @Table, else the plural snake_case name)."),
        dto: z.boolean().optional().describe("Also rewrite src/dtos/<name>.dto.ts from the updated columns."),
        dryRun: z.boolean().optional().describe("Show what would change without writing."),
      },
      annotations: writes,
    },
    safe(async ({ cwd, name, table, dto, dryRun }) => {
      const args = ["sync:model", name, "--yes"];
      if (table) args.push("--table", table);
      if (dto) args.push("--dto");
      if (dryRun) args.push("--dry-run");
      return fromCli(await runMegh(project(cwd), args));
    }),
  );

  server.registerTool(
    "megh_scaffold_domain",
    {
      title: "Scaffold a domain",
      description:
        "Run megh scaffold:domain: create the migrations (and models or REST resources) of a domain's templates, e.g. ecommerce, pos, medical. See megh_list_templates for the domains.",
      inputSchema: {
        cwd: cwdArg,
        domain: z.string().min(1).describe("Domain name, e.g. ecommerce."),
        only: z.array(z.string()).optional().describe("Only these templates, e.g. [product, order]. Default: every template."),
        mode: z
          .enum(["model", "resource", "migration"])
          .optional()
          .describe("model (default): migrations and models; resource: also DTOs, service and controller; migration: migrations only."),
        factory: z.boolean().optional().describe("Also write a factory for each model."),
        deps: z.boolean().optional().describe("Create the tables foreign keys point to (default true)."),
        force: z.boolean().optional().describe("Overwrite the generated models' files."),
      },
      annotations: writes,
    },
    safe(async ({ cwd, domain, only, mode, factory, deps, force }) => {
      const args = ["scaffold:domain", domain, "--yes"];
      if (only?.length) args.push("--only", only.join(","));
      else args.push("--all");
      if (mode === "resource") args.push("--resource");
      if (mode === "migration") args.push("--migrations-only");
      if (factory) args.push("--factory");
      if (deps === false) args.push("--no-deps");
      if (force) args.push("--force");
      return fromCli(await runMegh(project(cwd), args));
    }),
  );

  server.registerTool(
    "megh_scaffold_auth",
    {
      title: "Scaffold authentication",
      description:
        "Run megh scaffold:auth: add sign-up and sign-in. Writes the users table (and roles, permissions, api_keys as chosen) as migrations and models, src/auth/, an AuthService, DTOs and an AuthController (POST /auth/register, POST /auth/login, GET /auth/me), and registers them in src/app.ts.",
      inputSchema: {
        cwd: cwdArg,
        strategy: z.enum(AUTH_STRATEGIES).optional().describe("How clients sign in (default jwt)."),
        roles: z.enum(["none", "single", "multiple"]).optional().describe("Roles per user (default none)."),
        permissions: z.boolean().optional().describe("Whether roles grant permissions."),
        force: z.boolean().optional().describe("Overwrite the generated auth files."),
      },
      annotations: writes,
    },
    safe(async ({ cwd, strategy, roles, permissions, force }) => {
      const args = ["scaffold:auth", "--yes"];
      if (strategy) args.push("--strategy", strategy);
      if (roles) args.push("--roles", roles);
      args.push(...tri("permissions", permissions));
      if (force) args.push("--force");
      return fromCli(await runMegh(project(cwd), args));
    }),
  );

  server.registerTool(
    "megh_scaffold_rbac",
    {
      title: "Scaffold roles and permissions",
      description: "Run megh scaffold:rbac: add roles (one or many per user) and optionally permissions to an app that already has users.",
      inputSchema: {
        cwd: cwdArg,
        roles: z.enum(["single", "multiple"]).optional().describe("Roles per user (default multiple)."),
        permissions: z.boolean().optional().describe("Whether roles grant permissions."),
        force: z.boolean().optional().describe("Overwrite the generated files."),
      },
      annotations: writes,
    },
    safe(async ({ cwd, roles, permissions, force }) => {
      const args = ["scaffold:rbac", "--yes"];
      if (roles) args.push("--roles", roles);
      args.push(...tri("permissions", permissions));
      if (force) args.push("--force");
      return fromCli(await runMegh(project(cwd), args));
    }),
  );
}
