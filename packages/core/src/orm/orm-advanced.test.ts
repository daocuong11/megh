import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import {
  Column,
  DB,
  Model,
  ModelQuery,
  MorphMany,
  PrimaryKey,
  Table,
  belongsTo,
  hasMany,
  hasManyThrough,
  hasOneThrough,
  modelSchema,
  morphMany,
  morphOne,
  morphTo,
  type Row,
} from "./index";

/**
 * Query builder parity, model features and the newer relation kinds, run
 * on SQLite. Dialect-specific SQL is in orm-dialect-sql.test.ts.
 */

// ─── Models ──────────────────────────────────────────────────────────────────

class Country extends Model {
  static readonly table = "countries";

  id: number;
  name: string;

  users = hasMany(() => User);
  posts = hasManyThrough(
    () => Post,
    () => User,
  );
  firstPost = hasOneThrough(
    () => Post,
    () => User,
  );
}

class User extends Model {
  static readonly table = "users";
  static readonly timestamps = true;
  static readonly softDeletes = true;
  static readonly hidden = ["password"];
  static readonly appends = ["label"];
  static readonly casts = { admin: "boolean" } as const;

  id: number;
  country_id: number | null;
  name: string;
  password: string;
  admin: boolean;
  score: number;
  nickname: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;

  posts = hasMany(() => Post);
  country = belongsTo(() => Country);
  comments = morphMany(() => Comment, "commentable");
  avatar = morphOne(() => Image, "imageable");

  get label(): string {
    return `${this.name}${this.admin ? " (admin)" : ""}`;
  }
}

class Post extends Model {
  static readonly table = "posts";
  static readonly globalScopes = {
    visible: (q: ModelQuery<Post>) => q.where("hidden", false),
  };
  static readonly casts = { hidden: "boolean" } as const;

  id: number;
  user_id: number;
  title: string;
  views: number;
  hidden: boolean;

  user = belongsTo(() => User);
  comments = morphMany(() => Comment, "commentable");
}

class Video extends Model {
  static readonly table = "videos";
  static readonly morphType = "video";

  id: number;
  title: string;

  comments = morphMany(() => Comment, "commentable");
}

class Comment extends Model {
  static readonly table = "comments";

  id: number;
  commentable_id: number;
  commentable_type: string;
  body: string;

  commentable = morphTo(() => [Post, Video, User]);
}

class Image extends Model {
  static readonly table = "images";

  id: number;
  imageable_id: number;
  imageable_type: string;
  url: string;
}

class Price extends Model {
  static readonly table = "prices";
  static readonly timestamps = true;

  id: number;
  sku: string;
  amount: number;
  created_at: Date;
  updated_at: Date;
}

class Category extends Model {
  static readonly table = "categories";

  id: number;
  parent_id: number | null;
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
    sql`create table countries (id integer primary key autoincrement, name text not null)`,
    sql`create table users (id integer primary key autoincrement, country_id integer, name text not null, password text not null default '', admin integer not null default 0, score integer not null default 0, nickname text, created_at text, updated_at text, deleted_at text)`,
    sql`create table posts (id integer primary key autoincrement, user_id integer not null, title text not null, views integer not null default 0, hidden integer not null default 0)`,
    sql`create table videos (id integer primary key autoincrement, title text not null)`,
    sql`create table comments (id integer primary key autoincrement, commentable_id integer not null, commentable_type text not null, body text not null)`,
    sql`create table images (id integer primary key autoincrement, imageable_id integer not null, imageable_type text not null, url text not null)`,
    sql`create table prices (id integer primary key autoincrement, sku text not null unique, amount integer not null, created_at text, updated_at text)`,
    sql`create table categories (id integer primary key autoincrement, parent_id integer, name text not null)`,
  ]) {
    await ddl.execute(db);
  }
  Model.useConnection(db);
});

afterAll(async () => {
  await db.destroy();
});

let my: Row<Country>;
let ann: Row<User>;
let bob: Row<User>;
let cat: Row<User>;

beforeEach(async () => {
  for (const table of [
    "countries",
    "users",
    "posts",
    "videos",
    "comments",
    "images",
    "prices",
    "categories",
  ]) {
    await sql`delete from ${sql.table(table)}`.execute(db);
  }
  await sql`delete from sqlite_sequence`.execute(db);

  my = await Country.create({ name: "Malaysia" });
  const bd = await Country.create({ name: "Bangladesh" });
  ann = await User.create({
    name: "Ann",
    password: "h1",
    admin: true,
    score: 10,
    country_id: my.id,
  });
  bob = await User.create({
    name: "Bob",
    password: "h2",
    admin: false,
    score: 5,
    country_id: my.id,
    nickname: "bobby",
  });
  cat = await User.create({
    name: "Cat",
    password: "h3",
    admin: false,
    score: 7,
    country_id: bd.id,
  });
  await Model.db()
    .insertInto("posts")
    .values([
      { user_id: ann.id, title: "a1", views: 10, hidden: 0 },
      { user_id: ann.id, title: "a2", views: 30, hidden: 0 },
      { user_id: ann.id, title: "secret", views: 99, hidden: 1 },
      { user_id: bob.id, title: "b1", views: 20, hidden: 0 },
      { user_id: cat.id, title: "c1", views: 5, hidden: 0 },
    ])
    .execute();
  await Video.create({ title: "v1" });
  await Model.db()
    .insertInto("comments")
    .values([
      { commentable_id: 1, commentable_type: "posts", body: "on a1" },
      { commentable_id: 1, commentable_type: "posts", body: "again a1" },
      { commentable_id: 1, commentable_type: "video", body: "on v1" },
      { commentable_id: ann.id, commentable_type: "users", body: "on ann" },
    ])
    .execute();
  await Model.db()
    .insertInto("images")
    .values({ imageable_id: bob.id, imageable_type: "users", url: "bob.png" })
    .execute();
  queries.length = 0;
});

const names = (rows: { name: string }[]) => rows.map((r) => r.name);
const titles = (rows: { title: string }[]) => rows.map((r) => r.title);

// ─── where ───────────────────────────────────────────────────────────────────

describe("where clauses", () => {
  it("groups orWhere() so the soft-delete scope still applies", async () => {
    await bob.delete();
    const rows = await User.where("name", "Ann")
      .orWhere("name", "Bob")
      .orderBy("id")
      .get();
    expect(names(rows)).toEqual(["Ann"]);
    expect(queries.at(-1)).toContain(
      "where (name = ? or name = ?) and deleted_at is null",
    );
  });

  it("binds and tighter than or", async () => {
    const rows = await User.where("admin", false)
      .where("score", ">", 6)
      .orWhere("name", "Ann")
      .orderBy("id")
      .get();
    expect(names(rows)).toEqual(["Ann", "Cat"]);
  });

  it("has between, column, raw and null helpers", async () => {
    expect(
      names(
        await User.query().whereBetween("score", [6, 10]).orderBy("id").get(),
      ),
    ).toEqual(["Ann", "Cat"]);
    expect(
      names(await User.query().whereNotBetween("score", [6, 10]).get()),
    ).toEqual(["Bob"]);
    expect(
      names(
        await User.query().whereColumn("score", ">", "id").orderBy("id").get(),
      ),
    ).toEqual(["Ann", "Bob", "Cat"]);
    expect(
      names(
        await User.query()
          .whereRaw("lower(name) = ?", ["bob"])
          .orWhereRaw("score = ?", [7])
          .orderBy("id")
          .get(),
      ),
    ).toEqual(["Bob", "Cat"]);
    expect(
      names(
        await User.where("name", "Ann")
          .orWhereNotNull("nickname")
          .orderBy("id")
          .get(),
      ),
    ).toEqual(["Ann", "Bob"]);
  });

  it("takes subqueries in whereIn() and whereExists()", async () => {
    const authors = DB.table("posts").select("user_id").where("views", ">", 15);
    expect(
      names(await User.query().whereIn("id", authors).orderBy("id").get()),
    ).toEqual(["Ann", "Bob"]);
    const malaysians = Country.where("name", "Malaysia");
    const ids = await User.query()
      .whereIn("country_id", (malaysians as any).select("id"))
      .pluck("id");
    expect(ids).toEqual([ann.id, bob.id]);
    expect(
      names(
        await User.query()
          .whereNotExists(
            DB.table("posts").whereColumn("posts.user_id", "=", "users.id"),
          )
          .get(),
      ),
    ).toEqual([]);
  });

  it("joins whereHas() with orWhereHas()", async () => {
    const rows = await User.whereHas("avatar")
      .orWhereHas("comments")
      .orderBy("id")
      .get();
    expect(names(rows)).toEqual(["Ann", "Bob"]);
  });

  it("keeps a relation query to its parent under orWhere()", async () => {
    const rows = await bob
      .related("posts")
      .query()
      .where("title", "nope")
      .orWhere("views", ">", 0)
      .get();
    expect(titles(rows)).toEqual(["b1"]);
  });

  it("applies when()", async () => {
    const search = (term?: string) =>
      User.query()
        .when(term, (q, t) => q.where("name", t))
        .count();
    expect(await search("Ann")).toBe(1);
    expect(await search(undefined)).toBe(3);
  });
});

// ─── select, grouping, joins ─────────────────────────────────────────────────

describe("select, group and join", () => {
  it("selectRaw() adds values save() never writes", async () => {
    const [user] = await User.query()
      .select("id", "name", "score")
      .selectRaw<{ doubled: number }>("score * 2 as doubled")
      .where("id", ann.id)
      .get();
    expect(user.doubled).toBe(20);
    expect(user.toJSON()).toMatchObject({ doubled: 20 });
    user.score = 11;
    await user.save();
    expect(queries.at(-1)).not.toContain("doubled");
    expect(() => User.query().selectRaw("score * 2")).toThrow(/needs an alias/);
  });

  it("groups and counts grouped rows", async () => {
    const rows = await Post.query()
      .select("user_id")
      .selectRaw<{ total: number }>("sum(views) as total")
      .groupBy("user_id")
      .having("user_id", "<", 3)
      .orderBy("user_id")
      .get();
    expect(rows.map((r) => [r.user_id, r.total])).toEqual([
      [ann.id, 40],
      [bob.id, 20],
    ]);
    expect(
      await Post.query().select("user_id").groupBy("user_id").count(),
    ).toBe(3);
    expect(await Post.query().select("user_id").distinct().count()).toBe(3);
  });

  it("joins another table and orders by its columns", async () => {
    const rows = await Post.query()
      .join("users", "users.id", "posts.user_id")
      .where("users.name", "!=", "Cat")
      .orderBy("users.name", "desc")
      .orderBy("views")
      .get();
    expect(titles(rows)).toEqual(["b1", "a1", "a2"]);
    expect(rows[0].toJSON()).not.toHaveProperty("name");
    await expect(
      Post.query().join("users", "users.id", "posts.user_id").delete(),
    ).rejects.toThrow(/don't take join/);
  });

  it("plucks cast values", async () => {
    expect(await User.query().orderBy("id").pluck("admin")).toEqual([
      true,
      false,
      false,
    ]);
    expect(await User.where("name", "Bob").value("score")).toBe(5);
    expect(await User.where("name", "Zed").value("score")).toBeUndefined();
  });

  it("orders NULLs first or last", async () => {
    expect(
      names(
        await User.query()
          .orderBy("nickname", "asc", "last")
          .orderBy("id")
          .get(),
      ),
    ).toEqual(["Bob", "Ann", "Cat"]);
    expect(
      names(
        await User.query()
          .orderBy("nickname", "desc", "first")
          .orderBy("id")
          .get(),
      ),
    ).toEqual(["Ann", "Cat", "Bob"]);
  });

  it("unions queries on the model", async () => {
    const rows = await User.where("name", "Ann")
      .union(User.where("score", "<", 8))
      .orderBy("name")
      .get();
    expect(names(rows)).toEqual(["Ann", "Bob", "Cat"]);
    expect(
      await User.where("name", "Ann")
        .unionAll(User.where("admin", true))
        .count(),
    ).toBe(2);
  });

  it("orders by created_at with latest() and oldest()", async () => {
    await User.query().latest().get();
    expect(queries.at(-1)).toContain("order by created_at desc");
  });

  it("shows its SQL", () => {
    const { sql: text, parameters } = User.where("name", "Ann").toSQL();
    expect(text.replace(/"/g, "")).toBe(
      "select * from users where name = ? and deleted_at is null",
    );
    expect(parameters).toEqual(["Ann"]);
  });

  it("runs lockForUpdate() as a no-op on SQLite", async () => {
    const rows = await Model.transaction(() =>
      User.where("id", ann.id).lockForUpdate().skipLocked().get(),
    );
    expect(names(rows)).toEqual(["Ann"]);
  });
});

// ─── writes ──────────────────────────────────────────────────────────────────

describe("increment and decrement", () => {
  it("adjusts matching rows in one statement", async () => {
    expect(await User.where("admin", false).increment("score", 2)).toBe(2);
    expect(await User.query().orderBy("id").pluck("score")).toEqual([10, 7, 9]);
    await User.where("id", ann.id).decrement("score", 3, { nickname: "a" });
    expect(await User.where("id", ann.id).value("nickname")).toBe("a");
    expect(queries.some((q) => q.includes("score = score - ?"))).toBe(true);
  });

  it("adjusts an instance and its database row", async () => {
    await ann.increment("score", 5);
    expect(ann.score).toBe(15);
    expect(await User.where("id", ann.id).value("score")).toBe(15);
    await ann.decrement("score");
    expect((await ann.refresh()).score).toBe(14);
  });
});

// ─── aborting, chunking and streaming ────────────────────────────────────────

describe("abortSignal, chunk, lazy and stream", () => {
  it("rejects an aborted query", async () => {
    await expect(
      User.query().abortSignal(AbortSignal.abort()).get(),
    ).rejects.toThrow();
    await expect(
      DB.table("users").abortSignal(AbortSignal.abort()).get(),
    ).rejects.toThrow();
    expect(
      await User.query().abortSignal(new AbortController().signal).count(),
    ).toBe(3);
  });

  it("chunks by primary key and stops on false", async () => {
    const seen: string[][] = [];
    expect(
      await User.query().chunk(2, (rows) => {
        seen.push(names(rows));
      }),
    ).toBe(true);
    expect(seen).toEqual([["Ann", "Bob"], ["Cat"]]);
    expect(await User.query().chunk(1, () => false)).toBe(false);
    await expect(
      User.query()
        .orderBy("name")
        .chunk(1, () => {}),
    ).rejects.toThrow(/can't keep an orderBy/);
  });

  it("stays correct while the chunk callback updates rows", async () => {
    let pages = 0;
    await User.where("admin", false).chunk(1, async (rows) => {
      pages++;
      await User.where("id", rows[0].id).update({ admin: true });
    });
    expect(pages).toBe(2);
  });

  it("iterates lazily, relations included", async () => {
    const out: string[] = [];
    for await (const user of User.with("posts").lazy(2)) {
      out.push(`${user.name}:${user.posts.length}`);
    }
    expect(out).toEqual(["Ann:2", "Bob:1", "Cat:1"]);
  });

  it("streams rows", async () => {
    const out: string[] = [];
    for await (const user of User.query().orderBy("id").stream())
      out.push(user.name);
    expect(out).toEqual(["Ann", "Bob", "Cat"]);
    const iterate = async () => {
      for await (const _ of User.with("posts").stream()) void _;
    };
    await expect(iterate()).rejects.toThrow(/use lazy/);
  });
});

// ─── related aggregates ──────────────────────────────────────────────────────

describe("withSum, withAvg, withMin, withMax and withExists", () => {
  it("adds aggregates of related columns", async () => {
    const users = await User.query()
      .withSum("posts", "views")
      .withAvg("posts", "views")
      .withMin("posts", "views")
      .withMax("posts", "views")
      .withExists("avatar")
      .orderBy("id")
      .get();
    expect(
      users.map((u) => [
        u.posts_sum_views,
        u.posts_avg_views,
        u.posts_min_views,
        u.posts_max_views,
        u.avatar_exists,
      ]),
    ).toEqual([
      // The global scope on Post leaves out Ann's hidden post.
      [40, 20, 10, 30, false],
      [20, 20, 20, 20, true],
      [5, 5, 5, 5, false],
    ]);
    expect(users[0].toJSON()).toMatchObject({ posts_sum_views: 40 });
  });

  it("is null without related rows, and takes a constraint", async () => {
    const [user] = await User.query()
      .withSum("posts", "views", (q) => q.where("views", ">", 100))
      .withExists("posts", (q) => q.where("title", "a2"))
      .where("id", ann.id)
      .get();
    expect(user.posts_sum_views).toBeNull();
    expect(user.posts_exists).toBe(true);
  });

  it("aggregates through intermediate tables", async () => {
    const [country] = await Country.query()
      .withSum("posts", "views")
      .withCount("posts")
      .where("id", my.id)
      .get();
    expect([country.posts_sum_views, country.posts_count]).toEqual([60, 3]);
  });
});

// ─── hidden, visible and appends ─────────────────────────────────────────────

describe("toJSON visibility", () => {
  it("leaves out hidden columns and adds appended getters", async () => {
    const user = (await User.find(ann.id))!;
    const json = user.toJSON();
    expect(json).not.toHaveProperty("password");
    expect(json.label).toBe("Ann (admin)");
    expect(JSON.parse(JSON.stringify(user))).not.toHaveProperty("password");
    expect(user.password).toBe("h1");
  });

  it("applies to loaded relations", async () => {
    const [post] = await Post.with("user").where("title", "a1").get();
    expect(JSON.parse(JSON.stringify(post)).user).not.toHaveProperty(
      "password",
    );
    expect(post.toJSON().user).not.toHaveProperty("password");
  });

  it("can be changed per instance", async () => {
    const user = (await User.find(ann.id))!;
    expect(user.makeVisible("password").toJSON().password).toBe("h1");
    expect(user.makeHidden("name", "label").toJSON()).not.toHaveProperty(
      "name",
    );
    expect(user.toJSON()).not.toHaveProperty("label");
  });

  it("limits columns with visible", async () => {
    class Slim extends Model {
      static readonly table = "users";
      static readonly visible = ["name"];
      id: number;
      name: string;
      posts = hasMany(() => Post, "user_id");
    }
    const [slim] = await Slim.with("posts")
      .withCount("posts")
      .where("id", ann.id)
      .get();
    expect(Object.keys(slim.toJSON()).sort()).toEqual([
      "name",
      "posts",
      "posts_count",
    ]);
  });

  it("keeps hidden columns out of OpenAPI schemas", () => {
    @Table("accounts")
    class Account extends Model {
      static readonly hidden = ["secret"];
      @PrimaryKey() id: number;
      @Column() email: string;
      @Column() secret: string;
    }
    expect(Object.keys(modelSchema(Account)!.properties!)).toEqual([
      "id",
      "email",
    ]);
  });
});

// ─── events ──────────────────────────────────────────────────────────────────

describe("model events", () => {
  it("fires around create, update, delete and restore", async () => {
    const log: string[] = [];
    const events = [
      "saving",
      "creating",
      "created",
      "updating",
      "updated",
      "saved",
      "deleting",
      "deleted",
      "restoring",
      "restored",
    ] as const;
    const off = events.map((event) =>
      User.on(event, (user) => {
        log.push(`${event}:${user.name}`);
      }),
    );
    try {
      const dee = await User.create({
        name: "Dee",
        password: "x",
        score: 0,
        admin: false,
      });
      expect(log.splice(0)).toEqual([
        "saving:Dee",
        "creating:Dee",
        "created:Dee",
        "saved:Dee",
      ]);
      await dee.save(); // nothing changed
      expect(log.splice(0)).toEqual(["saving:Dee", "saved:Dee"]);
      dee.score = 1;
      await dee.save();
      expect(log.splice(0)).toEqual([
        "saving:Dee",
        "updating:Dee",
        "updated:Dee",
        "saved:Dee",
      ]);
      await dee.delete();
      await dee.restore();
      expect(log.splice(0)).toEqual([
        "deleting:Dee",
        "deleted:Dee",
        "restoring:Dee",
        "restored:Dee",
      ]);
    } finally {
      for (const unsubscribe of off) unsubscribe();
    }
    await User.create({ name: "Eve", password: "x", score: 0, admin: false });
    expect(log).toEqual([]);
  });

  it("lets -ing handlers change the model or stop the write", async () => {
    const offs = [
      User.on("creating", (user) => {
        user.name = user.name.toUpperCase();
      }),
      User.on("updating", (user) => {
        if (user.score < 0) throw new Error("no negative scores");
      }),
    ];
    try {
      const dee = await User.create({
        name: "dee",
        password: "x",
        score: 0,
        admin: false,
      });
      expect((await dee.refresh()).name).toBe("DEE");
      dee.score = -1;
      await expect(dee.save()).rejects.toThrow("no negative scores");
      expect((await dee.refresh()).score).toBe(0);
    } finally {
      for (const off of offs) off();
    }
  });
});

// ─── global scopes ───────────────────────────────────────────────────────────

describe("global scopes", () => {
  it("filter every query, relations included", async () => {
    expect(await Post.count()).toBe(4);
    const [user] = await User.with("posts")
      .withCount("posts")
      .where("id", ann.id)
      .get();
    expect(titles(user.posts)).toEqual(["a1", "a2"]);
    expect(user.posts_count).toBe(2);
    expect(
      names(await User.whereHas("posts", (q) => q.where("views", 99)).get()),
    ).toEqual([]);
  });

  it("can't be widened by orWhere()", async () => {
    const rows = await Post.where("title", "secret")
      .orWhere("title", "a1")
      .get();
    expect(titles(rows)).toEqual(["a1"]);
  });

  it("can be skipped", async () => {
    expect(await Post.withoutGlobalScope("visible").count()).toBe(5);
    expect(await Post.withoutGlobalScopes().count()).toBe(5);
    expect(await Post.query().withoutGlobalScopes(["visible"]).count()).toBe(5);
  });
});

// ─── create helpers and upsert ───────────────────────────────────────────────

describe("firstOrNew, firstOrCreate, updateOrCreate, createMany, insert and upsert", () => {
  it("finds or makes rows", async () => {
    const found = await User.firstOrNew({ name: "Ann" });
    expect(found.isPersisted()).toBe(true);
    const fresh = await User.firstOrNew(
      { name: "Dee" },
      { password: "p", admin: false },
    );
    expect([fresh.isPersisted(), fresh.password]).toEqual([false, "p"]);

    const created = await User.firstOrCreate(
      { name: "Dee" },
      { password: "p", admin: false },
    );
    expect(created.isPersisted()).toBe(true);
    expect((await User.firstOrCreate({ name: "Dee" })).id).toBe(created.id);

    const updated = await User.updateOrCreate({ name: "Dee" }, { score: 42 });
    expect([updated.id, updated.score]).toEqual([created.id, 42]);
    const made = await User.updateOrCreate(
      { name: "Fay" },
      { score: 1, password: "q", admin: false },
    );
    expect(made.isPersisted()).toBe(true);
  });

  it("creates many with events, or inserts many without", async () => {
    const rows = await Price.createMany([
      { sku: "A", amount: 1 },
      { sku: "B", amount: 2 },
    ]);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    await Price.insert([
      { sku: "C", amount: 3 },
      { sku: "D", amount: 4 },
    ]);
    const d = await Price.findBy("sku", "D");
    expect(d?.created_at).toBeInstanceOf(Date);
  });

  it("upserts by a unique column, keeping created_at", async () => {
    await Price.create({ sku: "A", amount: 1 });
    const before = (await Price.findBy("sku", "A"))!;
    await Price.upsert(
      [
        { sku: "A", amount: 10 },
        { sku: "B", amount: 20 },
      ],
      "sku",
    );
    const rows = await Price.query().orderBy("sku").get();
    expect(rows.map((r) => [r.sku, r.amount])).toEqual([
      ["A", 10],
      ["B", 20],
    ]);
    expect(rows[0].created_at).toEqual(before.created_at);
    expect(
      queries.some((q) => q.includes("on conflict (sku) do update set")),
    ).toBe(true);

    await Price.upsert({ sku: "A", amount: 99 }, "sku", []);
    expect((await Price.findBy("sku", "A"))!.amount).toBe(10);
  });

  it("upserts with DB.table()", async () => {
    await DB.table("categories").insert({ id: 1, name: "old" });
    await DB.table("categories").upsert(
      [
        { id: 1, name: "new" },
        { id: 2, name: "two" },
      ],
      "id",
    );
    expect(await DB.table("categories").orderBy("id").pluck("name")).toEqual([
      "new",
      "two",
    ]);
    await expect(
      DB.table("categories").upsert([{ id: 3, name: "x" }, { id: 4 }], "id"),
    ).rejects.toThrow(/same columns/);
  });
});

// ─── instance helpers ────────────────────────────────────────────────────────

describe("refresh, fresh, touch and replicate", () => {
  it("reloads and copies rows", async () => {
    await User.where("id", ann.id).update({ name: "Annie" });
    expect(ann.name).toBe("Ann");
    expect((await ann.fresh())?.name).toBe("Annie");
    expect(ann.name).toBe("Ann");
    await ann.refresh();
    expect(ann.name).toBe("Annie");

    const copy = ann.replicate(["score"]);
    expect([copy.isPersisted(), copy.id, copy.score, copy.name]).toEqual([
      false,
      undefined,
      undefined,
      "Annie",
    ]);
    await copy.fill({ name: "Annie 2" }).save();
    expect(copy.id).toBe(4);
  });

  it("touches updated_at", async () => {
    const before = ann.updated_at.getTime();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await ann.touch();
    expect(ann.updated_at.getTime()).toBeGreaterThan(before);
    expect((await ann.fresh())!.updated_at.getTime()).toBe(
      ann.updated_at.getTime(),
    );
  });
});

// ─── hasManyThrough / hasOneThrough ──────────────────────────────────────────

describe("hasManyThrough and hasOneThrough", () => {
  it("eager-loads through the intermediate table", async () => {
    const countries = await Country.with("posts")
      .with("firstPost")
      .orderBy("id")
      .get();
    expect(countries.map((c) => titles(c.posts))).toEqual([
      ["a1", "a2", "b1"],
      ["c1"],
    ]);
    expect(countries.map((c) => c.firstPost?.title)).toEqual(["a1", "c1"]);
    expect(queries[1]).toContain(
      "select posts.*, users.country_id as megh_through_key from posts inner join users on users.id = posts.user_id where users.country_id in (?, ?) and users.deleted_at is null",
    );
  });

  it("skips soft-deleted intermediate rows", async () => {
    await bob.delete();
    const [country] = await Country.with("posts").where("id", my.id).get();
    expect(titles(country.posts)).toEqual(["a1", "a2"]);
  });

  it("takes constraints and per-parent limits", async () => {
    const countries = await Country.with("posts", (q) =>
      q.select("title").orderBy("views", "desc").limit(2),
    )
      .orderBy("id")
      .get();
    expect(countries.map((c) => titles(c.posts))).toEqual([
      ["a2", "b1"],
      ["c1"],
    ]);
  });

  it("filters with whereHas()", async () => {
    const rows = await Country.whereHas("posts", (q) =>
      q.where("views", ">", 25),
    ).get();
    expect(names(rows)).toEqual(["Malaysia"]);
  });
});

// ─── polymorphic relations ───────────────────────────────────────────────────

describe("morphMany, morphOne and morphTo", () => {
  it("loads polymorphic children by id and type", async () => {
    const [post] = await Post.with("comments").where("id", 1).get();
    expect(post.comments.map((c) => c.body)).toEqual(["on a1", "again a1"]);
    const [video] = await Video.with("comments").get();
    expect(video.comments.map((c) => c.body)).toEqual(["on v1"]);
    const users = await User.with("avatar").orderBy("id").get();
    expect(users.map((u) => u.avatar?.url ?? null)).toEqual([
      null,
      "bob.png",
      null,
    ]);
  });

  it("loads the owner of each type with morphTo", async () => {
    const comments = await Comment.with("commentable").orderBy("id").get();
    expect(
      comments.map((c) => (c.commentable as any)?.constructor.name),
    ).toEqual(["Post", "Post", "Video", "User"]);
    expect((comments[2].commentable as Video).title).toBe("v1");
    expect(queries.filter((q) => q.startsWith("select"))).toHaveLength(4);
  });

  it("counts and filters polymorphic children", async () => {
    const posts = await Post.withCount("comments").whereHas("comments").get();
    expect(posts.map((p) => [p.title, p.comments_count])).toEqual([["a1", 2]]);
  });

  it("creates children with the id and type set", async () => {
    const comment = await bob.related("comments").create({ body: "hi bob" });
    expect([comment.commentable_id, comment.commentable_type]).toEqual([
      bob.id,
      "users",
    ]);
    expect((await bob.related("comments").get()).map((c) => c.body)).toEqual([
      "hi bob",
    ]);
    expect((await bob.related("avatar").get())?.url).toBe("bob.png");
  });

  it("rejects unknown types and whereHas() on morphTo", async () => {
    await Model.db()
      .insertInto("comments")
      .values({ commentable_id: 1, commentable_type: "nope", body: "?" })
      .execute();
    await expect(Comment.with("commentable").get()).rejects.toThrow(
      /no morphTo target has type "nope"/,
    );
    await expect(Comment.whereHas("commentable").get()).rejects.toThrow(
      /morphTo/,
    );
  });

  it("works with decorators", async () => {
    class Note extends Model {
      static readonly table = "videos";
      static readonly morphType = "video";
      id: number;
      @MorphMany(() => Comment, "commentable") comments?: Comment[];
    }
    const [note] = await Note.with("comments").get();
    expect(note.comments!.map((c) => c.body)).toEqual(["on v1"]);
  });
});

// ─── DB.table() additions ────────────────────────────────────────────────────

describe("DB.table() additions", () => {
  beforeEach(async () => {
    await DB.table("categories").insert([
      { id: 1, parent_id: null, name: "root" },
      { id: 2, parent_id: 1, name: "child" },
      { id: 3, parent_id: 2, name: "grandchild" },
      { id: 4, parent_id: null, name: "other" },
    ]);
  });

  it("walks a tree with a recursive CTE", async () => {
    const tree = await DB.table("tree")
      .withRecursiveExpression(
        "tree",
        DB.table("categories").where("id", 1),
        DB.table("categories")
          .select("categories.*")
          .join("tree", "tree.id", "categories.parent_id"),
      )
      .orderBy("id")
      .pluck("name");
    expect(tree).toEqual(["root", "child", "grandchild"]);
    // A model query can use the tree as a subquery.
    const ids = DB.table("tree")
      .withRecursiveExpression(
        "tree",
        DB.table("categories").where("id", 2),
        DB.table("categories")
          .select("categories.*")
          .join("tree", "tree.id", "categories.parent_id"),
      )
      .select("id");
    expect(
      await Category.query().whereIn("id", ids).orderBy("id").pluck("name"),
    ).toEqual(["child", "grandchild"]);
  });

  it("selects from a named CTE", async () => {
    const rows = await DB.table("roots")
      .withExpression("roots", DB.table("categories").whereNull("parent_id"))
      .count();
    expect(rows).toBe(2);
  });

  it("unions, orders NULLs and applies when()", async () => {
    const both = await DB.table("categories")
      .select("name")
      .where("id", 1)
      .union(DB.table("categories").select("name").where("id", 4))
      .orderBy("name")
      .pluck("name");
    expect(both).toEqual(["other", "root"]);
    expect(
      await DB.table("categories")
        .orderBy("parent_id", "asc", "last")
        .orderBy("id")
        .pluck("id"),
    ).toEqual([2, 3, 1, 4]);
    expect(
      await DB.table("categories")
        .when(false, (q) => q.where("id", 1))
        .count(),
    ).toBe(4);
  });

  it("chunks by id, streams, and takes subqueries", async () => {
    const pages: number[][] = [];
    await DB.table("categories")
      .where("id", 1)
      .orWhere("id", ">", 2)
      .chunkById(1, (rows) => {
        pages.push(rows.map((r) => r.id));
      });
    expect(pages).toEqual([[1], [3], [4]]);
    const streamed: string[] = [];
    for await (const row of DB.table("categories").orderBy("id").stream()) {
      streamed.push(row.name);
    }
    expect(streamed).toHaveLength(4);
    const parents = DB.table("categories")
      .select("parent_id")
      .whereNotNull("parent_id");
    expect(
      await DB.table("categories").whereIn("id", parents).pluck("id"),
    ).toEqual([1, 2]);
    expect(
      await DB.table("categories as c")
        .whereExists(
          DB.table("categories as k").whereColumn("k.parent_id", "=", "c.id"),
        )
        .pluck("c.name"),
    ).toEqual(["root", "child"]);
  });
});
