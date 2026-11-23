import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  DummyDriver,
  Kysely,
  MssqlAdapter,
  MssqlIntrospector,
  MssqlQueryCompiler,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import { DB } from "./db";
import { Model, hasMany } from "./index";

/**
 * SQL the newer query features send on PostgreSQL, MySQL and SQL Server,
 * compiled against connections that run nothing. orm-advanced.test.ts runs
 * them on SQLite.
 */

class Author extends Model {
  static readonly table = "authors";
  id: number;
  name: string;
  books = hasMany(() => Book);
}

class Book extends Model {
  static readonly table = "books";
  id: number;
  author_id: number;
  title: string;
  year: number | null;
}

const DIALECTS = {
  postgres: [PostgresAdapter, PostgresQueryCompiler, PostgresIntrospector],
  mysql: [MysqlAdapter, MysqlQueryCompiler, MysqlIntrospector],
  mssql: [MssqlAdapter, MssqlQueryCompiler, MssqlIntrospector],
} as const;

/** A driver that runs nothing; the first select returns `rows`, later ones nothing. */
class FirstRowsDriver extends DummyDriver {
  constructor(private rows: Record<string, unknown>[]) {
    super();
  }

  override async acquireConnection(): Promise<any> {
    return {
      executeQuery: async () => {
        const rows = this.rows;
        this.rows = [];
        return { rows };
      },

      streamQuery: async function* () {
        return;
      },
    };
  }
}

// A connection that runs nothing and records the SQL it is sent.
function fake(
  dialect: keyof typeof DIALECTS,
  firstRows: Record<string, unknown>[] = [],
): string[] {
  const [Adapter, Compiler, Introspector] = DIALECTS[dialect];
  const statements: string[] = [];
  Model.useConnection(
    new Kysely<any>({
      dialect: {
        createAdapter: () => new Adapter(),
        createDriver: () => new FirstRowsDriver(firstRows),
        createIntrospector: (k) => new Introspector(k as any),
        createQueryCompiler: () => new Compiler(),
      },
      log: (event) => {
        // Identifier quotes stripped, so expectations read as plain SQL.
        if (event.level === "query") {
          statements.push(event.query.sql.replace(/["`[\]]/g, ""));
        }
      },
    }),
  );
  return statements;
}

describe("upsert", () => {
  const rows = [
    { sku: "A", amount: 1 },
    { sku: "B", amount: 2 },
  ];

  it("uses ON CONFLICT on PostgreSQL", async () => {
    const sql = fake("postgres");
    await DB.table("prices").upsert(rows, "sku");
    expect(sql[0]).toBe(
      "insert into prices (sku, amount) values ($1, $2), ($3, $4) on conflict (sku) do update set amount = excluded.amount",
    );
    await DB.table("prices").upsert(rows, "sku", []);
    expect(sql[1]).toContain("on conflict (sku) do nothing");
  });

  it("uses ON DUPLICATE KEY UPDATE on MySQL", async () => {
    const sql = fake("mysql");
    await DB.table("prices").upsert(rows, "sku");
    expect(sql[0]).toBe(
      "insert into prices (sku, amount) values (?, ?), (?, ?) on duplicate key update amount = values(amount)",
    );
    await DB.table("prices").upsert(rows, "sku", []);
    expect(sql[1]).toContain("on duplicate key update sku = sku");
  });

  it("uses MERGE on SQL Server", async () => {
    const sql = fake("mssql");
    await DB.table("prices").upsert(rows, ["sku"]);
    expect(sql[0]).toBe(
      "merge into prices as megh_target using (select @1 as sku, @2 as amount union all select @3 as sku, @4 as amount) as megh_source on megh_target.sku = megh_source.sku when matched then update set amount = megh_source.amount when not matched then insert (sku, amount) values (megh_source.sku, megh_source.amount);",
    );
  });
});

describe("locks", () => {
  it("adds FOR UPDATE / FOR SHARE on PostgreSQL and MySQL", async () => {
    for (const dialect of ["postgres", "mysql"] as const) {
      const sql = fake(dialect);
      await Author.query().lockForUpdate().skipLocked().get();
      await DB.table("authors").sharedLock().noWait().get();
      expect(sql[0]).toMatch(/for update skip locked$/);
      expect(sql[1]).toMatch(/for share nowait$/);
    }
  });

  it("refuses them on SQL Server", async () => {
    fake("mssql");
    await expect(Author.query().lockForUpdate().get()).rejects.toThrow(
      /aren't supported on SQL Server/,
    );
    await expect(DB.table("authors").lockForUpdate().get()).rejects.toThrow(
      /aren't supported on SQL Server/,
    );
  });
});

describe("distinctOn", () => {
  it("works on PostgreSQL only", async () => {
    const sql = fake("postgres");
    await Book.query().distinctOn("author_id").orderBy("author_id").get();
    expect(sql[0]).toBe(
      "select distinct on (author_id) * from books order by author_id asc",
    );
    fake("mysql");
    await expect(Book.query().distinctOn("author_id").get()).rejects.toThrow(
      /PostgreSQL only/,
    );
  });
});

describe("recursive CTEs", () => {
  const tree = () =>
    DB.table("tree")
      .withRecursiveExpression(
        "tree",
        DB.table("categories").where("id", 1),
        DB.table("categories")
          .select("categories.*")
          .join("tree", "tree.id", "categories.parent_id"),
      )
      .get();

  it("say WITH RECURSIVE on PostgreSQL and MySQL", async () => {
    for (const dialect of ["postgres", "mysql"] as const) {
      const sql = fake(dialect);
      await tree();
      expect(sql[0]).toMatch(
        /^with recursive tree as \(select \* from categories where id = .+ union all select categories\.\* from categories inner join tree on tree\.id = categories\.parent_id\) select \* from tree$/,
      );
    }
  });

  it("say WITH on SQL Server, whose CTEs recurse without the keyword", async () => {
    const sql = fake("mssql");
    await tree();
    expect(sql[0]).toMatch(/^with tree as \(/);
  });
});

describe("portable SQL", () => {
  it("orders NULLs last with CASE, which every database accepts", async () => {
    const sql = fake("mysql");
    await Book.query().orderBy("year", "desc", "last").get();
    expect(sql[0]).toBe(
      "select * from books order by case when year is null then 1 else 0 end, year desc",
    );
  });

  it("selects withExists() as CASE, since SQL Server has no boolean columns", async () => {
    const sql = fake("mssql");
    await Author.query().withExists("books").get();
    expect(sql[0]).toBe(
      "select *, case when exists (select 1 as one from books as megh_r1 where megh_r1.author_id = authors.id) then 1 else 0 end as books_exists from authors",
    );
  });

  it("orders the per-parent window on SQL Server, which requires it", async () => {
    const sql = fake("mssql", [{ id: 1, name: "Ann" }]);
    await Author.with("books", (q) => q.limit(2)).get();
    expect(sql[1]).toBe(
      "select megh_w.* from (select *, row_number() over(partition by books.author_id order by books.id) as megh_rn from books where author_id in (@1)) as megh_w where megh_w.megh_rn > @2 and megh_w.megh_rn <= @3 order by megh_w.megh_rn",
    );
  });
});
