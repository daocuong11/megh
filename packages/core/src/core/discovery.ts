/**
 * Folder scanning for `useControllers({ auto: true })` and
 * `useScheduler({ path })`.
 */
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { isTypeScriptRuntime } from "../common/utils/path-utils";
import { internalLogger } from "../observability/internal-logger";

export interface ScanOptions {
  /** Import only files this returns true for (path relative to the folder). */
  include?: (file: string) => boolean;
  /** Called with the exported values of each imported file. */
  visit: (exports: unknown[]) => void;
}

const TEST_FILE = /\.(test|spec|e2e-spec)\.[cm]?[jt]s$/;
const SOURCE_FILE = /\.[cm]?ts$/;
const COMPILED_FILE = /\.[cm]?js$/;

/**
 * Import every module under `dir` and pass its exports to `visit`. Reads
 * `.ts` files when TypeScript runs directly (ts-node, tsx, ...) and `.js`
 * otherwise; test files and declaration files are skipped.
 *
 * A missing folder logs a warning that names it. A file that fails to import
 * fails the scan: skipping it would silently drop its routes or tasks.
 */
export async function scanModules(
  dir: string,
  kind: string,
  options: ScanOptions,
): Promise<void> {
  const ts = isTypeScriptRuntime();
  if (!fs.existsSync(dir)) {
    internalLogger("app").warn(
      { dir },
      `Could not auto-register ${kind}: ${dir} does not exist. ` +
        (ts
          ? "Check the path you passed."
          : "Megh reads the compiled output (tsconfig outDir) when not running TypeScript directly; " +
            "build the app first, or pass the folder explicitly."),
    );
    return;
  }

  const files = fs.readdirSync(dir, {
    recursive: true,
    encoding: "utf-8",
  }) as string[];
  const wanted = ts ? SOURCE_FILE : COMPILED_FILE;

  for (const file of files.sort()) {
    if (!wanted.test(file) || TEST_FILE.test(file)) continue;
    if (/\.d\.[cm]?ts$/.test(file)) continue;
    if (options.include && !options.include(file)) continue;
    const fullPath = path.join(dir, file);
    let module: Record<string, unknown>;
    try {
      module = await importFile(fullPath);
    } catch (err) {
      throw new Error(
        `[Megh] Could not load ${fullPath} while auto-registering ${kind}: ` +
          `${(err as Error)?.message ?? err}`,
        { cause: err },
      );
    }
    options.visit(Object.values(module));
  }
}

async function importFile(file: string): Promise<Record<string, unknown>> {
  // The CommonJS build compiles import() to require(), so require hooks
  // (ts-node, tsx) apply. Native ESM needs a file:// URL for .mjs on Windows.
  return /\.m[jt]s$/.test(file)
    ? import(pathToFileURL(file).href)
    : import(file);
}
