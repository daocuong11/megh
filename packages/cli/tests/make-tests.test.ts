import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runCli } from "../src/program";
import {
  makeClass,
  makeConfig,
  makeController,
  makeDto,
  makeEvent,
  makeListener,
  makeMail,
  makeMiddleware,
  makeModel,
  makeQueue,
  makeResource,
  makeService,
  makeTask,
  makeTest,
  makeWorker,
} from "../src/generators/make";
import { sampleValue } from "../src/generators/specs";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "megh-tests-"));
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "x" }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const file = (...p: string[]) => path.join(tmp, ...p);
const exists = (...p: string[]) => fs.existsSync(file(...p));
const read = (...p: string[]) => fs.readFileSync(file(...p), "utf8");
const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), content);
};

const CREATE_USERS = `import { defineMigration } from "@meghjs/core";

export default defineMigration({
  async up(schema) {
    await schema.create("users", (table) => {
      table.id();
      table.string("name");
      table.string("email").unique();
      table.boolean("active").default(true);
      table.timestamps();
    });
  },
});
`;

describe("generated tests", () => {
  it("writes a spec next to each generated file", () => {
    makeService("hello", { cwd: tmp });
    makeController("hello", { cwd: tmp });
    makeController("items", { cwd: tmp, resource: true });
    makeConfig("jwt", { cwd: tmp });
    makeMiddleware("auth", { cwd: tmp });
    makeMail("welcome", { cwd: tmp });
    makeEvent("UserCreated", { cwd: tmp });
    makeListener("SendWelcome", { cwd: tmp, event: "UserCreated" });
    makeListener("Audit", { cwd: tmp });
    makeQueue("OrderExport", { cwd: tmp });
    makeWorker("Report", { cwd: tmp });
    makeTask("Cleanup", { cwd: tmp });
    makeDto("CreatePost", { cwd: tmp });
    makeClass("Money", { cwd: tmp });
    for (const spec of [
      "src/services/hello.service.spec.ts",
      "src/controllers/hello.controller.spec.ts",
      "src/controllers/items.controller.spec.ts",
      "src/config/jwt.config.spec.ts",
      "src/middlewares/auth.middleware.spec.ts",
      "src/mail/welcome.mail.spec.ts",
      "src/events/user-created.event.spec.ts",
      "src/listeners/send-welcome.listener.spec.ts",
      "src/listeners/audit.listener.spec.ts",
      "src/queues/order-export.queue.spec.ts",
      "src/workers/report.worker.spec.ts",
      "src/tasks/cleanup.task.spec.ts",
      "src/dtos/create-post.dto.spec.ts",
      "src/classes/money.spec.ts",
    ]) {
      expect(exists(...spec.split("/")), spec).toBe(true);
      // Every placeholder is filled in.
      expect(read(...spec.split("/")), spec).not.toMatch(/\{[A-Za-z]+\}/);
    }
    expect(read("src", "services", "hello.service.spec.ts")).toContain("import { HelloService } from './hello.service';");
    expect(read("src", "listeners", "send-welcome.listener.spec.ts")).toContain(
      "import { UserCreatedEvent } from '../events/user-created.event';",
    );
    expect(read("src", "listeners", "audit.listener.spec.ts")).toContain("class TestEvent extends MeghEvent");
  });

  it("writes none with notest, from the API or with --notest / -nt", async () => {
    makeService("a", { cwd: tmp, notest: true });
    expect(await runCli(["make:service", "b", "--notest"], { cwd: tmp })).toBe(0);
    expect(await runCli(["m:c", "c", "-nt"], { cwd: tmp })).toBe(0);
    expect(await runCli(["make:dto", "d", "--no-test"], { cwd: tmp })).toBe(0);
    expect(exists("src", "services", "a.service.ts")).toBe(true);
    for (const spec of ["services/a.service", "services/b.service", "controllers/c.controller", "dtos/d.dto"]) {
      expect(exists("src", ...`${spec}.spec.ts`.split("/")), spec).toBe(false);
    }
  });

  it("keeps an existing spec unless forced", () => {
    makeService("hello", { cwd: tmp });
    fs.writeFileSync(file("src", "services", "hello.service.spec.ts"), "// mine\n");
    fs.rmSync(file("src", "services", "hello.service.ts"));
    makeService("hello", { cwd: tmp });
    expect(read("src", "services", "hello.service.spec.ts")).toBe("// mine\n");
    makeService("hello", { cwd: tmp, force: true });
    expect(read("src", "services", "hello.service.spec.ts")).toContain("describe('HelloService'");
  });

  it("tests every method of a resource service and controller, with sample columns", () => {
    write("src/database/migrations/20260101000000_create_users_table.ts", CREATE_USERS);
    makeResource("user", { cwd: tmp });
    const service = read("src", "services", "user.service.spec.ts");
    for (const method of ["findAll", "paginate", "find", "findOrFail", "create", "update", "delete"]) {
      expect(service).toContain(`describe('${method}'`);
    }
    expect(service).toContain("import { User } from '../models/user.model';");
    expect(service).toContain("email: 'user@example.com',");
    expect(service).toContain("active: true,");
    // update() is called with a column set to undefined, which it must skip.
    expect(service).toMatch(/name: 'name',\n\s+email: undefined,/);

    const controller = read("src", "controllers", "user.controller.spec.ts");
    expect(controller).toContain("import type { CreateUserDto, ListUsersQuery, UpdateUserDto } from '../dtos/user.dto';");
    expect(controller).toContain("MeghTest.getController(UserController, [userService])");
    for (const route of ["GET /users", "GET /users/:id", "POST /users", "PUT /users/:id", "DELETE /users/:id"]) {
      expect(controller).toContain(`'${route} `);
    }
    expect(controller).toContain("{ message: 'User deleted.' }");
  });

  it("tests a TypeORM service and controller against stand-ins", () => {
    makeController("tag", { cwd: tmp, model: "tag", typeorm: true });
    expect(read("src", "services", "tag.service.spec.ts")).toContain("MeghTest.getProvider(TagService, [repository])");
    expect(read("src", "controllers", "tag.controller.spec.ts")).toContain("rejects.toThrow('Tag not found.')");
  });

  it("picks sample values from the column types", () => {
    expect(sampleValue({ name: "contact_email", ts: "string" })).toBe("'user@example.com'");
    expect(sampleValue({ name: "status", ts: "'draft' | 'live'" })).toBe("'draft'");
    expect(sampleValue({ name: "born_on", ts: "Date" })).toBe("new Date('2026-01-01T00:00:00.000Z')");
    expect(sampleValue({ name: "settings", ts: "Record<string, unknown>" })).toBe("{}");
    expect(sampleValue({ name: "blob", ts: "unknown" })).toBeUndefined();
  });
});

describe("make:class", () => {
  it("writes a plain class and its test, also as m:cls", async () => {
    expect(await runCli(["m:cls", "admin/PriceList"], { cwd: tmp })).toBe(0);
    expect(read("src", "admin", "classes", "price-list.ts")).toContain("export class PriceList {");
    expect(read("src", "admin", "classes", "price-list.spec.ts")).toContain("new PriceList()");
  });
});

describe("make:model", () => {
  it("writes a plain class by default", () => {
    write("src/database/migrations/20260101000000_create_users_table.ts", CREATE_USERS);
    makeModel("user", { cwd: tmp });
    const model = read("src", "models", "user.model.ts");
    expect(model).toContain("export class User {");
    expect(model).not.toContain("@meghjs/core");
    // No test: models are left out.
    expect(exists("src", "models", "user.model.spec.ts")).toBe(false);
  });

  it("writes a Megh ORM model with --orm and a TypeORM entity with --typeorm", async () => {
    expect(await runCli(["make:model", "user", "--orm"], { cwd: tmp })).toBe(0);
    expect(read("src", "models", "user.model.ts")).toContain("extends Model");
    expect(await runCli(["make:model", "tag", "--typeorm"], { cwd: tmp })).toBe(0);
    expect(read("src", "models", "tag.model.ts")).toContain("@Entity");
    expect(() => makeModel("x", { cwd: tmp, orm: true, typeorm: true })).toThrow(/not both/);
  });

  it("refuses to build a resource on a plain class", () => {
    write("src/database/migrations/20260101000000_create_users_table.ts", CREATE_USERS);
    makeModel("user", { cwd: tmp });
    expect(() => makeResource("user", { cwd: tmp })).toThrow(/plain class.*--orm --force/);
  });
});

describe("make:test", () => {
  it("finds the file from user.service, UserService or --type", () => {
    makeService("user", { cwd: tmp, notest: true });
    const spec = file("src", "services", "user.service.spec.ts");
    expect(makeTest("user.service", { cwd: tmp })).toBe(spec);
    expect(() => makeTest("UserService", { cwd: tmp })).toThrow(/already exists/);
    expect(makeTest("UserService", { cwd: tmp, force: true })).toBe(spec);
    expect(makeTest("user", { cwd: tmp, type: "service", force: true })).toBe(spec);
    // The generated basic service is recognised.
    expect(read("src", "services", "user.service.spec.ts")).toContain("sayHello() says hello");
  });

  it("recognises a resource service and controller", () => {
    write("src/database/migrations/20260101000000_create_users_table.ts", CREATE_USERS);
    makeResource("user", { cwd: tmp, notest: true });
    makeTest("user.service", { cwd: tmp });
    makeTest("UserController", { cwd: tmp });
    expect(read("src", "services", "user.service.spec.ts")).toContain("describe('paginate'");
    expect(read("src", "controllers", "user.controller.spec.ts")).toContain("MeghTest.getController(UserController, [userService])");
  });

  it("writes a todo for each public method of a hand-written class", () => {
    write(
      "src/utils/price-calculator.ts",
      "export class PriceCalculator {\n  total(items: number[]) {\n    return 0;\n  }\n\n  async refresh() {}\n\n  private secret() {}\n}\n",
    );
    makeTest("price-calculator", { cwd: tmp });
    const spec = read("src", "utils", "price-calculator.spec.ts");
    expect(spec).toContain("new PriceCalculator()");
    expect(spec).toContain("it.todo('total()');");
    expect(spec).toContain("it.todo('refresh()');");
    expect(spec).not.toContain("secret");
  });

  it("writes a starter spec in src/tests/ when nothing matches", async () => {
    expect(await runCli(["m:t", "checkout"], { cwd: tmp })).toBe(0);
    expect(read("src", "tests", "checkout.spec.ts")).toContain("describe('Checkout'");
  });

  it("explains a missing file, an unknown type and an ambiguous name", () => {
    expect(() => makeTest("user.service", { cwd: tmp })).toThrow(/no src\/services\/user\.service\.ts.*make:service user/i);
    expect(() => makeTest("user", { cwd: tmp, type: "nope" })).toThrow(/Unknown --type/);
    makeService("hello", { cwd: tmp, notest: true });
    makeController("hello", { cwd: tmp, notest: true });
    expect(() => makeTest("hello", { cwd: tmp })).toThrow(/matches several files/);
  });
});
