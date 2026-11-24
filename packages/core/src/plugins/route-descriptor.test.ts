import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeghApplication } from "../core/application";
import { ApiController } from "../http/controller";
import { Body, Param, Query } from "../http/params";
import { Get, Post } from "../http/route-methods";
import { IsNotEmpty, IsString } from "../validator";
import { definePlugin } from "./plugin";
import { getRouteDescriptor, type RouteDescriptor } from "./route-descriptor";

class NoteDto {
  @IsString()
  @IsNotEmpty()
  text!: string;
}

@ApiController("/notes")
class NoteController {
  @Get("/:id")
  find(@Param("id") id: string, @Query("q", { required: false }) q?: string) {
    return { id, q };
  }

  @Post("/")
  create(@Body() body: NoteDto) {
    return body;
  }
}

const apps: MeghApplication[] = [];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  vi.restoreAllMocks();
});

describe("route descriptors", () => {
  it("are visible to a plugin's onRoute hook", async () => {
    const seen: { method: string; url: string; d: RouteDescriptor }[] = [];
    const spy = definePlugin({
      name: "spy",
      register(ctx) {
        ctx.http.addHook("onRoute", (route) => {
          const d = getRouteDescriptor(route);
          if (d) seen.push({ method: String(route.method), url: route.url, d });
        });
      },
    });
    const app = MeghApplication.getInternalApp({
      plugins: [spy],
      autoloadPlugins: false,
    });
    app.useErrorLogger(false);
    app.useControllers([NoteController]);
    apps.push(app);
    await app.run(0);

    const find = seen.find((s) => s.method === "GET")!;
    expect(find.url).toBe("/notes/:id");
    expect(find.d.controller).toBe(NoteController);
    expect(find.d.handler).toBe("find");
    expect(find.d.params).toEqual([{ name: "id", type: "string" }]);
    expect(find.d.query.map((q) => [q.name, q.required])).toEqual([
      ["q", false],
    ]);
    expect(find.d.body()).toBeUndefined();

    const create = seen.find((s) => s.method === "POST")!;
    expect(create.d.body()).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
  });
});
