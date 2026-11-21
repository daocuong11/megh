import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { findProjectRoot } from "@meghjs/cli";

export type CliResult = { exitCode: number; stdout: string; stderr: string };

/** How long one CLI call may run before it is killed. */
const TIMEOUT_MS = 300_000;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Resolve the project a tool works on: the given directory, else the server's
 * default (`MEGH_PROJECT_ROOT` or the directory it was started in). Walks up
 * to the nearest `package.json`, like the CLI does.
 */
export function resolveProject(cwd: string | undefined, fallback: string): string {
  const start = path.resolve(fallback, cwd ?? ".");
  const root = findProjectRoot(start);
  if (!root) throw new Error(`No package.json found in ${start} or any parent directory.`);
  return root;
}

/** Resolve `<pkg>/<file>` from the project first, then from this package. */
function resolveFrom(root: string, pkg: string, file: string): string | null {
  for (const paths of [[root], [__dirname]]) {
    try {
      const pkgJson = require.resolve(`${pkg}/package.json`, { paths });
      const target = path.join(path.dirname(pkgJson), file);
      if (fs.existsSync(target)) return target;
    } catch {
      // not installed there; try the next location
    }
  }
  return null;
}

/**
 * The `megh` executable to run. Prefers the CLI installed in the project, so
 * its version matches the project's `@meghjs/core`, and falls back to the one
 * this package depends on.
 */
export function cliBin(root: string): string {
  const bin = resolveFrom(root, "@meghjs/cli", path.join("dist", "bin.js"));
  if (!bin) throw new Error("Could not find @meghjs/cli. Install it in the project: npm i -D @meghjs/cli");
  return bin;
}

/** The project's TypeScript compiler (`typescript/bin/tsc`). */
export function tscBin(root: string): string {
  const bin = resolveFrom(root, "typescript", path.join("bin", "tsc"));
  if (!bin) throw new Error("Could not find typescript. Install it in the project: npm i -D typescript");
  return bin;
}

/**
 * Run a Node.js script in `root` and capture its output. It runs in its own
 * process: its console output must not reach the server's stdout, which
 * carries the MCP protocol. stdin is closed so a prompt cannot hang the call.
 */
export function runNode(root: string, script: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TIMEOUT_MS,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) stderr += `\n${path.basename(script)} was stopped (${signal}) after ${TIMEOUT_MS / 1000}s.`;
      resolve({ exitCode: code ?? 1, stdout: stdout.replace(ANSI, ""), stderr: stderr.replace(ANSI, "") });
    });
  });
}

/** Run `megh <args>` in `root`. */
export function runMegh(root: string, args: string[]): Promise<CliResult> {
  return runNode(root, cliBin(root), args);
}

/** Parse JSON a command printed with `--json`, ignoring any lines logged before it. */
export function parseJsonOutput(stdout: string): unknown {
  const start = stdout.search(/^[[{]/m);
  if (start < 0) throw new Error(`Expected JSON output, got:\n${stdout}`);
  return JSON.parse(stdout.slice(start));
}

/**
 * Whether the project runs with `NODE_ENV=production`, from the server's
 * environment or the project's `.env` (which the CLI also loads).
 */
export function isProduction(root: string): boolean {
  if (process.env.NODE_ENV) return process.env.NODE_ENV === "production";
  const envFile = path.join(root, ".env");
  if (!fs.existsSync(envFile)) return false;
  const line = fs
    .readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .find((l) => /^\s*NODE_ENV\s*=/.test(l));
  return !!line && line.split("=")[1].trim().replace(/^["']|["']$/g, "") === "production";
}

export function readPackageJson(root: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
}

/** The `@meghjs/*` packages a project depends on and the `megh` settings in its package.json. */
export function projectInfo(root: string) {
  const pkg = readPackageJson(root);
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
  const megh = Object.fromEntries(Object.entries(deps).filter(([name]) => name.startsWith("@meghjs/")));
  const installed: Record<string, string | null> = {};
  for (const name of Object.keys(megh)) {
    try {
      const file = require.resolve(`${name}/package.json`, { paths: [root] });
      installed[name] = JSON.parse(fs.readFileSync(file, "utf8")).version ?? null;
    } catch {
      installed[name] = null;
    }
  }
  return {
    root,
    name: pkg.name ?? null,
    version: pkg.version ?? null,
    isMeghProject: "@meghjs/core" in deps,
    meghDependencies: megh,
    installedVersions: installed,
    scripts: pkg.scripts ?? {},
    meghConfig: pkg.megh ?? null,
    hasEnvFile: fs.existsSync(path.join(root, ".env")),
    production: isProduction(root),
  };
}

/**
 * File suffixes the `megh` generators write, by kind. Migrations are matched
 * by folder instead, since their names are `<timestamp>_<name>.ts`.
 */
const KINDS: [kind: string, suffix: string][] = [
  ["controllers", ".controller.ts"],
  ["services", ".service.ts"],
  ["models", ".model.ts"],
  ["dtos", ".dto.ts"],
  ["configs", ".config.ts"],
  ["middlewares", ".middleware.ts"],
  ["mails", ".mail.ts"],
  ["events", ".event.ts"],
  ["listeners", ".listener.ts"],
  ["queues", ".queue.ts"],
  ["workers", ".worker.ts"],
  ["tasks", ".task.ts"],
  ["seeders", ".seeder.ts"],
  ["factories", ".factory.ts"],
  ["tests", ".spec.ts"],
  ["tests", ".test.ts"],
];

/** The project's source files grouped by what they are (controllers, models, ...). */
export function projectStructure(root: string) {
  const src = path.join(root, "src");
  const groups: Record<string, string[]> = {};
  const add = (kind: string, file: string) => (groups[kind] ??= []).push(file);
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(root, full).split(path.sep).join("/");
      const kind = KINDS.find(([, suffix]) => e.name.endsWith(suffix))?.[0];
      if (kind) add(kind, rel);
      else if (/\/database\/migrations\//.test(`/${rel}`)) add("migrations", rel);
      else add("other", rel);
    }
  };
  walk(src);
  walk(path.join(root, "tests"));
  for (const files of Object.values(groups)) files.sort();
  const entry = ["src/app.ts", "src/main.ts", "src/server.ts", "src/index.ts"].find((f) =>
    fs.existsSync(path.join(root, f)),
  );
  return { root, entry: entry ?? null, counts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])), files: groups };
}
