import fs from "fs";
import path from "path";
import { c, icon } from "./log";

/**
 * Review of the files a command writes. While a review is open, every write
 * through `trackWrite` first saves what the file held (or that it didn't
 * exist), so the command's changes can be shown as a diff, confirmed, and
 * undone if the user says no.
 */

type Snapshot = {
  file: string;
  /** The file's content before the command, or `null` if it is new. */
  before: string | null;
  /** Folders the write created, deepest first, removed again on undo. */
  createdDirs: string[];
};

let open: Snapshot[] | null = null;

/** Call before writing `file`: records its current state when a review is open. */
export function trackWrite(file: string): void {
  if (!open) return;
  const abs = path.resolve(file);
  if (open.some((s) => s.file === abs)) return;
  const createdDirs: string[] = [];
  for (
    let dir = path.dirname(abs);
    !fs.existsSync(dir);
    dir = path.dirname(dir)
  )
    createdDirs.push(dir);
  open.push({
    file: abs,
    before: fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null,
    createdDirs,
  });
}

/** Put every recorded file back the way it was. */
function undo(snapshots: Snapshot[]) {
  for (const s of [...snapshots].reverse()) {
    if (s.before === null) fs.rmSync(s.file, { force: true });
    else fs.writeFileSync(s.file, s.before, "utf8");
    for (const dir of s.createdDirs) {
      try {
        fs.rmdirSync(dir); // only succeeds when empty
      } catch {
        break;
      }
    }
  }
}

export type ReviewOptions = {
  projectRoot: string;
  /** Apply without asking. */
  yes?: boolean;
  /** Show the changes, then undo them. */
  dryRun?: boolean;
  /**
   * Ask the user; resolves to true to keep the changes. Defaults to an
   * interactive prompt when stdin and stdout are a terminal; otherwise the
   * changes are kept (scripts and CI).
   */
  confirm?: (message: string) => Promise<boolean>;
  /** Hold the command's own output until the changes are confirmed. */
  quiet?: boolean;
};

/**
 * Run `command`, then, if it changed files that already existed, show what
 * changed and which files it can affect, and ask before keeping it. New files
 * alone are kept without asking: nothing that was there is lost.
 */
export async function withReview<T>(
  command: () => T | Promise<T>,
  opts: ReviewOptions,
): Promise<T | undefined> {
  if (open) return command(); // already inside a review
  const snapshots: Snapshot[] = [];
  open = snapshots;
  const held: Array<() => void> = [];
  const restore = opts.quiet ? holdConsole(held) : () => {};
  let result: T;
  try {
    result = await command();
  } catch (err) {
    restore();
    open = null;
    held.forEach((print) => print());
    undo(snapshots);
    throw err;
  }
  restore();
  open = null;

  const changed = snapshots.filter(
    (s) => s.before !== null && s.before !== read(s.file),
  );
  if (opts.dryRun) {
    printReview(snapshots, opts.projectRoot);
    undo(snapshots);
    console.log(c.dim("\nDry run: nothing was written."));
    return result;
  }
  if (changed.length === 0) {
    held.forEach((print) => print());
    return result;
  }

  printReview(snapshots, opts.projectRoot);
  const ask = opts.yes
    ? undefined
    : (opts.confirm ?? (interactive() ? promptConfirm : undefined));
  if (
    ask &&
    !(await ask(
      `Apply these changes to ${count(changed.length, "existing file")}?`,
    ))
  ) {
    undo(snapshots);
    console.log(`${icon.error} Cancelled: nothing was changed.`);
    return undefined;
  }
  held.forEach((print) => print());
  return result;
}

function interactive() {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function promptConfirm(message: string): Promise<boolean> {
  const { default: inquirer } = await import("inquirer");
  const { ok } = await inquirer.prompt([
    { type: "confirm", name: "ok", message, default: false },
  ]);
  return ok;
}

/** Buffer console output into `held` until the returned function is called. */
function holdConsole(held: Array<() => void>): () => void {
  const saved = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  for (const key of Object.keys(saved) as (keyof typeof saved)[]) {
    console[key] = (...args: unknown[]) => held.push(() => saved[key](...args));
  }
  return () => Object.assign(console, saved);
}

function read(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function printReview(snapshots: Snapshot[], projectRoot: string) {
  const rel = (f: string) =>
    path.relative(projectRoot, f).split(path.sep).join("/");
  const created = snapshots.filter(
    (s) => s.before === null && fs.existsSync(s.file),
  );
  const changed = snapshots.filter(
    (s) => s.before !== null && s.before !== read(s.file),
  );

  console.log(`\n${c.bold("Changes")}`);
  for (const s of created)
    console.log(`  ${c.green("+ new")}      ${rel(s.file)}`);
  for (const s of changed)
    console.log(`  ${c.yellow("~ changed")}  ${rel(s.file)}`);

  for (const s of changed) {
    const after = read(s.file)!;
    console.log(`\n${c.bold(rel(s.file))}`);
    console.log(renderDiff(s.before!, after));
    const affects = impact(
      s.file,
      s.before!,
      after,
      projectRoot,
      new Set(snapshots.map((x) => x.file)),
    );
    if (affects.length) {
      console.log(c.bold("  Can affect:"));
      for (const line of affects) console.log(`    ${line}`);
    }
  }
  console.log();
}

// ── Diff ─────────────────────────────────────────────────────────────────────

type Op = { kind: " " | "+" | "-"; text: string };

/** Line diff (longest common subsequence). Files here are small. */
export function diffLines(before: string, after: string): Op[] {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i++] });
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j]))
      ops.push({ kind: "+", text: b[j++] });
    else ops.push({ kind: "-", text: a[i++] });
  }
  return ops;
}

const CONTEXT = 2;
const MAX_LINES = 120;

/** The changed lines with a little context, in the style of `git diff`. */
export function renderDiff(before: string, after: string): string {
  const ops = diffLines(before, after);
  const keep = new Set<number>();
  ops.forEach((op, i) => {
    if (op.kind === " ") return;
    for (
      let k = Math.max(0, i - CONTEXT);
      k <= Math.min(ops.length - 1, i + CONTEXT);
      k++
    )
      keep.add(k);
  });
  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((x, y) => x - y)) {
    if (last !== -1 && i > last + 1) out.push(c.dim("  ..."));
    const op = ops[i];
    const line = `  ${op.kind} ${op.text}`;
    out.push(
      op.kind === "+"
        ? c.green(line)
        : op.kind === "-"
          ? c.red(line)
          : c.dim(line),
    );
    last = i;
  }
  if (out.length > MAX_LINES) {
    const more = out.length - MAX_LINES;
    out.length = MAX_LINES;
    out.push(c.dim(`  ... ${more} more lines`));
  }
  return out.join("\n");
}

// ── Impact ───────────────────────────────────────────────────────────────────

/** Class members (properties and methods) declared at the class body's indent. */
export function members(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const m = line.match(
      /^ {2}(?:(?:public|private|protected|static|readonly|declare|async|override)\s+)*(\w+)\s*([!?]?\s*:[^=;]*|\()/,
    );
    if (m && m[1] !== "constructor")
      out.set(
        m[1],
        m[2].startsWith("(")
          ? "method"
          : m[2].replace(/^[!?]?\s*:\s*/, "").trim(),
      );
  }
  return out;
}

/**
 * Files that import `file`, and where they use a member that the change
 * removes or retypes.
 */
export function impact(
  file: string,
  before: string,
  after: string,
  projectRoot: string,
  skip = new Set<string>(),
): string[] {
  const rel = (f: string) =>
    path.relative(projectRoot, f).split(path.sep).join("/");
  const old = members(before);
  const now = members(after);
  const removed = [...old.keys()].filter((k) => !now.has(k));
  const retyped = [...old.keys()].filter(
    (k) => now.has(k) && old.get(k) !== now.get(k) && old.get(k) !== "method",
  );

  const lines: string[] = [];
  for (const importer of importersOf(file, projectRoot)) {
    if (skip.has(importer)) continue;
    const source = fs.readFileSync(importer, "utf8").split(/\r?\n/);
    const uses: string[] = [];
    source.forEach((text, i) => {
      for (const name of removed) {
        if (new RegExp(`\\.${name}\\b`).test(text))
          uses.push(`line ${i + 1} uses .${name}, which is removed`);
      }
      for (const name of retyped) {
        if (new RegExp(`\\.${name}\\b`).test(text)) {
          uses.push(
            `line ${i + 1} uses .${name}, now ${now.get(name)} (was ${old.get(name)})`,
          );
        }
      }
    });
    lines.push(`${rel(importer)} imports it`);
    for (const use of uses) lines.push(c.yellow(`  ${use}`));
  }
  return lines;
}

/** TypeScript files under src/ and tests/ with a relative import that resolves to `file`. */
export function importersOf(file: string, projectRoot: string): string[] {
  const target = path.resolve(file).replace(/\.ts$/, "");
  const out: string[] = [];
  for (const dir of ["src", "tests", "test"]) {
    const root = path.join(projectRoot, dir);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, {
      recursive: true,
      encoding: "utf8",
    }) as string[]) {
      if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
      const from = path.join(root, entry);
      if (path.resolve(from) === path.resolve(file)) continue;
      const source = fs.readFileSync(from, "utf8");
      for (const m of source.matchAll(
        /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g,
      )) {
        const resolved = path
          .resolve(path.dirname(from), m[1])
          .replace(/\.(ts|js)$/, "");
        if (resolved === target || path.join(resolved, "index") === target) {
          out.push(from);
          break;
        }
      }
    }
  }
  return out.sort();
}
