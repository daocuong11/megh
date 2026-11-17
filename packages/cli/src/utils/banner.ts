import os from "os";
import { c } from "./log";
import { findProjectRoot, installedVersion } from "./project";
import { cliVersion } from "./stubs";

/** The Megh logo (a cloud and an M), shrunk to fit a terminal. */

const LOGO = String.raw`
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣀⣠⣤⣤⣀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣴⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣦⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣤⣾⣿⣿⣿⡿⠟⠛⠋⠉⠉⠉⠉⠙⠿⣿⣿⠗⠂⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⣾⣿⣿⣿⡟⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠳⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⣴⣾⣿⣿⣿⣿⣿⣿⡿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⣃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣼⣿⣿⣿⣿⠟⠻⠟⠛⠿⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠶⠛⠛⠛⠛⠷⠦⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⣰⣿⣿⠟⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⡀⠀⠈⠱⡀⠀⠀⠀⠀⢀⣶⣤⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⣠⣾⣿⣿⣿⣿⡿⠀⢀⣿⣿⣆⠀⠀⠀⠀⣰⣿⣿⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣹⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⠀⠀⣠⣄⣀⣤⣀⣀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⣰⣿⡿⠛⠁⠉⠀⠀⠀⢸⣿⣿⣿⣷⠀⢀⣼⣿⣿⣿⡟⠀⣰⣶⣿⣿⣿⣷⡄⠀⣤⣾⣿⣿⣿⣷⣦⠀⣿⣿⣷⣿⣿⣿⣷⡄⠀⠀⠀⢸⣿⣿⢠⣾⣿⣿⣿⣿⣿⡟⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠰⣿⣿⠁⠀⠀⠀⠀⠀⠀⢾⣿⣟⢻⣿⣷⣼⣿⡿⢿⣿⣿⢰⣿⣿⣿⣿⣿⣿⣿⢾⣿⣿⠋⠙⠛⣿⣿⡇⣹⣿⡟⠛⠉⢻⣿⣿⠀⠀⠀⢸⣿⣿⠘⢿⣿⣿⣿⣶⣶⣤⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠠⣿⣿⠀⠀⠀⠀⠀⠀⠀⣾⣿⡏⠀⢿⣿⣿⠟⠁⢸⣿⣿⢸⣿⣿⣿⣛⣿⣛⠛⠸⣿⣿⣶⣤⣴⣿⣿⡏⢻⣿⡇⠀⠀⢸⣿⣿⠀⠀⣀⣼⣿⣿⠀⣈⣩⣟⣛⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠹⣿⣷⡀⠀⠀⠀⠀⠀⣿⣿⠇⠀⠀⠙⠉⠀⠀⠸⣿⣿⠀⠹⢿⣿⣿⣿⣿⣧⠀⠙⠻⠿⠿⣿⣿⣿⡇⢿⣿⠇⠀⠀⢸⣿⡿⣰⣿⣿⣿⣿⠏⢺⣿⣿⣿⣿⣿⣿⠿⠁⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠈⠻⣿⣷⣤⣀⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⣴⣿⣿⣿⣿⣿⡿⠁⠀⠀⠀⠀⠀⢀⣀⣀⣩⣿⣿⡿⠖⠒⠊⠀⠈⠁⠀⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠙⠋⠉⠀⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠉⠙⠋⠉⢁⣀⣠⣤⣴⣶⣿⣿⠿⠻⠛⠉⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣀⣀⣠⣤⣤⣶⣶⣾⣿⡿⠿⠟⠛⠋⠁⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠈⠉⠉⠉⠉⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
`.slice(1);
// const LOGO = String.raw`
//              +++++
//            +++++
//        *******+
//      ********     ***
//    **********    ****
//  *****  ******  *****
// +++     ***+*********
// +++     *** ***** ***
//  ++     ***   **  ***
//    ++++ ***       ***
//      =+++=  #########`.slice(1);

/**
 * Colour the logo. The ASCII logo has the cloud in cyan, the M in bold and the
 * swoosh in cyan; a braille (or any other) logo is cyan throughout.
 */
function paint(line: string): string {
  if (!/[+=*#]/.test(line)) return c.cyan(line);
  return line.replace(/(\++|=+)|(\*+)|(#+)/g, (_, cloud, m, swoosh) =>
    cloud ? c.cyan(cloud) : m ? c.bold(m) : c.cyan(swoosh),
  );
}

/** The logo plus the name and version, ready to print. Shown by `megh -v` and `megh --info`. */
export function banner(): string {
  const art = LOGO.replace(/\n+$/, "").split("\n").map((l) => "  " + paint(l));
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
