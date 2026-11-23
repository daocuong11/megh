import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import {
  Model,
  belongsTo,
  belongsToMany,
  hasMany,
  hasOne,
  type Row,
} from "./index";

/** `with(path, q => …)` and `with({ … })`: constrained eager loading. */

// ─── Models ──────────────────────────────────────────────────────────────────

class User extends Model {
  static readonly table = "users";

  id: number;
  name: string;
  role: string;
  password: string;

  todos = hasMany(() => Todo);
  profile = hasOne(() => Profile);
  tags = belongsToMany(() => Tag);
}

class Profile extends Model {
  static readonly table = "profiles";

  id: number;
  user_id: number;
  bio: string;
}

class Todo extends Model {
  static readonly table = "todos";
  static readonly softDeletes = true;

  id: number;
  user_id: number;
  title: string;
  priority: number;
  deleted_at: Date | null;

  user = belongsTo(() => User);
  steps = hasMany(() => Step);
}

class Step extends Model {
  static readonly table = "steps";

  id: number;
  todo_id: number;
  body: string;
}

class Tag extends Model {
  static readonly table = "tags";

  id: number;
  name: string;
}

// ─── Harness ─────────────────────────────────────────────────────────────────

const queries: string[] = [];
let db: Kysely<any>;

beforeAll(async () => {
  db = new Kysely<any>({
    dialect: new SqliteDialect({ database: new Database(":memory:") }),
    log: (e) => {
      if (e.level === "query") queries.push(e.query.sql.replace(/"/g, ""));
    },
  });
  for (const ddl of [
    sql`create table users (id integer primary key autoincrement, name text not null, role text not null, password text not null)`,
    sql`create table profiles (id integer primary key autoincrement, user_id integer not null, bio text not null)`,
    sql`create table todos (id integer primary key autoincrement, user_id integer not null, title text not null, priority integer not null, deleted_at text)`,
    sql`create table steps (id integer primary key autoincrement, todo_id integer not null, body text not null)`,
    sql`create table tags (id integer primary key autoincrement, name text not null)`,
    sql`create table tag_user (user_id integer not null, tag_id integer not null, id integer)`,
  ]) {
    await ddl.execute(db);
  }
  Model.useConnection(db);
});

afterAll(async () => {
  await db.destroy();
});

let ann: Row<User>;
let bob: Row<User>;

beforeEach(async () => {
  for (const table of [
    "users",
    "profiles",
    "todos",
    "steps",
    "tags",
    "tag_user",
  ]) {
    await sql`delete from ${sql.table(table)}`.execute(db);
  }
  await sql`delete from sqlite_sequence`.execute(db);

  ann = await User.create({ name: "Ann", role: "admin", password: "h1" });
  bob = await User.create({ name: "Bob", role: "dev", password: "h2" });
  await Profile.create({ user_id: ann.id, bio: "hi" });
  const a1 = await Todo.create({ user_id: ann.id, title: "a1", priority: 1 });
  await Todo.create({ user_id: ann.id, title: "a2", priority: 3 });
  await Todo.create({ user_id: ann.id, title: "a3", priority: 2 });
  await Todo.create({ user_id: bob.id, title: "b1", priority: 5 });
  await Todo.create({ user_id: bob.id, title: "b2", priority: 4 });
  const gone = await Todo.create({ user_id: bob.id, title: "b3", priority: 9 });
  await gone.delete();
  await Model.db()
    .insertInto("steps")
    .values([
      { todo_id: a1.id, body: "one" },
      { todo_id: a1.id, body: "two" },
    ])
    .execute();
  const tags = await Model.db()
    .insertInto("tags")
    .values([{ name: "go" }, { name: "rust" }, { name: "zig" }])
    .returningAll()
    .execute();
  // The pivot's `id` column also exists on tags: ordering must not be ambiguous.
  await Model.db()
    .insertInto("tag_user")
    .values([
      { user_id: ann.id, tag_id: tags[0].id, id: 100 },
      { user_id: ann.id, tag_id: tags[1].id, id: 101 },
      { user_id: ann.id, tag_id: tags[2].id, id: 102 },
      { user_id: bob.id, tag_id: tags[1].id, id: 103 },
    ])
    .execute();
  queries.length = 0;
});

const titles = (rows: { title: string }[]) => rows.map((r) => r.title);

// ─── select ──────────────────────────────────────────────────────────────────

describe("with(path, q => q.select(…))", () => {
  it("loads only the selected columns of a belongsTo relation", async () => {
    const page = await Todo.with("user", (q) => q.select("name", "role"))
      .orderBy("id")
      .paginate({ perPage: 2 });

    expect(page.meta.total).toBe(5);
    expect(page.data[0].toJSON()).toEqual({
      id: 1,
      user_id: ann.id,
      title: "a1",
      priority: 1,
      deleted_at: null,
      user: { id: ann.id, name: "Ann", role: "admin" },
    });
    expect(queries).toContain(
      "select name, role, id from users where id in (?)",
    );

    const user = page.data[0].user!;
    expect(user.name).toBe("Ann");
    // @ts-expect-error not selected
    void user.password;
  });

  it("keeps the foreign key a hasMany relation is matched by", async () => {
    const [user] = await User.with("todos", (q) => q.select("title"))
      .where("id", ann.id)
      .get();

    expect(user.todos.map((t) => t.toJSON())).toEqual([
      { title: "a1", id: 1, user_id: ann.id },
      { title: "a2", id: 2, user_id: ann.id },
      { title: "a3", id: 3, user_id: ann.id },
    ]);
    // @ts-expect-error not selected
    void user.todos[0].priority;
  });

  it("works with select() on the parent", async () => {
    const [todo] = await Todo.query()
      .select("title")
      .with("user", (q) => q.select("name"))
      .orderBy("id")
      .limit(1)
      .get();
    // The parent keeps the foreign key the relation needs.
    expect(todo.toJSON()).toEqual({
      title: "a1",
      id: 1,
      user_id: ann.id,
      user: { name: "Ann", id: ann.id },
    });
  });
});

// ─── other constraints ───────────────────────────────────────────────────────

describe("with(path, constrain)", () => {
  it("filters and orders the related rows", async () => {
    const users = await User.with("todos", (q) =>
      q.where("priority", ">=", 2).orderBy("priority", "desc"),
    )
      .orderBy("id")
      .get();
    expect(users.map((u) => titles(u.todos))).toEqual([
      ["a2", "a3"],
      ["b1", "b2"],
    ]);
  });

  it("limits and offsets each parent's rows, not the total", async () => {
    const users = await User.with("todos", (q) =>
      q.orderBy("priority", "desc").limit(1),
    )
      .orderBy("id")
      .get();
    expect(users.map((u) => titles(u.todos))).toEqual([["a2"], ["b1"]]);
    expect(queries[1]).toContain(
      "row_number() over(partition by todos.user_id order by priority desc) as megh_rn",
    );

    const second = await User.with("todos", (q) =>
      q.orderBy("priority", "desc").offset(1).limit(1),
    )
      .orderBy("id")
      .get();
    expect(second.map((u) => titles(u.todos))).toEqual([["a3"], ["b2"]]);
  });

  it("orders by the primary key when a limit has no order", async () => {
    const users = await User.with("todos", (q) => q.limit(2))
      .orderBy("id")
      .get();
    expect(users.map((u) => titles(u.todos))).toEqual([
      ["a1", "a2"],
      ["b1", "b2"],
    ]);
  });

  it("keeps the soft-delete scope, and withTrashed() lifts it", async () => {
    const [, withoutTrashed] = await User.with("todos", (q) => q.orderBy("id"))
      .orderBy("id")
      .get();
    expect(titles(withoutTrashed.todos)).toEqual(["b1", "b2"]);

    const [, withTrashed] = await User.with("todos", (q) =>
      q.withTrashed().orderBy("id"),
    )
      .orderBy("id")
      .get();
    expect(titles(withTrashed.todos)).toEqual(["b1", "b2", "b3"]);
  });

  it("takes whereHas() and withCount() inside the constraint", async () => {
    const [user] = await User.with("todos", (q) =>
      q.whereHas("steps").withCount("steps"),
    )
      .where("id", ann.id)
      .get();
    expect(user.todos).toHaveLength(1);
    expect(user.todos[0].steps_count).toBe(2);
  });

  it("loads relations nested inside the constraint", async () => {
    const [user] = await User.with("todos", (q) =>
      q.select("title").with("steps", (s) => s.select("body")),
    )
      .where("id", ann.id)
      .get();
    expect(user.todos[0].steps.map((s) => s.toJSON())).toEqual([
      { body: "one", id: 1, todo_id: 1 },
      { body: "two", id: 2, todo_id: 1 },
    ]);
    // @ts-expect-error not selected
    void user.todos[0].steps[0].todo;
  });

  it("constrains the last relation of a dotted path", async () => {
    const [user] = await User.with("todos.steps", (q) => q.where("body", "two"))
      .where("id", ann.id)
      .get();
    expect(titles(user.todos)).toEqual(["a1", "a2", "a3"]);
    expect(user.todos[0].steps.map((s) => s.body)).toEqual(["two"]);
  });

  it("combines constrained and plain paths to one relation", async () => {
    const [user] = await User.with("todos", (q) => q.where("title", "a1"))
      .with("todos.steps")
      .where("id", ann.id)
      .get();
    expect(titles(user.todos)).toEqual(["a1"]);
    expect(user.todos[0].steps).toHaveLength(2);
  });

  it("constrains hasOne relations", async () => {
    const [user] = await User.with("profile", (q) => q.select("bio"))
      .where("id", ann.id)
      .get();
    expect(user.profile?.toJSON()).toEqual({
      bio: "hi",
      id: 1,
      user_id: ann.id,
    });
  });
});

// ─── belongsToMany ───────────────────────────────────────────────────────────

describe("with(belongsToMany, constrain)", () => {
  it("selects, filters, orders and limits through the pivot table", async () => {
    const users = await User.with("tags", (q) =>
      q
        .select("name")
        .where("name", "!=", "go")
        .orderBy("name", "desc")
        .limit(1),
    )
      .orderBy("id")
      .get();
    expect(users.map((u) => u.tags.map((t) => t.name))).toEqual([
      ["zig"],
      ["rust"],
    ]);
    expect(users[0].tags[0].toJSON()).toEqual({
      name: "zig",
      id: 3,
      pivot: { user_id: ann.id, tag_id: 3 },
    });
    // @ts-expect-error pivot rows keep their type
    void users[0].tags[0].pivot.nope;
  });

  it("orders by the related table, not the pivot's same-named column", async () => {
    const [user] = await User.with("tags", (q) => q.orderBy("id", "desc"))
      .where("id", ann.id)
      .get();
    expect(user.tags.map((t) => t.name)).toEqual(["zig", "rust", "go"]);
  });
});

// ─── with({ … }) ─────────────────────────────────────────────────────────────

describe("with({ path: constrain })", () => {
  it("constrains several relations at once", async () => {
    const [user] = await User.with({
      todos: (q) => q.select("title").orderBy("priority").limit(2),
      profile: (q) => q.select("bio"),
    })
      .where("id", ann.id)
      .get();
    expect(titles(user.todos)).toEqual(["a1", "a3"]);
    expect(user.profile?.bio).toBe("hi");
    // @ts-expect-error not selected
    void user.todos[0].priority;
  });

  it("works on a query", async () => {
    const todos = await Todo.query()
      .with({ user: (q) => q.select("name") })
      .orderBy("id")
      .get();
    expect(todos.map((t) => t.user?.name)).toEqual([
      "Ann",
      "Ann",
      "Ann",
      "Bob",
      "Bob",
    ]);
  });

  it("rejects unknown relation paths", () => {
    // @ts-expect-error not a relation
    expect(() => User.with({ name: (q: any) => q }).get()).rejects.toThrow(
      /no relation "name"/,
    );
  });
});
