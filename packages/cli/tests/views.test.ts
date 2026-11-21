import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runCli } from "../src/program";
import { createApplication } from "../src/commands/new";
import { makeView } from "../src/generators/make";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "megh-views-"));
  for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
  vi.stubEnv("MEGH_SKIP_GIT", "1");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const read = (...p: string[]) => fs.readFileSync(path.join(tmp, ...p), "utf8");
const exists = (...p: string[]) => fs.existsSync(path.join(tmp, ...p));
const project = () => fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "x" }));

describe("new --mvc", () => {
  it("scaffolds views, a view-rendering controller and useViews()", async () => {
    await createApplication("shop", { cwd: tmp, yes: true, skipInstall: true, mvc: true });

    const app = read("shop", "src", "app.ts");
    expect(app).toContain("app.useViews();");
    expect(app).toContain("app.useMethodOverride();");
    expect(app).toContain("useOpenApi"); // default features kept

    expect(read("shop", "src", "controllers", "home.controller.ts")).toContain("Results.View('pages.home'");
    expect(read("shop", "src", "controllers", "home.controller.spec.ts")).toContain("ViewResult");
    expect(read("shop", "views", "layouts", "app.megh.html")).toContain("@yield('title', 'Shop')");
    const home = read("shop", "views", "pages", "home.megh.html");
    expect(home).toContain("@extends('layouts.app')");
    expect(home).toContain("{{ message }}");
    expect(read("shop", "README.md")).toContain("views/\n├── layouts/");
  });

  it("leaves views out of a regular project", async () => {
    await createApplication("api", { cwd: tmp, yes: true, skipInstall: true });
    expect(exists("api", "views")).toBe(false);
    expect(read("api", "src", "app.ts")).not.toContain("useViews");
    expect(read("api", "README.md")).not.toContain("views/");
  });

  it("rejects --mvc with --minimal", async () => {
    await expect(
      createApplication("bad", { cwd: tmp, yes: true, skipInstall: true, mvc: true, minimal: true }),
    ).rejects.toThrow(/--mvc .* Leave out --minimal/);
  });
});

describe("make:view", () => {
  it("writes a standalone page when there is no layout", () => {
    project();
    const file = makeView("about", { cwd: tmp });
    expect(file).toBe(path.join(tmp, "views", "about.megh.html"));
    expect(read("views", "about.megh.html")).toContain("<!doctype html>");
    expect(read("views", "about.megh.html")).not.toContain("@extends");
  });

  it("extends layouts.app when it exists, for dotted and slashed names", () => {
    project();
    fs.mkdirSync(path.join(tmp, "views", "layouts"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "views", "layouts", "app.megh.html"), "@yield('content')");

    makeView("pages.userProfile", { cwd: tmp });
    makeView("admin/dashboard", { cwd: tmp });
    const page = read("views", "pages", "user-profile.megh.html");
    expect(page).toContain("@extends('layouts.app')");
    expect(page).toContain("@section('title', 'User Profile')");
    expect(exists("views", "admin", "dashboard.megh.html")).toBe(true);
  });

  it("takes --layout and --no-layout", () => {
    project();
    fs.mkdirSync(path.join(tmp, "views", "layouts"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "views", "layouts", "app.megh.html"), "");
    makeView("a", { cwd: tmp, layout: "layouts.admin" });
    makeView("b", { cwd: tmp, layout: false });
    expect(read("views", "a.megh.html")).toContain("@extends('layouts.admin')");
    expect(read("views", "b.megh.html")).not.toContain("@extends");
  });

  it("writes a component with -c", () => {
    project();
    makeView("forms/input", { cwd: tmp, component: true });
    makeView("components.alert", { cwd: tmp, component: true });
    expect(read("views", "components", "forms", "input.megh.html")).toContain("<x-forms.input>");
    expect(read("views", "components", "alert.megh.html")).toContain("{{ slot }}");
  });

  it("refuses to overwrite without --force", () => {
    project();
    makeView("about", { cwd: tmp });
    expect(() => makeView("about", { cwd: tmp })).toThrow(/already exists/);
  });

  it("is registered as make:view and m:v", async () => {
    project();
    expect(await runCli(["make:view", "pages.about"], { cwd: tmp })).toBe(0);
    expect(await runCli(["m:v", "pages/contact", "--no-layout"], { cwd: tmp })).toBe(0);
    expect(await runCli(["m:v", "badge", "-c"], { cwd: tmp })).toBe(0);
    expect(exists("views", "pages", "about.megh.html")).toBe(true);
    expect(exists("views", "pages", "contact.megh.html")).toBe(true);
    expect(exists("views", "components", "badge.megh.html")).toBe(true);
  });
});
