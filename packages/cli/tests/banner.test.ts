import { describe, expect, it } from "vitest";
import { runCli } from "../src/program";
import { banner, info } from "../src/utils/banner";
import { cliVersion } from "../src/utils/stubs";

const plain = (s: string) => s.replace(/\x1b\[\d+m/g, "");
/** The first line of the logo, which marks the banner in any output. */
const logoLine = () => plain(banner()).split("\n")[0];

const capture = async (args: string[]) => {
  let out = "";
  expect(await runCli(args, { writeOut: (s) => (out += s) })).toBe(0);
  return out;
};

describe("banner", () => {
  it("shows the logo, name and version", () => {
    const out = plain(banner());
    expect(out).toContain("Megh");
    expect(out).toContain(`v${cliVersion()}`);
    // Fits an 80-column terminal.
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("shows the Megh CLI art", () => {
    const out = plain(banner());
    expect(out).toContain(" |  \\/  | ___  __ _| |__    / ___| |   |_ _|");
    expect(out).toContain("|_|  |_|\\___|\\__, |_| |_|  \\____|_____|___|");
  });

  it("is not printed by -v and --version, which print only the version", async () => {
    for (const flag of ["-v", "--version"]) {
      const out = await capture([flag]);
      expect(out.trim()).toBe(cliVersion());
      expect(out).not.toContain(logoLine());
    }
  });

  it("is printed by --info and -i, with the Node.js and OS versions", async () => {
    expect(plain(await capture(["-i"]))).toContain(logoLine());
    const out = plain(await capture(["--info"]));
    expect(out).toContain(logoLine());
    expect(out).toContain(process.version);
    expect(out).toMatch(/OS\s+\S/);
    expect(plain(info(process.cwd()))).toContain("CLI");
  });

  it("is not printed by help", async () => {
    const root = await capture(["--help"]);
    expect(root).toContain("Usage: megh");
    expect(root).not.toContain(logoLine());
    expect(root).toContain("--info");

    const sub = await capture(["make:event", "--help"]);
    expect(sub).not.toContain(logoLine());
  });
});
