import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ServerOptions } from "../src/server";

let root: string;
let client: Client;
const clients: Client[] = [];

async function connect(opts: ServerOptions): Promise<Client> {
  const server = createServer({ version: "test", ...opts });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), c.connect(clientSide)]);
  clients.push(c);
  return c;
}

const call = async (name: string, args: Record<string, unknown> = {}, c = client) => {
  const res = (await c.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  return { text: res.content.map((x) => x.text).join("\n"), isError: !!res.isError };
};

const write = (rel: string, content: string) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "megh-mcp-"));
  write(
    "package.json",
    JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { "@meghjs/core": "^0.6.3" } }),
  );
  write(
    "src/controllers/user.controller.ts",
    `@ApiController("/users")
export class UserController {
  @Get("/")
  list() {}
  @Post("/:id")
  update() {}
}
`,
  );
  write("src/database/migrations/20260101000000_create_users_table.ts", "export {};\n");
  write("src/app.ts", "export const app = 1;\n");
  client = await connect({ projectRoot: root });
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  fs.rmSync(root, { recursive: true, force: true });
});

const READ_TOOLS = [
  "megh_doctor",
  "megh_list_routes",
  "megh_list_templates",
  "megh_migrate_status",
  "megh_project_info",
  "megh_project_structure",
  "megh_read_doc",
  "megh_search_docs",
  "megh_typecheck",
];
const WRITE_TOOLS = [
  "megh_build",
  "megh_db_seed",
  "megh_make",
  "megh_migrate",
  "megh_migrate_rollback",
  "megh_scaffold_auth",
  "megh_scaffold_domain",
  "megh_scaffold_rbac",
  "megh_sync_model",
];

describe("tools", () => {
  it("lists every tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
  });

  it("leaves out the write tools and the add-resource prompt in read-only mode", async () => {
    const ro = await connect({ projectRoot: root, readOnly: true });
    const { tools } = await ro.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(READ_TOOLS);
    const { prompts } = await ro.listPrompts();
    expect(prompts.map((p) => p.name)).not.toContain("megh-add-resource");
  });

  it("marks only the read tools read-only", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(READ_TOOLS.includes(t.name));
    expect(tools.find((t) => t.name === "megh_migrate_rollback")?.annotations?.destructiveHint).toBe(true);
  });
});

describe("project", () => {
  it("reports project info", async () => {
    const { text, isError } = await call("megh_project_info");
    expect(isError).toBe(false);
    const info = JSON.parse(text);
    expect(info.root).toBe(root);
    expect(info.name).toBe("demo");
    expect(info.isMeghProject).toBe(true);
    expect(info.meghDependencies).toEqual({ "@meghjs/core": "^0.6.3" });
  });

  it("groups the source files by kind", async () => {
    const s = JSON.parse((await call("megh_project_structure")).text);
    expect(s.entry).toBe("src/app.ts");
    expect(s.files.controllers).toEqual(["src/controllers/user.controller.ts"]);
    expect(s.files.migrations).toEqual(["src/database/migrations/20260101000000_create_users_table.ts"]);
    expect(s.counts.controllers).toBe(1);
  });

  it("runs the doctor checks", async () => {
    const checks = JSON.parse((await call("megh_doctor")).text);
    expect(checks.find((c: any) => c.name === "Node.js")?.status).toBe("ok");
  });

  it("lists routes from the source with static", async () => {
    const { text, isError } = await call("megh_list_routes", { static: true });
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual([
      { method: "GET", path: "/users", controller: "UserController", handler: "list", file: "src/controllers/user.controller.ts", auth: "default" },
      { method: "POST", path: "/users/:id", controller: "UserController", handler: "update", file: "src/controllers/user.controller.ts", auth: "default" },
    ]);
  });

  it("type-checks the project and reports errors", async () => {
    const ts = fs.mkdtempSync(path.join(os.tmpdir(), "megh-mcp-ts-"));
    try {
      fs.writeFileSync(path.join(ts, "package.json"), '{"name":"ts"}');
      fs.writeFileSync(path.join(ts, "tsconfig.json"), '{"compilerOptions":{"strict":true,"types":[]},"include":["*.ts"]}');
      fs.writeFileSync(path.join(ts, "ok.ts"), "export const n: number = 1;\n");
      expect(await call("megh_typecheck", { cwd: ts })).toEqual({ text: "No type errors.", isError: false });

      fs.writeFileSync(path.join(ts, "bad.ts"), 'export const n: number = "one";\n');
      const bad = await call("megh_typecheck", { cwd: ts });
      expect(bad.isError).toBe(true);
      expect(bad.text).toMatch(/^1 type error\(s\)/);
      expect(bad.text).toContain("TS2322");
    } finally {
      fs.rmSync(ts, { recursive: true, force: true });
    }
  });

  it("reports a missing project as a tool error", async () => {
    const { text, isError } = await call("megh_project_info", { cwd: path.parse(root).root + "no-such-dir-megh" });
    expect(isError).toBe(true);
    expect(text).toMatch(/No package.json|ENOENT/);
  });
});

describe("generators", () => {
  it("generates a service with megh_make", async () => {
    const { isError } = await call("megh_make", { kind: "service", name: "admin/Report" });
    expect(isError).toBe(false);
    expect(fs.existsSync(path.join(root, "src", "admin", "services", "report.service.ts"))).toBe(true);
  });

  it("rejects an unknown generator", async () => {
    const { isError } = await call("megh_make", { kind: "nope", name: "x" });
    expect(isError).toBe(true);
  });
});

describe("database", () => {
  it("refuses to change a production database", async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      for (const tool of ["megh_migrate", "megh_migrate_rollback", "megh_db_seed"]) {
        const { text, isError } = await call(tool);
        expect(isError, tool).toBe(true);
        expect(text).toMatch(/^Refusing to run megh .*NODE_ENV is production/);
      }
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});

describe("docs", () => {
  it("searches the docs", async () => {
    const hits = JSON.parse((await call("megh_search_docs", { query: "controller route decorator" })).text);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h: any) => h.path)).toContain("core-concept/controller");
    expect(hits[0]).toHaveProperty("snippets");
  });

  it("reads a page and lists the pages", async () => {
    const page = await call("megh_read_doc", { page: "core-concept/controller" });
    expect(page.isError).toBe(false);
    expect(page.text).toContain("@ApiController");

    const list = JSON.parse((await call("megh_read_doc")).text);
    expect(list.find((p: any) => p.path === "core-concept/controller")?.title).toBe("Controllers");
  });

  it("reports an unknown page", async () => {
    expect((await call("megh_read_doc", { page: "nope/nope" })).isError).toBe(true);
  });

  it("serves the docs and project as resources", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("megh://docs/core-concept/controller");
    expect(uris).toContain("megh://project/info");

    const doc = await client.readResource({ uri: "megh://docs/core-concept/controller" });
    expect((doc.contents[0] as { text: string }).text).toContain("@ApiController");

    const info = await client.readResource({ uri: "megh://project/structure" });
    expect(JSON.parse((info.contents[0] as { text: string }).text).root).toBe(root);
  });
});

describe("prompts", () => {
  it("lists the prompts and fills in their arguments", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["megh-add-resource", "megh-explain", "megh-review-project"]);

    const res = await client.getPrompt({ name: "megh-add-resource", arguments: { name: "Product", fields: "title,price:money" } });
    const msg = res.messages[0].content as { text: string };
    expect(msg.text).toContain('name "Product" and fields "title,price:money"');
  });
});
