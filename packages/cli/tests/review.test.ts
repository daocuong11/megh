import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runCli } from "../src/program";
import { diffLines, members } from "../src/utils/changes";

let tmp: string;
let logs: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "megh-review-"));
  fs.writeFileSync(
    path.join(tmp, "package.json"),
    JSON.stringify({ name: "x" }),
  );
  logs = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(
      (msg) => void logs.push(String(msg)),
    );
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const file = (rel: string) => path.join(tmp, ...rel.split("/"));
const read = (rel: string) => fs.readFileSync(file(rel), "utf8");
const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), content);
};
const out = () => logs.join("\n");

const migration = (name: string, body: string) =>
  write(
    `src/database/migrations/${name}`,
    `import { defineMigration } from "@meghjs/core";
export default defineMigration({
  async up(schema) {
${body}
  },
  async down(schema) {},
});
`,
  );

/** A users table, a model for it, and a service that reads `age`. */
async function project() {
  migration(
    "20260101000000_create_users_table.ts",
    `    await schema.create("users", (table) => {
      table.id();
      table.string("email");
      table.integer("age");
    });`,
  );
  expect(await runCli(["make:model", "user"], { cwd: tmp })).toBe(0);
  write(
    "src/services/user.service.ts",
    `import { User } from "../models/user.model";

export class UserService {
  async adults() {
    return (await User.all()).filter((u) => u.age >= 18);
  }
}
`,
  );
  migration(
    "20260102000000_alter_users_table.ts",
    `    await schema.table("users", (table) => {
      table.dropColumn("age");
      table.string("phone").nullable();
    });`,
  );
  logs.length = 0;
}

describe("reviewing changes to existing files", () => {
  it("sync:model shows the diff and what it affects, and keeps nothing when declined", async () => {
    await project();
    const before = read("src/models/user.model.ts");
    const confirm = vi.fn(async () => false);

    expect(await runCli(["sync:model", "user"], { cwd: tmp, confirm })).toBe(0);

    expect(confirm).toHaveBeenCalledWith(
      "Apply these changes to 1 existing file?",
    );
    expect(read("src/models/user.model.ts")).toBe(before);
    const text = out();
    expect(text).toMatch(/~ changed\s+src\/models\/user\.model\.ts/);
    expect(text).toContain("-   age!: number;");
    expect(text).toContain("+   phone!: string | null;");
    expect(text).toContain("Can affect:");
    expect(text).toContain("src/services/user.service.ts imports it");
    expect(text).toContain("line 5 uses .age, which is removed");
    expect(text).toContain("Cancelled: nothing was changed.");
    // The command's own messages are held back, so "Model synced" never shows.
    expect(text).not.toContain("Model synced");
  });

  it("applies the changes when confirmed", async () => {
    await project();
    expect(
      await runCli(["s:m", "user"], { cwd: tmp, confirm: async () => true }),
    ).toBe(0);
    const model = read("src/models/user.model.ts");
    expect(model).toContain("phone!: string | null;");
    expect(model).not.toMatch(/\n[ \t]*\n[ \t]*\n/); // no double blank line where age was
    expect(out()).toContain("Model synced: src/models/user.model.ts");
  });

  it("does not ask with --yes", async () => {
    await project();
    const confirm = vi.fn(async () => false);
    expect(
      await runCli(["sync:model", "user", "--yes"], { cwd: tmp, confirm }),
    ).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(read("src/models/user.model.ts")).toContain("phone");
  });

  it("keeps the old update:model name working", async () => {
    await project();
    expect(await runCli(["update:model", "user", "-y"], { cwd: tmp })).toBe(0);
    expect(read("src/models/user.model.ts")).toContain("phone");
  });

  it("make:* --force asks before overwriting, and removes the new files it made when declined", async () => {
    write("src/users/controllers/user.controller.ts", "// mine\n");
    migration(
      "20260101000000_create_users_table.ts",
      `    await schema.create("users", (table) => {
      table.id();
      table.string("email");
    });`,
    );
    const confirm = vi.fn(async () => false);
    expect(
      await runCli(
        ["make:controller", "users/user", "-m", "users/user", "-f"],
        { cwd: tmp, confirm },
      ),
    ).toBe(0);

    expect(confirm).toHaveBeenCalledOnce();
    expect(read("src/users/controllers/user.controller.ts")).toBe("// mine\n");
    // The model, DTO and service it created along the way are gone again, with their folders.
    expect(fs.readdirSync(file("src/users"))).toEqual(["controllers"]);
    expect(out()).toMatch(/\+ new\s+src\/users\/services\/user\.service\.ts/);
    expect(out()).toContain("- // mine");
  });

  it("doesn't ask when a command only creates new files", async () => {
    const confirm = vi.fn(async () => false);
    expect(
      await runCli(["make:service", "billing"], { cwd: tmp, confirm }),
    ).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(file("src/services/billing.service.ts"))).toBe(true);
    expect(out()).toContain("Service created: src/services/billing.service.ts");
  });

  it("doesn't ask when an overwrite changes nothing", async () => {
    expect(await runCli(["make:service", "billing"], { cwd: tmp })).toBe(0);
    const confirm = vi.fn(async () => false);
    expect(
      await runCli(["make:service", "billing", "-f"], { cwd: tmp, confirm }),
    ).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("diff helpers", () => {
  it("diffs lines", () => {
    const ops = diffLines("a\nb\nc", "a\nc\nd");
    expect(ops.map((o) => o.kind + o.text)).toEqual([" a", "-b", " c", "+d"]);
  });

  it("reads class members and their types", () => {
    const m = members(`export class User extends Model {
  @Column()
  email!: string;

  phone?: string | null;

  async find(id: number) {}
}`);
    expect([...m]).toEqual([
      ["email", "string"],
      ["phone", "string | null"],
      ["find", "method"],
    ]);
  });
});
