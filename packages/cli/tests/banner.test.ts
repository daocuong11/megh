import { describe, expect, it } from "vitest";
import { runCli } from "../src/program";
import { banner } from "../src/utils/banner";
import { cliVersion } from "../src/utils/stubs";

describe("banner", () => {
  it("shows the logo, name and version", () => {
    const out = banner();
    expect(out).toContain("#########");
    expect(out).toContain(`Megh`);
    expect(out).toContain(`v${cliVersion()}`);
    // Fits an 80-column terminal.
    for (const line of out.replace(/\x1b\[\d+m/g, "").split("\n"))
      expect(line.length).toBeLessThanOrEqual(80);
  });

  it("is printed above the root help only", async () => {
    let root = "";
    await runCli(["--help"], { writeOut: (s) => (root += s) });
    expect(root.indexOf("#########")).toBeGreaterThanOrEqual(0);
    expect(root.indexOf("#########")).toBeLessThan(root.indexOf("Usage: megh"));

    let sub = "";
    await runCli(["make:event", "--help"], { writeOut: (s) => (sub += s) });
    expect(sub).not.toContain("#########");
  });
});
