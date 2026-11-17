/**
 * Tests for #59 useCompression, #60 global prefix and versioning,
 * #61 redirects and response headers, #62 config schemas, #63 Socket.IO
 * handshake authentication.
 */
import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeghApplication } from "./application";
import { MeghTest } from "./testing";
import { ApiController } from "../http/controller";
import { Get, Redirect, ResponseHeader } from "../http/route-methods";
import { Results } from "../http/results";
import { Version } from "../http/versioning";
import { IsInt, IsString, Min } from "../validator/decorators";
import {
  AppConfig,
  ConfigValidationError,
  GetConfig,
  MeghConfig,
  validateEnv,
} from "../config/config";
import { handshakeAuthentication } from "../realtime/handshake";

const testApp = () => MeghApplication.getInternalApp();

// ─── #59 ─────────────────────────────────────────────────────────────────────

describe("useCompression (#59)", () => {
  it("compresses large responses for clients that accept gzip", async () => {
    @ApiController("/zip")
    class ZipController {
      @Get("/")
      big() {
        return { text: "x".repeat(5000) };
      }
    }
    const app = testApp().useCompression();
    app.useControllers([ZipController]);
    const http = MeghTest.from(app);
    const res = await http.get("/zip", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("can only be turned on once", () => {
    const app = testApp().useCompression();
    expect(() => app.useCompression()).toThrow("already on");
  });
});

// ─── #60 ─────────────────────────────────────────────────────────────────────

describe("global prefix and versioning (#60)", () => {
  @ApiController("/items")
  class ItemsController {
    @Get("/")
    list() {
      return { v: "default" };
    }
  }

  @Version("2")
  @ApiController("/items")
  class ItemsV2Controller {
    @Get("/")
    list() {
      return { v: "2" };
    }

    @Get("/both")
    @Version(["1", "2"])
    both() {
      return { both: true };
    }
  }

  it("prefixes controller and inline routes, except excluded ones", async () => {
    @ApiController("/ping")
    class PingController {
      @Get("/")
      ping() {
        return { ok: true };
      }
    }
    const app = testApp().setGlobalPrefix("/api", { exclude: ["/ping"] });
    app.useControllers([ItemsController, PingController]);
    app.mapGet("/inline", () => ({ inline: true }));
    (app as any).router.processFunctionalRoutes();
    const http = MeghTest.from(app);
    expect((await http.get("/api/items")).statusCode).toBe(200);
    expect((await http.get("/items")).statusCode).toBe(404);
    expect((await http.get("/ping")).statusCode).toBe(200);
    expect((await http.get("/api/inline")).statusCode).toBe(200);
  });

  it("URI versioning puts the version in the path", async () => {
    const app = testApp()
      .setGlobalPrefix("/api")
      .useVersioning({ type: "uri", defaultVersion: "1" });
    app.useControllers([ItemsController, ItemsV2Controller]);
    const http = MeghTest.from(app);
    expect((await http.get("/api/v1/items")).json()).toEqual({
      v: "default",
    });
    expect((await http.get("/api/v2/items")).json()).toEqual({ v: "2" });
    expect((await http.get("/api/v1/items/both")).statusCode).toBe(200);
    expect((await http.get("/api/v2/items/both")).statusCode).toBe(200);
    expect((await http.get("/api/items")).statusCode).toBe(404);
  });

  it("header versioning picks the route from the header", async () => {
    const app = testApp().useVersioning({
      type: "header",
      header: "X-API-Version",
      defaultVersion: "1",
    });
    app.useControllers([ItemsController, ItemsV2Controller]);
    const http = MeghTest.from(app);
    const v2 = await http.get("/items", { headers: { "x-api-version": "2" } });
    expect(v2.json()).toEqual({ v: "2" });
    const v1 = await http.get("/items", { headers: { "x-api-version": "1" } });
    expect(v1.json()).toEqual({ v: "default" });
    // No header: the default version.
    expect((await http.get("/items")).json()).toEqual({ v: "default" });
  });

  it("rejects an invalid version", () => {
    expect(() => Version("")).toThrow("non-empty");
  });
});

// ─── #61 ─────────────────────────────────────────────────────────────────────

describe("redirects and response headers (#61)", () => {
  @ApiController("/r")
  class RedirectController {
    @Get("/fixed")
    @Redirect("https://example.com/docs", 301)
    fixed() {}

    @Get("/dynamic")
    @Redirect("/fallback")
    dynamic() {
      return { url: "/chosen", statusCode: 307 };
    }

    @Get("/result")
    result() {
      return Results.Redirect("/login");
    }

    @Get("/headers")
    @ResponseHeader("Cache-Control", "no-store")
    @ResponseHeader("X-Thing", "1")
    headers() {
      return { ok: true };
    }
  }

  const http = () => {
    const app = testApp();
    app.useControllers([RedirectController]);
    return MeghTest.from(app);
  };

  it("@Redirect sends the decorator's location", async () => {
    const res = await http().get("/r/fixed");
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe("https://example.com/docs");
  });

  it("the handler's { url, statusCode } overrides @Redirect", async () => {
    const res = await http().get("/r/dynamic");
    expect(res.statusCode).toBe(307);
    expect(res.headers.location).toBe("/chosen");
  });

  it("Results.Redirect redirects with 302", async () => {
    const res = await http().get("/r/result");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login");
    expect(() => Results.Redirect("/x", 200)).toThrow("3xx");
  });

  it("@ResponseHeader sets headers", async () => {
    const res = await http().get("/r/headers");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-thing"]).toBe("1");
  });
});

// ─── #62 ─────────────────────────────────────────────────────────────────────

describe("config schemas (#62)", () => {
  class EnvSchema {
    @IsInt()
    @Min(1)
    PORT: number;

    @IsString()
    APP_NAME: string;
  }

  it("validateEnv converts and validates only the declared variables", () => {
    const env = validateEnv(EnvSchema, {
      PORT: "4000",
      APP_NAME: "api",
      UNRELATED: "x",
    });
    expect(env.PORT).toBe(4000);
    expect(env.APP_NAME).toBe("api");
  });

  it("validateEnv lists every invalid variable", () => {
    try {
      validateEnv(EnvSchema, { PORT: "abc" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const paths = (err as ConfigValidationError).issues.map((i) => i.path);
      expect(paths.sort()).toEqual(["APP_NAME", "PORT"]);
      expect((err as Error).message).toContain("Invalid environment");
    }
  });

  it("@AppConfig({ schema }) checks what config() returns", () => {
    class MailSchema {
      @IsInt()
      port: number;
    }
    @AppConfig({ schema: MailSchema })
    class BadMailConfig extends MeghConfig<{ port: unknown; extra: string }> {
      config() {
        return { port: "nope", extra: "ignored" };
      }
    }
    expect(() => GetConfig(BadMailConfig)).toThrow(/Invalid BadMailConfig/);
  });

  it("run() fails at boot on an invalid environment", async () => {
    const app = testApp().useEnvSchema(EnvSchema);
    const before = process.env.PORT;
    process.env.PORT = "-5";
    try {
      await expect(app.run(0, { host: "127.0.0.1" })).rejects.toThrow(
        ConfigValidationError,
      );
    } finally {
      if (before === undefined) delete process.env.PORT;
      else process.env.PORT = before;
    }
  });
});

// ─── #63 ─────────────────────────────────────────────────────────────────────

describe("Socket.IO handshake authentication (#63)", () => {
  afterEach(() => vi.restoreAllMocks());

  const socket = (auth: Record<string, unknown> = {}, headers = {}) => ({
    handshake: { headers, auth, query: {}, address: "127.0.0.1", url: "/" },
    data: {} as Record<string, unknown>,
  });

  it("sets socket.data.user from the authentication handler", async () => {
    const seen: any[] = [];
    const middleware = handshakeAuthentication({
      authenticate: (req: any) => {
        seen.push(req.headers.authorization);
        return { id: 1 };
      },
    });
    const s = socket({ token: "abc" });
    const next = vi.fn();
    await middleware(s, next);
    expect(next).toHaveBeenCalledWith();
    expect(s.data.user).toEqual({ id: 1 });
    expect(seen).toEqual(["Bearer abc"]);
  });

  it("lets guests in and refuses when the handler throws", async () => {
    const guest = socket();
    const next = vi.fn();
    await handshakeAuthentication({ authenticate: () => null })(guest, next);
    expect(next).toHaveBeenCalledWith();
    expect(guest.data.user).toBeUndefined();

    const refused = vi.fn();
    await handshakeAuthentication({
      authenticate: () => {
        throw new Error("bad token");
      },
    })(socket(), refused);
    expect(refused.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(refused.mock.calls[0][0].message).toBe("Unauthorized");
  });
});
