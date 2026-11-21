import os from "os";
import { c } from "./log";
import { findProjectRoot, installedVersion } from "./project";
import { cliVersion } from "./stubs";

/**
 * The "Megh CLI" logo. Kept as strings, not a template literal, because the
 * art has a backtick in it.
 */
const LOGO = [
  "  __  __            _        ____ _     ___",
  " |  \\/  | ___  __ _| |__    / ___| |   |_ _|",
  " | |\\/| |/ _ \\/ _` | '_ \\  | |   | |    | |",
  " | |  | |  __/ (_| | | | | | |___| |___ | |",
  " |_|  |_|\\___|\\__, |_| |_|  \\____|_____|___|",
  "              |___/",
];

/** "Megh" ends before this column and "CLI" starts after it (blank on every line). */
const SPLIT = 26;

/** Colour a logo line: "Megh" in cyan and "CLI" in red, like the brand logo. */
function paint(line: string): string {
  return c.cyan(line.slice(0, SPLIT)) + c.red(line.slice(SPLIT));
}

/** The logo plus the name and version, ready to print. Shown by `megh --info` (`-i`). */
export function banner(): string {
  const art = LOGO.map((l) => "  " + paint(l));
  return [
    ...art,
    "",
    `  ${c.bold(c.cyan("Megh"))} ${c.dim(`v${cliVersion()}`)}`,
  ].join("\n");
}

/**
 * `megh --info`: the banner, then the CLI, Node.js and OS versions, and, inside
 * a project, the Megh packages and TypeScript it has installed. Paste it into
 * a bug report.
 */
export function info(cwd: string): string {
  const rows: Array<[string, string]> = [
    ["CLI", cliVersion()],
    ["Node.js", process.version],
    ["OS", `${os.type()} ${os.release()} (${process.platform}-${process.arch})`],
  ];
  const root = findProjectRoot(cwd);
  if (root) {
    rows.push(["Project", root]);
    const missing = c.dim("not installed");
    for (const name of ["@meghjs/core", "@meghjs/data", "typescript"]) {
      rows.push([name, installedVersion(name, root) ?? missing]);
    }
  } else {
    rows.push(["Project", c.dim("none (not inside a Megh app)")]);
  }
  const width = Math.max(...rows.map(([label]) => label.length));
  return [banner(), "", ...rows.map(([label, value]) => `  ${c.dim(label.padEnd(width))}  ${value}`)].join("\n");
}
