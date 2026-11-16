import { c } from "./log";
import { cliVersion } from "./stubs";

/** The Megh logo (a cloud and an M), shrunk to fit a terminal. */
const LOGO = String.raw`
             +++++
           +++++
       *******+
     ********     ***
   **********    ****
 *****  ******  ******
+++     ***+**********
+++     *** ***** ****
 ++     ***   **  ****
   ++++ ***       ****
     =+++=  #########`.slice(1);

/** Colour each character of the logo: the cloud in cyan, the M in bold, the swoosh dimmed. */
function paint(line: string): string {
  return line.replace(/(\++|=+)|(\*+)|(#+)/g, (_, cloud, m, swoosh) =>
    cloud ? c.cyan(cloud) : m ? c.bold(m) : c.cyan(swoosh),
  );
}

/** The logo plus the name and version, ready to print. */
export function banner(): string {
  const art = LOGO.split("\n").map((l) => "  " + paint(l));
  return [
    ...art,
    "",
    `  ${c.bold(c.cyan("Megh"))} ${c.dim(`v${cliVersion()}`)}`,
  ].join("\n");
}
