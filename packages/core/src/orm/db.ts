/**
 * The query builder, for queries that don't fit a model: reports, bulk
 * updates, tables without a model.
 *
 * ```ts
 * const rows = await DB.table("orders")
 *   .select("customer_id")
 *   .selectRaw("sum(total) as revenue")
 *   .where("status", "paid")
 *   .whereBetween("created_at", [from, to])
 *   .groupBy("customer_id")
 *   .orderBy("revenue", "desc")
 *   .limit(10)
 *   .get();
 * ```
 *
 * Queries run in the current `DB.transaction()` / `Model.transaction()` when
 * there is one. Values are always sent as parameters, never put in the SQL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Kysely's builders
   change type with every call; the chains here are built up in loops. */
import type { InflightQueryAbortStrategy, Kysely, Transaction } from "kysely";
import { NotFoundException, normalizePageRequest, paginated } from "./core";
import type { PageRequest, Paginated } from "./core";
import { bindable, isSqlite, usesAdapter } from "./casts";
import { getConnection, runInTransaction } from "./connection";
import { kysely } from "./engine";
import { applyPaging } from "./paging";

export type Operator =
  | "="
  | "!="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="
  | "like"
  | "not like"
  | "ilike"
  | "in"
  | "not in"
  | "is"
  | "is not";

const OPERATORS = new Set<string>([
  "=",
  "!=",
  "<>",
  "<",
  "<=",
  ">",
  ">=",
  "like",
  "not like",
  "ilike",
  "in",
  "not in",
  "is",
  "is not",
]);

type Row = Record<string, any>;
type Expr = (eb: any, sqlite: boolean) => any;
type Clause = { or: boolean; build: Expr };

function bind(value: unknown, sqlite: boolean): unknown {
  return Array.isArray(value)
    ? value.map((v) => bindable(v, sqlite))
    : bindable(value, sqlite);
}

/** A query usable as a subquery: `DB.table()` and model queries. */
interface Subquery {
  toKysely(): any;
}

function isSubquery(value: unknown): value is Subquery {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as any).toKysely === "function"
  );
}

/** SQL text with `?` placeholders, and the values for them. */
export function rawSql(text: string, bindings: readonly unknown[] = []) {
  const parts = text.split("?");
  if (parts.length - 1 !== bindings.length) {
    throw new Error(
      `[Megh ORM] The SQL has ${parts.length - 1} "?" placeholders but ${bindings.length} values were given.`,
    );
  }
  const strings = Object.assign([...parts], { raw: [...parts] });
  return kysely().sql(strings as unknown as TemplateStringsArray, ...bindings);
}

/** `where` conditions, shared by queries and nested groups. */
export class WhereClauses<Self> {
  /** @internal */
  protected clauses: Clause[] = [];

  private push(or: boolean, build: Expr): Self {
    this.clauses.push({ or, build });
    return this as unknown as Self;
  }

  private comparison(or: boolean, args: unknown[]): Self {
    if (typeof args[0] === "function") {
      const group = new WhereGroup();
      (args[0] as (q: WhereGroup) => void)(group);
      return this.push(or, (eb, sqlite) => group.toExpression(eb, sqlite));
    }
    if (args[0] !== null && typeof args[0] === "object") {
      const entries = Object.entries(args[0] as Row);
      return this.push(or, (eb, sqlite) =>
        eb.and(entries.map(([c, v]) => compare(eb, c, "=", v, sqlite))),
      );
    }
    const [column, opOrValue, maybe] = args as [string, unknown, unknown];
    const [op, value] =
      args.length >= 3
        ? [String(opOrValue).toLowerCase(), maybe]
        : ["=", opOrValue];
    if (!OPERATORS.has(op)) {
      throw new Error(
        `[Megh ORM] Unknown operator "${op}" in where("${column}", …).`,
      );
    }
    return this.push(or, (eb, sqlite) =>
      compare(eb, column, op, value, sqlite),
    );
  }

  /**
   * `where("status", "paid")`, `where("total", ">", 100)`,
   * `where({ status: "paid", currency: "EUR" })`, or a group:
   * `where((q) => q.where("a", 1).orWhere("b", 2))`.
   */
  where(column: string, value: unknown): Self;
  where(column: string, operator: Operator, value: unknown): Self;
  where(group: (query: WhereGroup) => void): Self;
  where(values: Row): Self;
  where(...args: unknown[]): Self {
    return this.comparison(false, args);
  }

  orWhere(column: string, value: unknown): Self;
  orWhere(column: string, operator: Operator, value: unknown): Self;
  orWhere(group: (query: WhereGroup) => void): Self;
  orWhere(values: Row): Self;
  orWhere(...args: unknown[]): Self {
    return this.comparison(true, args);
  }

  /** Rows whose `column` is in `values`: a list, or a subquery selecting one column. */
  whereIn(column: string, values: readonly unknown[] | Subquery): Self {
    return this.push(false, (eb, sqlite) =>
      inList(eb, column, values, false, sqlite),
    );
  }

  whereNotIn(column: string, values: readonly unknown[] | Subquery): Self {
    return this.push(false, (eb, sqlite) =>
      inList(eb, column, values, true, sqlite),
    );
  }

  orWhereIn(column: string, values: readonly unknown[] | Subquery): Self {
    return this.push(true, (eb, sqlite) =>
      inList(eb, column, values, false, sqlite),
    );
  }

  /** Rows for which `query` returns a row: `whereExists(DB.table("bans").whereColumn("bans.user_id", "=", "users.id"))`. */
  whereExists(query: Subquery): Self {
    return this.push(false, (eb) => eb.exists(query.toKysely()));
  }

  whereNotExists(query: Subquery): Self {
    return this.push(false, (eb) => eb.not(eb.exists(query.toKysely())));
  }

  whereNull(column: string): Self {
    return this.push(false, (eb) => eb(column, "is", null));
  }

  whereNotNull(column: string): Self {
    return this.push(false, (eb) => eb(column, "is not", null));
  }

  orWhereNull(column: string): Self {
    return this.push(true, (eb) => eb(column, "is", null));
  }

  orWhereNotNull(column: string): Self {
    return this.push(true, (eb) => eb(column, "is not", null));
  }

  whereBetween(column: string, [from, to]: readonly [unknown, unknown]): Self {
    return this.push(false, (eb, sqlite) =>
      eb.between(eb.ref(column), bindable(from, sqlite), bindable(to, sqlite)),
    );
  }

  whereNotBetween(
    column: string,
    [from, to]: readonly [unknown, unknown],
  ): Self {
    return this.push(false, (eb, sqlite) =>
      eb.not(
        eb.between(
          eb.ref(column),
          bindable(from, sqlite),
          bindable(to, sqlite),
        ),
      ),
    );
  }

  /** Compare two columns: `whereColumn("updated_at", ">", "created_at")`. */
  whereColumn(left: string, operator: Operator, right: string): Self {
    return this.push(false, (eb) => eb(left, operator, eb.ref(right)));
  }

  /** A condition in SQL, with `?` placeholders: `whereRaw("lower(email) = ?", [email])`. */
  whereRaw(sql: string, bindings: readonly unknown[] = []): Self {
    return this.push(false, () => rawSql(sql, bindings));
  }

  orWhereRaw(sql: string, bindings: readonly unknown[] = []): Self {
    return this.push(true, () => rawSql(sql, bindings));
  }

  /**
   * @internal The conditions as one expression. `and` binds tighter than
   * `or`, as in SQL: `a or b and c` is `a or (b and c)`.
   */
  toExpression(eb: any, sqlite: boolean): any {
    const groups: any[][] = [];
    for (const clause of this.clauses) {
      if (clause.or || groups.length === 0) groups.push([]);
      groups[groups.length - 1].push(clause.build(eb, sqlite));
    }
    const ands = groups.map((g) => (g.length === 1 ? g[0] : eb.and(g)));
    return ands.length === 1 ? ands[0] : eb.or(ands);
  }

  /** @internal */
  hasClauses(): boolean {
    return this.clauses.length > 0;
  }
}

/** The conditions inside `where((q) => …)`, put in parentheses. */
export class WhereGroup extends WhereClauses<WhereGroup> {}

function compare(
  eb: any,
  column: string,
  op: string,
  value: unknown,
  sqlite: boolean,
) {
  if (value === null && (op === "=" || op === "!=" || op === "<>")) {
    return eb(column, op === "=" ? "is" : "is not", null);
  }
  if (op === "in" || op === "not in") {
    return inList(eb, column, value as unknown[], op === "not in", sqlite);
  }
  return eb(column, op, bind(value, sqlite));
}

function inList(
  eb: any,
  column: string,
  values: readonly unknown[] | Subquery,
  not: boolean,
  sqlite: boolean,
) {
  if (isSubquery(values)) {
    return eb(column, not ? "not in" : "in", values.toKysely());
  }
  // `in ()` is invalid SQL: nothing is in an empty list, everything is outside it.
  if (values.length === 0) return kysely().sql.raw(not ? "1 = 1" : "1 = 0");
  return eb(column, not ? "not in" : "in", bind([...values], sqlite));
}

type Order =
  | { column: string; direction: "asc" | "desc"; nulls?: "first" | "last" }
  | { raw: string };

/** A common table expression: `with <name> as (<query>)`. */
interface Cte {
  name: string;
  query: Subquery;
  /** Recursive: `<query> union all <recursive>`. */
  recursive?: Subquery;
}
type Join = {
  kind: "inner" | "left" | "right";
  table: string;
  left: string;
  op: string;
  right: string;
};

/** A query on one table. Build it with `DB.table(name)`. */
export class TableQuery<T extends Row = Row> extends WhereClauses<
  TableQuery<T>
> {
  private columns: string[] = [];
  private rawColumns: { sql: string; bindings: readonly unknown[] }[] = [];
  private isDistinct = false;
  private joins: Join[] = [];
  private orders: Order[] = [];
  private groups: string[] = [];
  private havings = new WhereGroup();
  private limitValue?: number;
  private offsetValue?: number;
  private distinctColumns: string[] = [];
  private unions: { all: boolean; query: Subquery }[] = [];
  private ctes: Cte[] = [];
  private lock?: {
    mode: "update" | "share";
    modifier?: "skipLocked" | "noWait";
  };
  private execOptions: {
    signal?: AbortSignal;
    inflightQueryAbortStrategy?: InflightQueryAbortStrategy;
  } = {};

  constructor(private readonly tableName: string) {
    super();
  }

  // ── Building ─────────────────────────────────────────────────────────────

  /** Columns to return; `"users.email as contact"` aliases one. All columns by default. */
  select(...columns: string[]): this {
    this.columns.push(...columns.flat());
    return this;
  }

  /** A selected expression in SQL: `selectRaw("count(*) as total")`. */
  selectRaw(sql: string, bindings: readonly unknown[] = []): this {
    this.rawColumns.push({ sql, bindings });
    return this;
  }

  distinct(): this {
    this.isDistinct = true;
    return this;
  }

  /** PostgreSQL only: one row per distinct value of `columns`, the first in the query's order. */
  distinctOn(...columns: string[]): this {
    this.distinctColumns.push(...columns);
    return this;
  }

  /**
   * Add `with <name> as (<query>)`, to select from by name:
   * `DB.table("big").withExpression("big", DB.table("orders").where("total", ">", 100))`.
   */
  withExpression(name: string, query: Subquery): this {
    this.ctes.push({ name, query });
    return this;
  }

  /**
   * A recursive common table expression: `anchor union all recursive`,
   * where `recursive` joins `name` itself. Walks trees and graphs:
   *
   * ```ts
   * const subtree = await DB.table("tree")
   *   .withRecursiveExpression(
   *     "tree",
   *     DB.table("categories").where("id", rootId),
   *     DB.table("categories").select("categories.*").join("tree", "tree.id", "categories.parent_id"),
   *   )
   *   .get();
   * ```
   */
  withRecursiveExpression(
    name: string,
    anchor: Subquery,
    recursive: Subquery,
  ): this {
    this.ctes.push({ name, query: anchor, recursive });
    return this;
  }

  /** Add the rows of another query: `union` drops duplicates. */
  union(query: Subquery): this {
    this.unions.push({ all: false, query });
    return this;
  }

  /** Like {@link union}, keeping duplicates. */
  unionAll(query: Subquery): this {
    this.unions.push({ all: true, query });
    return this;
  }

  /** `FOR UPDATE`: lock the selected rows until the transaction ends. A no-op on SQLite; not supported on SQL Server. */
  lockForUpdate(): this {
    this.lock = { ...this.lock, mode: "update" };
    return this;
  }

  /** `FOR SHARE`: others can read the selected rows but not change them. */
  sharedLock(): this {
    this.lock = { ...this.lock, mode: "share" };
    return this;
  }

  /** With a lock: skip rows another transaction has locked. */
  skipLocked(): this {
    this.lock = { mode: this.lock?.mode ?? "update", modifier: "skipLocked" };
    return this;
  }

  /** With a lock: fail at once instead of waiting for locked rows. */
  noWait(): this {
    this.lock = { mode: this.lock?.mode ?? "update", modifier: "noWait" };
    return this;
  }

  /** Stop the query when `signal` aborts. See `ModelQuery.abortSignal()`. */
  abortSignal(
    signal: AbortSignal | undefined,
    strategy?: InflightQueryAbortStrategy,
  ): this {
    this.execOptions = { signal, inflightQueryAbortStrategy: strategy };
    return this;
  }

  /** Apply `then` when `value` is truthy, else `otherwise`. */
  when<V>(
    value: V,
    then: (query: this, value: NonNullable<V>) => unknown,
    otherwise?: (query: this) => unknown,
  ): this {
    if (value) then(this, value as NonNullable<V>);
    else otherwise?.(this);
    return this;
  }

  /** Inner join: `join("users", "users.id", "orders.user_id")` or with an operator. */
  join(table: string, left: string, right: string): this;
  join(table: string, left: string, operator: Operator, right: string): this;
  join(table: string, left: string, ...rest: string[]): this {
    return this.addJoin("inner", table, left, rest);
  }

  leftJoin(table: string, left: string, right: string): this;
  leftJoin(
    table: string,
    left: string,
    operator: Operator,
    right: string,
  ): this;
  leftJoin(table: string, left: string, ...rest: string[]): this {
    return this.addJoin("left", table, left, rest);
  }

  rightJoin(table: string, left: string, right: string): this;
  rightJoin(
    table: string,
    left: string,
    operator: Operator,
    right: string,
  ): this;
  rightJoin(table: string, left: string, ...rest: string[]): this {
    return this.addJoin("right", table, left, rest);
  }

  private addJoin(
    kind: Join["kind"],
    table: string,
    left: string,
    rest: string[],
  ): this {
    const [op, right] = rest.length === 2 ? rest : ["=", rest[0]];
    this.joins.push({ kind, table, left, op, right });
    return this;
  }

  /** Order by `column`; `nulls` puts NULLs first or last on every database. */
  orderBy(
    column: string,
    direction: "asc" | "desc" = "asc",
    nulls?: "first" | "last",
  ): this {
    this.orders.push({ column, direction, nulls });
    return this;
  }

  orderByDesc(column: string): this {
    return this.orderBy(column, "desc");
  }

  /** Order in SQL: `orderByRaw("random()")`. */
  orderByRaw(sql: string): this {
    this.orders.push({ raw: sql });
    return this;
  }

  /** Newest first, by `created_at` unless another column is given. */
  latest(column = "created_at"): this {
    return this.orderBy(column, "desc");
  }

  oldest(column = "created_at"): this {
    return this.orderBy(column, "asc");
  }

  groupBy(...columns: string[]): this {
    this.groups.push(...columns);
    return this;
  }

  /** A condition on grouped rows: `having("total", ">", 100)`. */
  having(column: string, operator: Operator, value: unknown): this {
    this.havings.where(column, operator, value);
    return this;
  }

  havingRaw(sql: string, bindings: readonly unknown[] = []): this {
    this.havings.whereRaw(sql, bindings);
    return this;
  }

  limit(count: number): this {
    this.limitValue = count;
    return this;
  }

  offset(count: number): this {
    this.offsetValue = count;
    return this;
  }

  /** Same as `limit()`. */
  take(count: number): this {
    return this.limit(count);
  }

  /** Same as `offset()`. */
  skip(count: number): this {
    return this.offset(count);
  }

  /** Limit and offset for page `page` (from 1) of `perPage` rows. */
  forPage(page: number, perPage = 15): this {
    return this.limit(perPage).offset((Math.max(1, page) - 1) * perPage);
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  /** Every matching row. */
  async get(): Promise<T[]> {
    return (await this.selectQuery().execute(this.execOptions)) as T[];
  }

  /** The matching rows as the database sends them, without loading them all first. */
  async *stream(chunkSize?: number): AsyncGenerator<T> {
    yield* this.selectQuery().stream({
      chunkSize,
      signal: this.execOptions.signal,
    });
  }

  /**
   * Run `fn` on the matching rows `size` at a time, ordered by `column`
   * (unique; default `id`) and paged by it (`where id > last`), so it
   * stays correct while `fn` changes rows. Return `false` to stop.
   */
  async chunkById(
    size: number,
    fn: (rows: T[], page: number) => unknown,
    column = "id",
  ): Promise<boolean> {
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new Error(
        `[Megh ORM] The chunk size must be at least 1, got ${size}.`,
      );
    }
    // The paging condition must not join an `orWhere()` group.
    const base = this.clone().reset("orders");
    if (base.hasClauses()) {
      const conditions = this.clone();
      base.clauses = [
        {
          or: false,
          build: (eb, sqlite) => conditions.toExpression(eb, sqlite),
        },
      ];
    }
    const key = column.split(".").pop()!;
    let after: unknown;
    for (let page = 1; ; page++) {
      const query = base.clone().orderBy(column).limit(size).offset(0);
      if (after !== undefined) query.where(column, ">", after);
      const rows = await query.get();
      if (rows.length === 0) return true;
      if ((await fn(rows, page)) === false) return false;
      if (rows.length < size) return true;
      after = rows[rows.length - 1][key];
    }
  }

  /** The first matching row, or `undefined`. */
  async first(): Promise<T | undefined> {
    const rows = await this.clone().limit(1).get();
    return rows[0];
  }

  /** The first matching row, or a 404 `NotFoundException`. */
  async firstOrFail(): Promise<T> {
    const row = await this.first();
    if (!row)
      throw new NotFoundException(`No row in ${this.tableName} matches`);
    return row;
  }

  /** One column of the first matching row. */
  async value<V = unknown>(column: string): Promise<V | undefined> {
    const row = await this.clone().reset("columns").select(column).first();
    return row ? (Object.values(row)[0] as V) : undefined;
  }

  /** One column of every matching row. */
  async pluck<V = unknown>(column: string): Promise<V[]> {
    const rows = await this.clone().reset("columns").select(column).get();
    return rows.map((row) => Object.values(row)[0] as V);
  }

  async exists(): Promise<boolean> {
    return (
      (await this.clone().reset("columns").selectRaw("1 as one").first()) !==
      undefined
    );
  }

  async doesntExist(): Promise<boolean> {
    return !(await this.exists());
  }

  /** Number of matching rows (of non-null `column` values, if given). */
  async count(column?: string): Promise<number> {
    const value = await this.aggregate((eb) =>
      column ? eb.fn.count(column) : eb.fn.countAll(),
    );
    return Number(value ?? 0);
  }

  /** Sum of `column`; `0` when nothing matches. */
  async sum(column: string): Promise<number> {
    return Number((await this.aggregate((eb) => eb.fn.sum(column))) ?? 0);
  }

  /** Average of `column`; `null` when nothing matches. */
  async avg(column: string): Promise<number | null> {
    const value = await this.aggregate((eb) => eb.fn.avg(column));
    return value === null || value === undefined ? null : Number(value);
  }

  async min<V = unknown>(column: string): Promise<V | null> {
    return ((await this.aggregate((eb) => eb.fn.min(column))) ??
      null) as V | null;
  }

  async max<V = unknown>(column: string): Promise<V | null> {
    return ((await this.aggregate((eb) => eb.fn.max(column))) ??
      null) as V | null;
  }

  /** One page of rows and the total: `{ data, meta: { total, page, perPage, lastPage, … } }`. */
  async paginate(request: PageRequest = {}): Promise<Paginated<T>> {
    const { page, perPage, offset } = normalizePageRequest(request);
    const total = await this.count();
    const data = await this.clone().limit(perPage).offset(offset).get();
    return paginated(data, total, page, perPage);
  }

  // ── Writing ──────────────────────────────────────────────────────────────

  /**
   * Insert one row or several, in order. Consecutive rows with the same
   * columns go in one statement; a column a row leaves out gets its
   * database default.
   */
  async insert(rows: Row | Row[]): Promise<void> {
    const list = [rows].flat();
    if (list.length === 0) return;
    const db = getConnection();
    const sqlite = isSqlite(db);
    // A multi-row insert fills missing columns with NULL rather than their
    // default, so a new statement starts whenever the columns change.
    const batches: { key: string; rows: Row[] }[] = [];
    for (const row of list.map((r) => bindRow(r, sqlite))) {
      const key = Object.keys(row).sort().join("\0");
      const last = batches[batches.length - 1];
      if (last?.key === key) last.rows.push(row);
      else batches.push({ key, rows: [row] });
    }
    for (const batch of batches) {
      await db.insertInto(this.tableName).values(batch.rows).execute();
    }
  }

  /**
   * Insert rows, or update the ones that already exist: a row "exists" when
   * a row with the same `uniqueBy` columns does (they need a unique index,
   * except on SQL Server). `update` lists the columns to overwrite; by
   * default every given column except `uniqueBy`. Returns the database's
   * count of affected rows (MySQL counts an update as 2).
   *
   * Runs as `ON CONFLICT` (PostgreSQL, SQLite), `ON DUPLICATE KEY UPDATE`
   * (MySQL, which matches on any unique index) or `MERGE` (SQL Server).
   */
  async upsert(
    rows: Row | Row[],
    uniqueBy: string | readonly string[],
    update?: readonly string[],
  ): Promise<number> {
    const list = [rows].flat();
    if (list.length === 0) return 0;
    const db = getConnection();
    const sqlite = isSqlite(db);
    const keys = [uniqueBy].flat() as string[];
    const bound = list.map((r) => bindRow(r, sqlite));
    const columns = Object.keys(bound[0]);
    const signature = [...columns].sort().join("\0");
    for (const row of bound) {
      if (Object.keys(row).sort().join("\0") !== signature) {
        throw new Error(
          "[Megh ORM] upsert() rows must all have the same columns.",
        );
      }
    }
    for (const key of keys) {
      if (!columns.includes(key)) {
        throw new Error(
          `[Megh ORM] upsert() rows have no "${key}" column to match by.`,
        );
      }
    }
    const updates = update ?? columns.filter((c) => !keys.includes(c));
    const pick = (names: readonly string[], value: (c: string) => unknown) =>
      Object.fromEntries(names.map((c) => [c, value(c)]));
    const { sql } = kysely();

    if (usesAdapter(db, "MssqlAdapter")) {
      const source = bound
        .map((row) =>
          db.selectNoFrom((eb: any) =>
            columns.map((c) => eb.val(row[c]).as(c)),
          ),
        )
        .reduce((all: any, next: any) => all.unionAll(next));
      let merge: any = db
        .mergeInto(`${this.tableName} as megh_target`)
        .using((source as any).as("megh_source"), (join: any) =>
          keys.reduce(
            (on: any, k) =>
              on.onRef(`megh_target.${k}`, "=", `megh_source.${k}`),
            join,
          ),
        );
      if (updates.length > 0) {
        merge = merge
          .whenMatched()
          .thenUpdateSet((eb: any) =>
            pick(updates, (c) => eb.ref(`megh_source.${c}`)),
          );
      }
      merge = merge
        .whenNotMatched()
        .thenInsertValues((eb: any) =>
          pick(columns, (c) => eb.ref(`megh_source.${c}`)),
        );
      const result = await merge.executeTakeFirst(this.execOptions);
      return Number(result?.numChangedRows ?? 0);
    }

    let insert: any = db.insertInto(this.tableName).values(bound);
    if (usesAdapter(db, "MysqlAdapter")) {
      insert = insert.onDuplicateKeyUpdate(
        updates.length > 0
          ? pick(updates, (c) => sql`values(${sql.ref(c)})`)
          : // Nothing to update: set a key to itself, a no-op.
            { [keys[0]]: sql.ref(keys[0]) },
      );
    } else {
      insert = insert.onConflict((oc: any) => {
        const target = oc.columns(keys);
        return updates.length > 0
          ? target.doUpdateSet((eb: any) =>
              pick(updates, (c) => eb.ref(`excluded.${c}`)),
            )
          : target.doNothing();
      });
    }
    const result = await insert.executeTakeFirst(this.execOptions);
    return Number(result?.numInsertedOrUpdatedRows ?? 0);
  }

  /** Insert a row and return the id the database gave it. */
  async insertGetId<Id = number>(row: Row, idColumn = "id"): Promise<Id> {
    const db = getConnection();
    const values = bindRow(row, isSqlite(db));
    const insert = db.insertInto(this.tableName).values(values);
    const adapter = db.getExecutor().adapter;
    if (adapter.supportsOutput) {
      // SQL Server has no RETURNING and its driver gives no insertId.
      const result: any = await insert
        .output(`inserted.${idColumn}` as any)
        .executeTakeFirstOrThrow();
      return result[idColumn] as Id;
    }
    if (adapter.supportsReturning) {
      const result: any = await insert
        .returning(idColumn)
        .executeTakeFirstOrThrow();
      return result[idColumn] as Id;
    }
    const result = await insert.executeTakeFirstOrThrow();
    return Number(result.insertId) as Id;
  }

  /** Update the matching rows. Returns how many were updated. */
  async update(values: Row): Promise<number> {
    const db = getConnection();
    const query = this.whereOn(
      db.updateTable(this.tableName).set(bindRow(values, isSqlite(db))),
      isSqlite(db),
    );
    const result = await query.executeTakeFirst(this.execOptions);
    return Number(result?.numUpdatedRows ?? 0);
  }

  /** Add `amount` (default 1) to `column` on the matching rows, and set `extra` columns. */
  async increment(
    column: string,
    amount = 1,
    extra: Row = {},
  ): Promise<number> {
    return this.adjust(column, "+", amount, extra);
  }

  async decrement(
    column: string,
    amount = 1,
    extra: Row = {},
  ): Promise<number> {
    return this.adjust(column, "-", amount, extra);
  }

  /** Delete the matching rows. Returns how many were deleted. */
  async delete(): Promise<number> {
    const db = getConnection();
    const query = this.whereOn(db.deleteFrom(this.tableName), isSqlite(db));
    const result = await query.executeTakeFirst(this.execOptions);
    return Number(result?.numDeletedRows ?? 0);
  }

  // ── Inspecting ───────────────────────────────────────────────────────────

  /** The SQL and parameters this query would run, for debugging. */
  toSQL(): { sql: string; parameters: readonly unknown[] } {
    const { sql, parameters } = this.selectQuery().compile();
    return { sql, parameters };
  }

  /** @internal The query as a Kysely select, for subqueries. */
  toKysely(): any {
    return this.selectQuery();
  }

  /** A copy to build on without changing this query. */
  clone(): TableQuery<T> {
    const copy = new TableQuery<T>(this.tableName);
    copy.clauses = [...this.clauses];
    copy.columns = [...this.columns];
    copy.rawColumns = [...this.rawColumns];
    copy.isDistinct = this.isDistinct;
    copy.joins = [...this.joins];
    copy.orders = [...this.orders];
    copy.groups = [...this.groups];
    copy.havings = this.havings;
    copy.limitValue = this.limitValue;
    copy.offsetValue = this.offsetValue;
    copy.distinctColumns = [...this.distinctColumns];
    copy.unions = [...this.unions];
    copy.ctes = [...this.ctes];
    copy.lock = this.lock && { ...this.lock };
    copy.execOptions = this.execOptions;
    return copy;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private reset(part: "columns" | "orders"): this {
    if (part === "columns") {
      this.columns = [];
      this.rawColumns = [];
    } else {
      this.orders = [];
    }
    return this;
  }

  private whereOn(query: any, sqlite: boolean): any {
    return this.hasClauses()
      ? query.where((eb: any) => this.toExpression(eb, sqlite))
      : query;
  }

  private base(db: Kysely<any> | Transaction<any>): any {
    const sqlite = isSqlite(db);
    let query: any = this.withCtes(db).selectFrom(this.tableName);
    for (const join of this.joins) {
      const method = {
        inner: "innerJoin",
        left: "leftJoin",
        right: "rightJoin",
      }[join.kind];
      query =
        join.op === "="
          ? query[method](join.table, join.left, join.right)
          : query[method](join.table, (on: any) =>
              on.on(join.left, join.op, on.ref(join.right)),
            );
    }
    query = this.whereOn(query, sqlite);
    if (this.groups.length) query = query.groupBy(this.groups);
    if (this.havings.hasClauses()) {
      query = query.having((eb: any) => this.havings.toExpression(eb, sqlite));
    }
    return query;
  }

  /** `db` with this query's common table expressions. */
  private withCtes(db: Kysely<any> | Transaction<any>): any {
    let creator: any = db;
    // SQL Server's CTEs are recursive without the keyword, and reject it.
    const keyword = !usesAdapter(db as Kysely<any>, "MssqlAdapter");
    for (const { name, query, recursive } of this.ctes) {
      const body = () =>
        recursive
          ? query.toKysely().unionAll(recursive.toKysely())
          : query.toKysely();
      creator =
        recursive && keyword
          ? creator.withRecursive(name, body)
          : creator.with(name, body);
    }
    return creator;
  }

  private selectQuery(): any {
    const db = getConnection();
    let query = this.base(db);
    if (this.columns.length === 0 && this.rawColumns.length === 0) {
      query = query.selectAll();
    } else {
      // `table.*` is all of one table's columns.
      const plain = this.columns.filter((c) => !c.endsWith("*"));
      for (const column of this.columns) {
        if (column === "*") query = query.selectAll();
        else if (column.endsWith(".*"))
          query = query.selectAll(column.slice(0, -2));
      }
      if (plain.length) query = query.select(plain);
      for (const raw of this.rawColumns) {
        query = query.select(rawSql(raw.sql, raw.bindings) as any);
      }
    }
    if (this.isDistinct) query = query.distinct();
    if (this.distinctColumns.length > 0) {
      if (!usesAdapter(db, "PostgresAdapter")) {
        throw new Error("[Megh ORM] distinctOn() works on PostgreSQL only.");
      }
      query = query.distinctOn(this.distinctColumns);
    }
    for (const { all, query: other } of this.unions) {
      query = all
        ? query.unionAll(other.toKysely())
        : query.union(other.toKysely());
    }
    const { sql } = kysely();
    for (const order of this.orders) {
      if ("raw" in order) {
        query = query.orderBy(sql.raw(order.raw));
        continue;
      }
      if (order.nulls) {
        const first = order.nulls === "first";
        query = query.orderBy(
          sql`case when ${sql.ref(order.column)} is null then ${sql.lit(first ? 0 : 1)} else ${sql.lit(first ? 1 : 0)} end`,
        );
      }
      query = query.orderBy(order.column, order.direction);
    }
    query = applyPaging(db, query, {
      limit: this.limitValue,
      offset: this.offsetValue,
      ordered: this.orders.length > 0,
    });
    if (this.lock && !isSqlite(db)) {
      if (usesAdapter(db, "MssqlAdapter")) {
        throw new Error(
          "[Megh ORM] lockForUpdate() and sharedLock() aren't supported on SQL Server.",
        );
      }
      query =
        this.lock.mode === "update" ? query.forUpdate() : query.forShare();
      if (this.lock.modifier === "skipLocked") query = query.skipLocked();
      if (this.lock.modifier === "noWait") query = query.noWait();
    }
    return query;
  }

  private async aggregate(fn: (eb: any) => any): Promise<unknown> {
    const db = getConnection();
    // Grouped, distinct and union queries are counted as a subquery, as their rows.
    if (
      this.groups.length ||
      this.isDistinct ||
      this.distinctColumns.length ||
      this.unions.length
    ) {
      const inner = this.clone().reset("orders");
      inner.limitValue = undefined;
      inner.offsetValue = undefined;
      inner.lock = undefined;
      const row: any = await db
        .selectFrom(inner.selectQuery().as("sub"))
        .select((eb: any) => fn(eb).as("aggregate"))
        .executeTakeFirst(this.execOptions);
      return row?.aggregate;
    }
    const row: any = await this.base(db)
      .select((eb: any) => fn(eb).as("aggregate"))
      .executeTakeFirst(this.execOptions);
    return row?.aggregate;
  }

  private async adjust(
    column: string,
    op: "+" | "-",
    amount: number,
    extra: Row,
  ): Promise<number> {
    const db = getConnection();
    const sqlite = isSqlite(db);
    const query = this.whereOn(
      db.updateTable(this.tableName).set((eb: any) => ({
        ...bindRow(extra, sqlite),
        [column]: eb(column, op, amount),
      })),
      sqlite,
    );
    const result = await query.executeTakeFirst();
    return Number(result?.numUpdatedRows ?? 0);
  }
}

function bindRow(row: Row, sqlite: boolean): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue;
    out[key] =
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Date) &&
      !Buffer.isBuffer(value)
        ? JSON.stringify(value)
        : bindable(value, sqlite);
  }
  return out;
}

/**
 * The query builder and raw SQL.
 *
 * ```ts
 * await DB.table("users").where("active", true).count();
 * await DB.select("select * from users where email = ?", [email]);
 * await DB.transaction(async () => { … });
 * ```
 */
export const DB = {
  /** A query on `table`. Type the rows with `DB.table<{ id: number; email: string }>("users")`. */
  table<T extends Row = Row>(table: string): TableQuery<T> {
    return new TableQuery<T>(table);
  },

  /** Run a query in SQL and return its rows. Use `?` for values. */
  async select<T extends Row = Row>(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<T[]> {
    const db = getConnection();
    const result = await rawSql(
      sql,
      bind([...bindings], isSqlite(db)) as unknown[],
    ).execute(db);
    return result.rows as T[];
  },

  /** Run a statement in SQL (insert, update, DDL, …). Returns the number of rows it changed, when known. */
  async statement(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<number> {
    const db = getConnection();
    const result = await rawSql(
      sql,
      bind([...bindings], isSqlite(db)) as unknown[],
    ).execute(db);
    return Number(result.numAffectedRows ?? 0);
  },

  /**
   * Run `fn` in a transaction that every query inside uses, models included.
   * Commits when `fn` resolves, rolls back if it throws. Nested calls run in
   * a savepoint.
   */
  transaction<R>(fn: () => Promise<R>): Promise<R> {
    return runInTransaction(() => fn(), { savepoint: true });
  },
};
