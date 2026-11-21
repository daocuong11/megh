import { describe, expect, it } from "vitest";
import { Megh } from "./testing";
import { MeghApplication } from "./application";

describe("Megh.createApplication", () => {
  it("should return an instance of MeghApplication", () => {
    const app = Megh.createApplication();
    expect(app).toBeInstanceOf(MeghApplication);
  });

  it("should always return the same instance (singleton)", () => {
    const app1 = Megh.createApplication();
    const app2 = Megh.createApplication();
    expect(app1).toBe(app2);
  });

  it("setGlobalPrefix exclude matches inline route without leading slash", () => {
    const app = new MeghApplication();
    app.setGlobalPrefix("/api", { exclude: ["/status"] });
    app.mapGet("status", () => "ok");

    const targets = (app as any).router.routeTargets("status", undefined);
    expect(targets[0].url).toBe("/status");
  });

  it("setGlobalPrefix exclude matches inline route with trailing slash", () => {
    const app = new MeghApplication();
    app.setGlobalPrefix("/api", { exclude: ["/status"] });
    app.mapGet("/status/", () => "ok");

    const targets = (app as any).router.routeTargets("/status/", undefined);
    expect(targets[0].url).toBe("/status");
  });

  it("setGlobalPrefix exclude / matches empty inline path", () => {
    const app = new MeghApplication();
    app.setGlobalPrefix("/api", { exclude: ["/"] });
    app.mapGet("", () => "ok");

    const targets = (app as any).router.routeTargets("", undefined);
    expect(targets[0].url).toBe("/");
  });
});
