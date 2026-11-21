import { z } from "zod";
import { isProduction, runMegh } from "../megh";
import { cwdArg, fromCli, jsonFromCli, safe, text, type ToolResult } from "../result";
import type { ToolContext } from "./context";

const CONNECTS =
  "Connects like app.useMeghORM() does, from DATABASE_URL (or DB_*) in the environment or .env.";

/**
 * Database tools. Reading the migration status is always available; running
 * migrations, rolling back and seeding are not registered in read-only mode
 * and refuse to run against a production project. `migrate:reset` and
 * `migrate:refresh` are left out: they drop every table.
 */
export function registerDatabaseTools({ server, project, readOnly }: ToolContext): void {
  server.registerTool(
    "megh_migrate_status",
    {
      title: "Migration status",
      description: `Show which database migrations have run. ${CONNECTS}`,
      inputSchema: { cwd: cwdArg },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ cwd }) => jsonFromCli(await runMegh(project(cwd), ["migrate:status", "--json"]))),
  );

  if (readOnly) return;

  /** Run a command that changes the database, unless the project runs in production. */
  const changeDb = async (cwd: string | undefined, args: string[]): Promise<ToolResult> => {
    const root = project(cwd);
    if (isProduction(root)) {
      return text(
        `Refusing to run megh ${args[0]}: NODE_ENV is production for ${root}. Run it yourself if you mean to change that database.`,
        true,
      );
    }
    return fromCli(await runMegh(root, args));
  };

  server.registerTool(
    "megh_migrate",
    {
      title: "Run migrations",
      description: `Run the pending migrations (megh migrate), optionally followed by the seeders. ${CONNECTS} Refused when NODE_ENV is production.`,
      inputSchema: {
        cwd: cwdArg,
        seed: z.boolean().optional().describe("Run the seeders afterwards."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    safe(({ cwd, seed }) => changeDb(cwd, ["migrate", ...(seed ? ["--seed"] : [])])),
  );

  server.registerTool(
    "megh_migrate_rollback",
    {
      title: "Roll back migrations",
      description: `Undo the last migration, or the last \`step\` migrations (megh migrate:rollback). This can drop tables and their data. ${CONNECTS} Refused when NODE_ENV is production.`,
      inputSchema: {
        cwd: cwdArg,
        step: z.number().int().min(1).optional().describe("How many migrations to undo (default 1)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    safe(({ cwd, step }) => changeDb(cwd, ["migrate:rollback", ...(step ? ["--step", String(step)] : [])])),
  );

  server.registerTool(
    "megh_db_seed",
    {
      title: "Seed the database",
      description: `Run the seeders (megh db:seed): database.seeder.ts, else every seeder in file order, or just one. A run is one transaction. ${CONNECTS} Refused when NODE_ENV is production.`,
      inputSchema: {
        cwd: cwdArg,
        seeder: z.string().optional().describe("Run only this seeder, e.g. users for users.seeder.ts."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    safe(({ cwd, seeder }) => changeDb(cwd, ["db:seed", ...(seeder ? ["--seeder", seeder] : [])])),
  );
}
