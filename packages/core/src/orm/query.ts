/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 */
import type {
  ComparisonOperatorExpression,
  Expression,
  ExpressionBuilder,
  InflightQueryAbortStrategy,
  SqlBool,
} from "kysely";
import { BadRequestException, NotFoundException } from "./core";
import {
  normalizePageRequest,
  paginated,
  type PageRequest,
  type Paginated,
} from "./core";
import {
  bindable,
  castFromDatabase,
  castToDatabase,
  isSqlite,
  usesAdapter,
} from "./casts";
import { getConnection } from "./connection";
import { rawSql } from "./db";
import { kysely } from "./engine";
import { applyPaging } from "./paging";
import { columnName, propertyName, toColumns } from "./naming";
import {
  getRelation,
  morphOwnerKey,
  morphTypeOf,
  type RelationDefinition,
} from "./relations";
import { hydrate, tableOf, withTimestamps } from "./state";
import type {
  ColumnKeys,
  Columns,
  ModelClass,
  RelatedModel,
  RelationKeys,
  RelationPaths,
  Row,
  UpdateInput,
} from "./types";

export type ComparisonOperator = ComparisonOperatorExpression;

/** A Kysely query builder; the ORM keeps them untyped internally. */
type Builder = any;

/** What a query step needs when the SQL is built. */
interface BuildContext {
  /** Makes a value bindable for the current dialect. */
  bind: (value: unknown) => unknown;
  /** The name the query's table goes by: its table name, or an alias in a subquery. */
  ref: string;
  /** Subquery nesting depth, for unique aliases. */
  depth: number;
  /** Prefix columns with `ref`: the query joins another table. */
  qualify?: boolean;
}

type Step = (qb: Builder, ctx: BuildContext) => Builder;

/** A `where` condition: an expression, joined to the one before by `and` or `or`. */
interface Filter {
  or: boolean;
  build: (eb: any, ctx: BuildContext) => any;
}

type TrashedScope = "without" | "with" | "only";

/** Options every query's `execute()` gets: an abort signal. */
interface ExecOptions {
  signal?: AbortSignal;
  inflightQueryAbortStrategy?: InflightQueryAbortStrategy;
}

/** Operators for `join()` conditions. */
export type JoinOperator = "=" | "!=" | "<>" | "<" | "<=" | ">" | ">=";

/** A column for model queries: one of the model's, or `table.column` from a join. */
type ColumnRef<M> = ColumnKeys<M> | `${string}.${string}`;

/** A subquery for `whereIn()` / `whereExists()`: a model query or a `DB.table()` query. */
export interface SubQuery {
  /** @internal The query as a Kysely select. */
  toKysely(): unknown;
}

/** The model at the end of a relation path: `ModelAt<User, "posts.comments">` is `Comment`. */
export type ModelAt<M, P extends string> = P extends `${infer H}.${infer R}`
  ? ModelAt<RelatedModel<M[H & keyof M]>, R>
  : RelatedModel<M[P & keyof M]>;

/** Narrows a related query, e.g. in `whereHas("posts", q => q.where("published", 1))`. */
export type RelationConstraint<R> = (query: ModelQuery<R>) => unknown;

/** One `with()` request: a relation path, and a constraint on its last relation. */
interface EagerRequest {
  path: string;
  constrain?: RelationConstraint<any>;
}

/** What the query a `with()` constraint returns says about the loaded rows. */
type EagerOf<R> =
  R extends ModelQuery<
    any,
    infer P extends string,
    infer S extends string,
    infer X extends object,
    infer E extends object
  >
    ? { paths: P; select: S; extra: X; nested: E }
    : never;

/** `E` entry for `with(path, constrain)`; none when the callback returns nothing. */
export type ConstrainedAt<Q extends string, R> = [EagerOf<R>] extends [never]
  ? {}
  : { [K in Q]: EagerOf<R> };

/**
 * Constraints by relation path, for `with({ … })`:
 *
 * ```ts
 * Todo.with({ user: (q) => q.select("name", "role") });
 * ```
 */
export type EagerConstraints<M> = {
  [Q in RelationPaths<M>]?: (query: ModelQuery<ModelAt<M, Q>>) => unknown;
};

/** `E` entries for `with({ … })`. */
export type ConstrainedMap<T> = {
  [
    K in keyof T as T[K] extends (...args: any[]) => infer R
      ? [EagerOf<R>] extends [never]
        ? never
        : K
      : never
  ]: T[K] extends (...args: any[]) => infer R ? EagerOf<R> : never;
};

/** Window alias and row-number column for per-parent `limit()` in eager loads. */
const WINDOW = "megh_w";
const ROW_NUMBER = "megh_rn";
/** The intermediate key selected by `hasManyThrough` eager loads. */
const THROUGH_KEY = "megh_through_key";
const PIVOT_PREFIX = "__pivot_";

/**
 * A reusable query fragment, applied with `scope()`:
 *
 * ```ts
 * const published: Scope<Post> = (q) => q.whereNotNull("published_at");
 * const by: Scope<Post, [number]> = (q, userId) => q.where("user_id", userId);
 *
 * await Post.scope(published).scope(by, 1).get();
 * ```
 */
export type Scope<M, A extends unknown[] = []> = (
  query: ModelQuery<M, any, any, any, any>,
  ...args: A
) => unknown;

/** `withCount("posts")` adds `posts_count`. */
export type Counted<N extends string> = {
  readonly [K in N as `${K}_count`]: number;
};

/** `withSum("posts", "views")` adds `posts_sum_views`; also `avg`, `min` and `max`. */
export type Aggregated<
  N extends string,
  F extends string,
  C extends string,
  V,
> = {
  readonly [K in N as `${K}_${F}_${C}`]: V;
};

/** `withExists("posts")` adds `posts_exists`. */
export type Existence<N extends string> = {
  readonly [K in N as `${K}_exists`]: boolean;
};

type AggregateFn = "count" | "sum" | "avg" | "min" | "max" | "exists";

interface AggregateRequest {
  relation: string;
  fn: AggregateFn;
  column?: string;
  constrain?: RelationConstraint<any>;
  alias: string;
}

interface RawSelect {
  sql: string;
  bindings: readonly unknown[];
  alias: string;
}

interface Join {
  kind: "inner" | "left" | "right";
  table: string;
  left: string;
  op: string;
  right: string;
}

/** Result of {@link ModelQuery.simplePaginate}: no total, so no `lastPage`. */
export interface SimplePaginated<T> {
  data: T[];
  meta: {
    page: number;
    perPage: number;
    hasMore: boolean;
    next: number | null;
    prev: number | null;
  };
}

/** Request for {@link ModelQuery.cursorPaginate}. */
export interface CursorPageRequest<K extends string = string> {
  /** `meta.nextCursor` from the previous page; omit for the first page. */
  cursor?: string | null;
  /** Items per page. Defaults to 10. */
  perPage?: number;
  /** Column to page by. Must be unique and sortable. Defaults to the primary key. */
  column?: K;
  direction?: "asc" | "desc";
}

/** Result of {@link ModelQuery.cursorPaginate}. */
export interface CursorPaginated<T> {
  data: T[];
  meta: {
    perPage: number;
    hasMore: boolean;
    /** Pass as `cursor` to get the next page; `null` on the last page. */
    nextCursor: string | null;
  };
}

/** Opaque cursor: the last row's value of the paging column. */
function encodeCursor(row: any, column: string): string {
  const value = row[column];
  const payload =
    value instanceof Date ? { d: value.toISOString() } : { v: value };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string): unknown {
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (payload && typeof payload === "object") {
      if ("d" in payload) return new Date(payload.d);
      if ("v" in payload) return payload.v;
    }
  } catch {
    // fall through
  }
  throw new BadRequestException("Invalid pagination cursor");
}

/**
 * The conditions as one expression. `and` binds tighter than `or`, as in
 * SQL: `a or b and c` is `a or (b and c)`.
 */
function combine(eb: any, filters: Filter[], ctx: BuildContext): any {
  const groups: any[][] = [];
  for (const filter of filters) {
    if (filter.or || groups.length === 0) groups.push([]);
    groups[groups.length - 1].push(filter.build(eb, ctx));
  }
  const ands = groups.map((g) => (g.length === 1 ? g[0] : eb.and(g)));
  return ands.length === 1 ? ands[0] : eb.or(ands);
}

/** `where`: chained one by one (as `and`), or as one expression when `or` is used. */
function whereAll(qb: Builder, filters: Filter[], ctx: BuildContext): Builder {
  if (filters.length === 0) return qb;
  if (filters.some((f) => f.or)) {
    return qb.where((eb: any) => combine(eb, filters, ctx));
  }
  for (const filter of filters) {
    qb = qb.where((eb: any) => filter.build(eb, ctx));
  }
  return qb;
}

function isSubQuery(value: unknown): value is SubQuery {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as any).toKysely === "function"
  );
}

/** The alias in `"count(*) as total"`. */
function rawAlias(sql: string): string {
  const match = /\s+as\s+(["`[]?)([A-Za-z_][A-Za-z0-9_]*)[\]"`]?\s*$/i.exec(
    sql,
  );
  if (!match) {
    throw new Error(
      `[Megh ORM] selectRaw("${sql}") needs an alias: "<expression> as <name>".`,
    );
  }
  return match[2];
}

/**
 * A query on one model, e.g. `User.where("active", true).with("posts").get()`.
 * Nothing runs until `get()`, `first()`, `count()`, `paginate()`, `update()`
 * or `delete()` is called. Results are model instances.
 */
export class ModelQuery<
  M,
  P extends string = never,
  S extends ColumnKeys<M> = ColumnKeys<M>,
  /** Extra fields on each result, such as `withCount()` counts. */
  X extends object = {},
  /** How `with()` constraints narrow the loaded relations, by path. */
  E extends object = {},
> {
  private filters: Filter[] = [];
  /** Conditions kept apart from `filters`, so an `orWhere()` there can't widen them. */
  private guards: Filter[] = [];
  private ordering: Step[] = [];
  private limitCount?: number;
  private offsetCount?: number;
  private eager: EagerRequest[] = [];
  private selected?: string[];
  private raws: RawSelect[] = [];
  private aggregates: AggregateRequest[] = [];
  private trashed: TrashedScope = "without";
  private joins: Join[] = [];
  private groups: string[] = [];
  private havings: Filter[] = [];
  private isDistinct = false;
  private distinctColumns: string[] = [];
  private lock?: {
    mode: "update" | "share";
    modifier?: "skipLocked" | "noWait";
  };
  private unions: {
    all: boolean;
    query: ModelQuery<any, any, any, any, any>;
  }[] = [];
  private skippedScopes: Set<string> | "all" = new Set();
  private execOptions: ExecOptions = {};

  constructor(private readonly model: ModelClass<M>) {}

  // ── Where ─────────────────────────────────────────────────────────────

  /** `where(column, value)`: equality; `null` becomes `IS NULL`. */
  where<K extends ColumnRef<M>>(
    column: K,
    value: K extends ColumnKeys<M> ? Columns<M>[K] : unknown,
  ): this;
  /** `where(column, op, value)`, e.g. `where("age", ">=", 18)`. */
  where<K extends ColumnRef<M>>(
    column: K,
    op: ComparisonOperator,
    value: K extends ColumnKeys<M>
      ? Columns<M>[K] | readonly Columns<M>[K][]
      : unknown,
  ): this;
  /**
   * `where(eb => …)`: any Kysely expression, e.g. OR groups:
   * `where(eb => eb.or([eb("role", "=", "admin"), eb("id", "=", 1)]))`.
   */
  where(
    expression: (eb: ExpressionBuilder<any, any>) => Expression<SqlBool>,
  ): this;
  where(...args: any[]): this {
    return this.addWhere(false, args);
  }

  /** Like {@link where}, joined to the conditions before it with `or`. */
  orWhere<K extends ColumnRef<M>>(
    column: K,
    value: K extends ColumnKeys<M> ? Columns<M>[K] : unknown,
  ): this;
  orWhere<K extends ColumnRef<M>>(
    column: K,
    op: ComparisonOperator,
    value: K extends ColumnKeys<M>
      ? Columns<M>[K] | readonly Columns<M>[K][]
      : unknown,
  ): this;
  orWhere(
    expression: (eb: ExpressionBuilder<any, any>) => Expression<SqlBool>,
  ): this;
  orWhere(...args: any[]): this {
    return this.addWhere(true, args);
  }

  private addWhere(or: boolean, args: any[]): this {
    const [column, opOrValue, value] = args;
    if (typeof column === "function") {
      return this.push(or, (eb) => column(eb));
    }
    if (args.length === 2) {
      const op = opOrValue === null ? "is" : "=";
      return this.push(or, (eb, ctx) =>
        eb(this.ref(column, ctx), op, ctx.bind(opOrValue)),
      );
    }
    return this.push(or, (eb, ctx) =>
      eb(
        this.ref(column, ctx),
        opOrValue,
        Array.isArray(value) ? value.map(ctx.bind) : ctx.bind(value),
      ),
    );
  }

  private push(or: boolean, build: Filter["build"]): this {
    this.filters.push({ or, build });
    return this;
  }

  /** @internal A condition no `orWhere()` can widen, for relation queries. */
  guard(column: string, value: unknown): this {
    this.guards.push({
      or: false,
      build: (eb, ctx) =>
        eb(
          this.ref(column, ctx),
          Array.isArray(value) ? "in" : value === null ? "is" : "=",
          Array.isArray(value) ? value.map(ctx.bind) : ctx.bind(value),
        ),
    });
    return this;
  }

  /** Rows whose `column` is in `values`: a list, or a subquery selecting one column. */
  whereIn<K extends ColumnRef<M>>(
    column: K,
    values:
      readonly (K extends ColumnKeys<M> ? Columns<M>[K] : unknown)[] | SubQuery,
  ): this {
    return this.push(false, this.inList(column, values, false));
  }

  whereNotIn<K extends ColumnRef<M>>(
    column: K,
    values:
      readonly (K extends ColumnKeys<M> ? Columns<M>[K] : unknown)[] | SubQuery,
  ): this {
    return this.push(false, this.inList(column, values, true));
  }

  orWhereIn<K extends ColumnRef<M>>(
    column: K,
    values:
      readonly (K extends ColumnKeys<M> ? Columns<M>[K] : unknown)[] | SubQuery,
  ): this {
    return this.push(true, this.inList(column, values, false));
  }

  private inList(
    column: string,
    values: readonly unknown[] | SubQuery,
    not: boolean,
  ): Filter["build"] {
    return (eb, ctx) => {
      const name = this.ref(column, ctx);
      if (isSubQuery(values)) {
        return eb(name, not ? "not in" : "in", values.toKysely());
      }
      // `IN ()` is invalid SQL: nothing is in an empty list, everything is outside it.
      if (values.length === 0) {
        return eb(eb.lit(1), "=", eb.lit(not ? 1 : 0));
      }
      return eb(name, not ? "not in" : "in", values.map(ctx.bind));
    };
  }

  whereNull(column: ColumnRef<M>): this {
    return this.push(false, (eb, ctx) => eb(this.ref(column, ctx), "is", null));
  }

  whereNotNull(column: ColumnRef<M>): this {
    return this.push(false, (eb, ctx) =>
      eb(this.ref(column, ctx), "is not", null),
    );
  }

  orWhereNull(column: ColumnRef<M>): this {
    return this.push(true, (eb, ctx) => eb(this.ref(column, ctx), "is", null));
  }

  orWhereNotNull(column: ColumnRef<M>): this {
    return this.push(true, (eb, ctx) =>
      eb(this.ref(column, ctx), "is not", null),
    );
  }

  /** `whereBetween("views", [10, 100])`: both ends included. */
  whereBetween<K extends ColumnRef<M>>(
    column: K,
    [from, to]: readonly [
      K extends ColumnKeys<M> ? Columns<M>[K] : unknown,
      K extends ColumnKeys<M> ? Columns<M>[K] : unknown,
    ],
  ): this {
    return this.push(false, (eb, ctx) =>
      eb.between(eb.ref(this.ref(column, ctx)), ctx.bind(from), ctx.bind(to)),
    );
  }

  whereNotBetween<K extends ColumnRef<M>>(
    column: K,
    [from, to]: readonly [
      K extends ColumnKeys<M> ? Columns<M>[K] : unknown,
      K extends ColumnKeys<M> ? Columns<M>[K] : unknown,
    ],
  ): this {
    return this.push(false, (eb, ctx) =>
      eb.not(
        eb.between(eb.ref(this.ref(column, ctx)), ctx.bind(from), ctx.bind(to)),
      ),
    );
  }

  /** Compare two columns: `whereColumn("updated_at", ">", "created_at")`. */
  whereColumn(
    left: ColumnRef<M>,
    operator: ComparisonOperator,
    right: ColumnRef<M>,
  ): this {
    return this.push(false, (eb, ctx) =>
      eb(this.ref(left, ctx), operator, eb.ref(this.ref(right, ctx))),
    );
  }

  /** A condition in SQL, with `?` placeholders: `whereRaw("lower(email) = ?", [email])`. */
  whereRaw(sql: string, bindings: readonly unknown[] = []): this {
    return this.push(false, (_eb, ctx) => rawSql(sql, bindings.map(ctx.bind)));
  }

  orWhereRaw(sql: string, bindings: readonly unknown[] = []): this {
    return this.push(true, (_eb, ctx) => rawSql(sql, bindings.map(ctx.bind)));
  }

  /** Rows for which `query` returns a row: `whereExists(DB.table("bans").whereColumn(…))`. */
  whereExists(query: SubQuery): this {
    return this.push(false, (eb) => eb.exists(query.toKysely()));
  }

  whereNotExists(query: SubQuery): this {
    return this.push(false, (eb) => eb.not(eb.exists(query.toKysely())));
  }

  /**
   * Rows with at least one related row (matching `constrain`, if given).
   * Follows dotted paths:
   * `whereHas("posts.comments", q => q.where("body", "like", "%hi%"))`.
   * Runs as an `EXISTS` subquery.
   */
  whereHas<Q extends RelationPaths<M>>(
    relation: Q,
    constrain?: RelationConstraint<ModelAt<M, Q>>,
  ): this {
    return this.whereRelation(relation, constrain, true, false);
  }

  /** Like {@link whereHas}, joined with `or`. */
  orWhereHas<Q extends RelationPaths<M>>(
    relation: Q,
    constrain?: RelationConstraint<ModelAt<M, Q>>,
  ): this {
    return this.whereRelation(relation, constrain, true, true);
  }

  /** Rows with no related row (matching `constrain`, if given). The inverse of {@link whereHas}. */
  whereDoesntHave<Q extends RelationPaths<M>>(
    relation: Q,
    constrain?: RelationConstraint<ModelAt<M, Q>>,
  ): this {
    return this.whereRelation(relation, constrain, false, false);
  }

  private whereRelation(
    path: string,
    constrain: RelationConstraint<any> | undefined,
    exists: boolean,
    or: boolean,
  ): this {
    const [head, ...rest] = path.split(".");
    const def = getRelation(this.model, head);
    const inner: RelationConstraint<any> | undefined =
      rest.length > 0
        ? (q) => (q as any).whereHas(rest.join("."), constrain)
        : constrain;
    return this.push(or, (eb, ctx) => {
      const sub = this.relationSubquery(def, inner, ctx).select(
        eb.lit(1).as("one"),
      );
      return exists ? eb.exists(sub) : eb.not(eb.exists(sub));
    });
  }

  // ── Related aggregates ────────────────────────────────────────────────

  /**
   * Add `<relation>_count` to each result: `withCount("posts", "comments")`,
   * or one relation narrowed by a constraint:
   * `withCount("posts", q => q.where("published", 1))`.
   */
  withCount<N extends RelationKeys<M>>(
    ...relations: N[]
  ): ModelQuery<M, P, S, X & Counted<N>, E>;
  withCount<N extends RelationKeys<M>>(
    relation: N,
    constrain: RelationConstraint<RelatedModel<M[N]>>,
  ): ModelQuery<M, P, S, X & Counted<N>, E>;
  withCount(...args: any[]): any {
    const requests: [string, RelationConstraint<any> | undefined][] =
      typeof args[1] === "function"
        ? [[args[0], args[1]]]
        : args.map((relation) => [relation, undefined]);
    for (const [relation, constrain] of requests) {
      this.addAggregate(relation, "count", undefined, constrain);
    }
    return this;
  }

  /** Add `<relation>_sum_<column>`: `withSum("orders", "total")`. `null` when there are no related rows. */
  withSum<N extends RelationKeys<M>, C extends ColumnKeys<RelatedModel<M[N]>>>(
    relation: N,
    column: C,
    constrain?: RelationConstraint<RelatedModel<M[N]>>,
  ): ModelQuery<M, P, S, X & Aggregated<N, "sum", C, number | null>, E> {
    return this.addAggregate(relation, "sum", column, constrain) as any;
  }

  /** Add `<relation>_avg_<column>`. `null` when there are no related rows. */
  withAvg<N extends RelationKeys<M>, C extends ColumnKeys<RelatedModel<M[N]>>>(
    relation: N,
    column: C,
    constrain?: RelationConstraint<RelatedModel<M[N]>>,
  ): ModelQuery<M, P, S, X & Aggregated<N, "avg", C, number | null>, E> {
    return this.addAggregate(relation, "avg", column, constrain) as any;
  }

  /** Add `<relation>_min_<column>`. `null` when there are no related rows. */
  withMin<N extends RelationKeys<M>, C extends ColumnKeys<RelatedModel<M[N]>>>(
    relation: N,
    column: C,
    constrain?: RelationConstraint<RelatedModel<M[N]>>,
  ): ModelQuery<
    M,
    P,
    S,
    X & Aggregated<N, "min", C, Columns<RelatedModel<M[N]>>[C] | null>,
    E
  > {
    return this.addAggregate(relation, "min", column, constrain) as any;
  }

  /** Add `<relation>_max_<column>`. `null` when there are no related rows. */
  withMax<N extends RelationKeys<M>, C extends ColumnKeys<RelatedModel<M[N]>>>(
    relation: N,
    column: C,
    constrain?: RelationConstraint<RelatedModel<M[N]>>,
  ): ModelQuery<
    M,
    P,
    S,
    X & Aggregated<N, "max", C, Columns<RelatedModel<M[N]>>[C] | null>,
    E
  > {
    return this.addAggregate(relation, "max", column, constrain) as any;
  }

  /** Add `<relation>_exists`, a boolean: `withExists("posts")`. */
  withExists<N extends RelationKeys<M>>(
    relation: N,
    constrain?: RelationConstraint<RelatedModel<M[N]>>,
  ): ModelQuery<M, P, S, X & Existence<N>, E> {
    return this.addAggregate(relation, "exists", undefined, constrain) as any;
  }

  private addAggregate(
    relation: string,
    fn: AggregateFn,
    column: string | undefined,
    constrain: RelationConstraint<any> | undefined,
  ): this {
    const def = getRelation(this.model, relation); // fail fast on unknown relations
    if (def.kind === "morphTo") {
      throw new Error(
        `[Megh ORM] ${this.model.name}.${relation} is a morphTo relation; with${fn[0].toUpperCase()}${fn.slice(1)}() can't aggregate it.`,
      );
    }
    const alias =
      fn === "count" || fn === "exists"
        ? `${relation}_${fn}`
        : `${relation}_${fn}_${column}`;
    this.aggregates.push({ relation, fn, column, constrain, alias });
    return this;
  }

  // ── Scopes and conditions ─────────────────────────────────────────────

  /** Apply a reusable {@link Scope}: `Post.query().scope(byAuthor, 1)`. */
  scope<A extends unknown[]>(scope: Scope<M, A>, ...args: A): this {
    scope(this, ...args);
    return this;
  }

  /** Skip one of the model's `static globalScopes`. */
  withoutGlobalScope(name: string): this {
    if (this.skippedScopes !== "all") this.skippedScopes.add(name);
    return this;
  }

  /** Skip the model's `static globalScopes`: all of them, or those named. */
  withoutGlobalScopes(names?: readonly string[]): this {
    if (!names) this.skippedScopes = "all";
    else for (const name of names) this.withoutGlobalScope(name);
    return this;
  }

  /**
   * Apply `then` when `value` is truthy, else `otherwise`:
   * `query.when(search, (q, term) => q.where("title", "like", `%${term}%`))`.
   */
  when<V>(
    value: V,
    then: (query: this, value: NonNullable<V>) => unknown,
    otherwise?: (query: this) => unknown,
  ): this {
    if (value) then(this, value as NonNullable<V>);
    else otherwise?.(this);
    return this;
  }

  // ── Order and paging ──────────────────────────────────────────────────

  /**
   * Order by `column`. `nulls` puts NULLs first or last on every database
   * (as `case when … is null` where `NULLS FIRST/LAST` isn't supported).
   */
  orderBy(
    column: ColumnRef<M>,
    direction: "asc" | "desc" = "asc",
    nulls?: "first" | "last",
  ): this {
    this.ordering.push((qb, ctx) => {
      const name = this.ref(column, ctx);
      if (nulls) {
        const { sql } = kysely();
        qb = qb.orderBy(
          sql`case when ${sql.ref(name)} is null then ${sql.lit(nulls === "first" ? 0 : 1)} else ${sql.lit(nulls === "first" ? 1 : 0)} end`,
        );
      }
      return qb.orderBy(name, direction);
    });
    return this;
  }

  /** Newest first: `created_at`, or the model's `createdAt`, unless another column is given. */
  latest(column?: ColumnRef<M>): this {
    return this.orderBy(
      column ?? ((this.model.createdAt ?? "created_at") as any),
      "desc",
    );
  }

  /** Oldest first. See {@link latest}. */
  oldest(column?: ColumnRef<M>): this {
    return this.orderBy(
      column ?? ((this.model.createdAt ?? "created_at") as any),
      "asc",
    );
  }

  /** Include soft-deleted rows. */
  withTrashed(): this {
    this.trashed = "with";
    return this;
  }

  /** Only soft-deleted rows. */
  onlyTrashed(): this {
    this.trashed = "only";
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  offset(count: number): this {
    this.offsetCount = count;
    return this;
  }

  // ── Select ────────────────────────────────────────────────────────────

  /** Only fetch these columns. The result type narrows to them. */
  select<K extends keyof Columns<M> & string>(
    ...columns: K[]
  ): ModelQuery<M, P, K, X, E> {
    this.selected = columns;
    return this as unknown as ModelQuery<M, P, K, X, E>;
  }

  /**
   * Also select an expression in SQL, named with `as`:
   * `selectRaw<{ total: number }>("price * qty as total")`. It appears on
   * each result (and in JSON) but is never written back by `save()`.
   */
  selectRaw<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[] = [],
  ): ModelQuery<M, P, S, X & T, E> {
    this.raws.push({ sql, bindings, alias: rawAlias(sql) });
    return this as any;
  }

  /** Leave out duplicate rows. */
  distinct(): this {
    this.isDistinct = true;
    return this;
  }

  /** PostgreSQL only: one row per distinct value of `columns`, the first in the query's order. */
  distinctOn(...columns: ColumnRef<M>[]): this {
    this.distinctColumns.push(...columns);
    return this;
  }

  /**
   * Inner join, e.g. to filter or sort by another table:
   * `Post.query().join("users", "users.id", "posts.user_id").orderBy("users.name")`.
   * Results are still posts: only this model's columns are selected.
   */
  join(table: string, left: string, right: string): this;
  join(table: string, left: string, op: JoinOperator, right: string): this;
  join(table: string, left: string, ...rest: string[]): this {
    return this.addJoin("inner", table, left, rest);
  }

  leftJoin(table: string, left: string, right: string): this;
  leftJoin(table: string, left: string, op: JoinOperator, right: string): this;
  leftJoin(table: string, left: string, ...rest: string[]): this {
    return this.addJoin("left", table, left, rest);
  }

  rightJoin(table: string, left: string, right: string): this;
  rightJoin(table: string, left: string, op: JoinOperator, right: string): this;
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

  groupBy(...columns: ColumnRef<M>[]): this {
    this.groups.push(...columns);
    return this;
  }

  /** A condition on grouped rows: `having("views", ">", 100)`. */
  having(column: string, op: ComparisonOperator, value: unknown): this {
    this.havings.push({
      or: false,
      build: (eb, ctx) => eb(this.ref(column, ctx), op, ctx.bind(value)),
    });
    return this;
  }

  havingRaw(sql: string, bindings: readonly unknown[] = []): this {
    this.havings.push({
      or: false,
      build: (_eb, ctx) => rawSql(sql, bindings.map(ctx.bind)),
    });
    return this;
  }

  /** Add the rows of another query on this model: `union` drops duplicates. */
  union(query: ModelQuery<M, any, any, any, any>): this {
    this.unions.push({ all: false, query });
    return this;
  }

  /** Like {@link union}, keeping duplicates. */
  unionAll(query: ModelQuery<M, any, any, any, any>): this {
    this.unions.push({ all: true, query });
    return this;
  }

  // ── Locks and execution ───────────────────────────────────────────────

  /**
   * `FOR UPDATE`: lock the selected rows until the transaction ends, so
   * nobody else changes them. Use it inside `Model.transaction()`. SQLite
   * locks the whole database for a write already, so this does nothing
   * there; SQL Server isn't supported.
   */
  lockForUpdate(): this {
    this.lock = { ...this.lock, mode: "update" };
    return this;
  }

  /** `FOR SHARE`: others can read the selected rows but not change them. See {@link lockForUpdate}. */
  sharedLock(): this {
    this.lock = { ...this.lock, mode: "share" };
    return this;
  }

  /** With a lock: skip rows another transaction has locked, e.g. for job queues. PostgreSQL and MySQL 8. */
  skipLocked(): this {
    this.lock = { mode: this.lock?.mode ?? "update", modifier: "skipLocked" };
    return this;
  }

  /** With a lock: fail at once instead of waiting for rows another transaction has locked. */
  noWait(): this {
    this.lock = { mode: this.lock?.mode ?? "update", modifier: "noWait" };
    return this;
  }

  /**
   * Stop the query when `signal` aborts, e.g. when the client disconnects.
   * `strategy` says what happens to a query already running: `"ignore
   * query"` (default) stops waiting, `"cancel query"` cancels it on the
   * database (PostgreSQL, MySQL, SQL Server).
   */
  abortSignal(
    signal: AbortSignal | undefined,
    strategy?: InflightQueryAbortStrategy,
  ): this {
    this.execOptions = { signal, inflightQueryAbortStrategy: strategy };
    return this;
  }

  // ── Eager loading ─────────────────────────────────────────────────────

  /**
   * Eager-load relations, nested with dots: `with("posts.comments", "profile")`.
   * Runs one query per relation level, however many rows there are.
   */
  with<Q extends RelationPaths<M>>(
    ...paths: Q[]
  ): ModelQuery<M, P | Q, S, X, E>;
  /**
   * Eager-load a relation through a constraint on its query. A dotted path
   * constrains its last relation; the ones before it load in full.
   *
   * ```ts
   * Todo.with("user", (q) => q.select("name", "role"));
   * User.with("posts", (q) => q.where("published", true).orderBy("id", "desc").limit(3));
   * ```
   *
   * `select()` keeps the keys the loader needs. `limit()` and `offset()`
   * apply to each parent's rows (3 posts per user above), not to the total.
   */
  with<Q extends RelationPaths<M>, R>(
    path: Q,
    constrain: (query: ModelQuery<ModelAt<M, Q>>) => R,
  ): ModelQuery<M, P | Q, S, X, E & ConstrainedAt<Q, R>>;
  /** Several constrained relations: `with({ user: q => q.select("name"), tags: q => q.orderBy("name") })`. */
  with<T extends EagerConstraints<M>>(
    relations: T,
  ): ModelQuery<M, P | (keyof T & string), S, X, E & ConstrainedMap<T>>;
  with(...args: any[]): any {
    const [first, constrain] = args;
    if (typeof constrain === "function") {
      this.eager.push({ path: first, constrain });
    } else if (first !== null && typeof first === "object") {
      for (const [path, fn] of Object.entries(first)) {
        this.eager.push({ path, constrain: fn as RelationConstraint<any> });
      }
    } else {
      for (const path of args) this.eager.push({ path });
    }
    return this;
  }

  // ── Reading ───────────────────────────────────────────────────────────

  async get(): Promise<(Row<M, P, S, E> & X)[]> {
    const ctx = this.context();
    const rows: Record<string, unknown>[] = await this.selectQuery(ctx).execute(
      this.execOptions,
    );
    const models = this.hydrateRows(rows);
    await ModelQuery.eagerLoad(
      this.model,
      models,
      this.eager,
      this.execOptions,
    );
    return models as unknown as (Row<M, P, S, E> & X)[];
  }

  async first(): Promise<(Row<M, P, S, E> & X) | undefined> {
    const [row] = await this.clone().limit(1).get();
    return row;
  }

  /** Like {@link first}, but throws a 404 `NotFoundException` when nothing matches. */
  async firstOrFail(): Promise<Row<M, P, S, E> & X> {
    const row = await this.first();
    if (!row) throw new NotFoundException(`${this.model.name} not found`);
    return row;
  }

  async count(): Promise<number> {
    const db = getConnection();
    const ctx = this.context();
    if (
      this.groups.length > 0 ||
      this.isDistinct ||
      this.distinctColumns.length > 0 ||
      this.unions.length > 0
    ) {
      // Grouped, distinct and union queries are counted as their rows.
      const inner = this.clone();
      inner.ordering = [];
      inner.limitCount = inner.offsetCount = undefined;
      inner.lock = undefined;
      const result = await db
        .selectFrom(inner.selectQuery(ctx).as("megh_count"))
        .select((eb: any) => eb.fn.countAll().as("count"))
        .executeTakeFirst(this.execOptions);
      return Number((result as any)?.count ?? 0);
    }
    const result = await this.base(ctx)
      .select((eb: any) => eb.fn.countAll().as("count"))
      .executeTakeFirst(this.execOptions);
    return Number(result?.count ?? 0);
  }

  async exists(): Promise<boolean> {
    const probe = this.clone();
    probe.aggregates = [];
    probe.raws = [];
    probe.eager = [];
    return (await probe.select().limit(1).get()).length > 0;
  }

  async doesntExist(): Promise<boolean> {
    return !(await this.exists());
  }

  /** One column of every matching row, cast: `await User.query().pluck("email")`. */
  async pluck<K extends ColumnKeys<M>>(column: K): Promise<Columns<M>[K][]> {
    const ctx = this.context();
    let qb = this.base(ctx).select(`${this.ref(column, ctx)} as ${column}`);
    for (const step of this.ordering) qb = step(qb, ctx);
    qb = applyPaging(getConnection(), qb, {
      limit: this.limitCount,
      offset: this.offsetCount,
      ordered: this.ordering.length > 0,
    });
    const rows: any[] = await qb.execute(this.execOptions);
    return rows.map(
      (row) =>
        castFromDatabase(this.model, { [column]: row[column] })[column] as any,
    );
  }

  /** One column of the first matching row, or `undefined`. */
  async value<K extends ColumnKeys<M>>(
    column: K,
  ): Promise<Columns<M>[K] | undefined> {
    const [value] = await this.clone().limit(1).pluck(column);
    return value;
  }

  /** One page of results in the unified `{ data, meta }` shape. */
  async paginate(
    request?: PageRequest,
  ): Promise<Paginated<Row<M, P, S, E> & X>> {
    const { page, perPage, offset } = normalizePageRequest(request);
    const total = await this.count();
    const data = await this.clone().limit(perPage).offset(offset).get();
    return paginated(data, total, page, perPage);
  }

  /**
   * A page of results without counting the total, for large tables or
   * "load more" lists: fetches one extra row to tell whether there is a
   * next page.
   */
  async simplePaginate(
    request?: PageRequest,
  ): Promise<SimplePaginated<Row<M, P, S, E> & X>> {
    const { page, perPage, offset } = normalizePageRequest(request);
    const rows = await this.clone()
      .limit(perPage + 1)
      .offset(offset)
      .get();
    const hasMore = rows.length > perPage;
    return {
      data: rows.slice(0, perPage),
      meta: {
        page,
        perPage,
        hasMore,
        next: hasMore ? page + 1 : null,
        prev: page > 1 ? page - 1 : null,
      },
    };
  }

  /**
   * Keyset ("cursor") pagination: stable under inserts and fast at any depth.
   * Orders by `column` (default: the primary key, which should be unique)
   * before any other `orderBy()`. Pass `meta.nextCursor` back as `cursor`
   * for the next page.
   *
   * ```ts
   * const first = await Post.query().cursorPaginate({ perPage: 20 });
   * const second = await Post.query().cursorPaginate({ perPage: 20, cursor: first.meta.nextCursor });
   * ```
   */
  async cursorPaginate(
    request: CursorPageRequest<keyof Columns<M> & string> = {},
  ): Promise<CursorPaginated<Row<M, P, S, E> & X>> {
    const { perPage } = normalizePageRequest({ perPage: request.perPage });
    const column = request.column ?? this.model.primaryKey;
    const direction = request.direction ?? "asc";
    const query = this.clone();
    if (request.cursor) {
      const after = decodeCursor(request.cursor);
      query.guards.push({
        or: false,
        build: (eb, ctx) =>
          eb(
            this.ref(column, ctx),
            direction === "asc" ? ">" : "<",
            ctx.bind(after),
          ),
      });
    }
    query.ordering.unshift((qb, ctx) =>
      qb.orderBy(this.ref(column, ctx), direction),
    );
    if (query.selected && !query.selected.includes(column)) {
      query.selected.push(column);
    }
    const rows: any[] = await query
      .limit(perPage + 1)
      .offset(0)
      .get();
    const hasMore = rows.length > perPage;
    const data = rows.slice(0, perPage);
    const last = data[data.length - 1];
    return {
      data,
      meta: {
        perPage,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last, column) : null,
      },
    };
  }

  /**
   * Run `fn` on the matching rows `size` at a time, in primary key order,
   * so large tables don't load into memory at once. Return `false` from
   * `fn` to stop. Paging by key (`where id > last`) keeps it correct while
   * `fn` updates or deletes rows. Resolves to `false` if `fn` stopped it.
   */
  async chunk(
    size: number,
    fn: (rows: (Row<M, P, S, E> & X)[], page: number) => unknown,
  ): Promise<boolean> {
    let page = 1;
    for await (const rows of this.pages(size)) {
      if ((await fn(rows, page++)) === false) return false;
    }
    return true;
  }

  /**
   * The matching rows one at a time, fetched `size` at a time (see
   * {@link chunk}), relations included:
   * `for await (const user of User.with("posts").lazy()) { … }`.
   */
  async *lazy(size = 1000): AsyncGenerator<Row<M, P, S, E> & X> {
    for await (const rows of this.pages(size)) yield* rows;
  }

  private async *pages(size: number): AsyncGenerator<(Row<M, P, S, E> & X)[]> {
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new Error(
        `[Megh ORM] The chunk size must be at least 1, got ${size}.`,
      );
    }
    if (this.ordering.length > 0) {
      throw new Error(
        "[Megh ORM] chunk() and lazy() page by primary key and can't keep an orderBy(). Use cursorPaginate() to page in another order.",
      );
    }
    const pk = this.model.primaryKey;
    const pkProp = propertyName(this.model, pk);
    let after: unknown;
    for (;;) {
      const query = this.clone();
      if (after !== undefined) {
        const last = after;
        query.guards.push({
          or: false,
          build: (eb, ctx) => eb(this.ref(pk, ctx), ">", ctx.bind(last)),
        });
      }
      query.ordering = [(qb, ctx) => qb.orderBy(this.ref(pk, ctx), "asc")];
      if (query.selected && !query.selected.includes(pkProp)) {
        query.selected.push(pkProp);
      }
      const rows = await query.limit(size).offset(0).get();
      if (rows.length === 0) return;
      yield rows;
      if (rows.length < size) return;
      after = (rows[rows.length - 1] as any)[pkProp];
    }
  }

  /**
   * The matching rows as the database sends them, without loading them all
   * first: `for await (const user of User.query().stream()) { … }`. Can't
   * eager-load relations (the connection is busy streaming); use
   * {@link lazy} for that.
   */
  async *stream(chunkSize?: number): AsyncGenerator<Row<M, P, S, E> & X> {
    if (this.eager.length > 0) {
      throw new Error(
        "[Megh ORM] stream() can't eager-load relations with with(); use lazy() instead.",
      );
    }
    const ctx = this.context();
    const stream = this.selectQuery(ctx).stream({
      chunkSize,
      signal: this.execOptions.signal,
    });
    for await (const row of stream) {
      yield this.hydrateRows([row])[0] as unknown as Row<M, P, S, E> & X;
    }
  }

  // ── Aggregates ────────────────────────────────────────────────────────

  /** Sum of `column` over matching rows; `0` when none match. */
  async sum(column: ColumnRef<M>): Promise<number> {
    const value = await this.aggregate("sum", column);
    return value === null || value === undefined ? 0 : Number(value);
  }

  /** Average of `column` over matching rows; `null` when none match. */
  async avg(column: ColumnRef<M>): Promise<number | null> {
    const value = await this.aggregate("avg", column);
    return value === null || value === undefined ? null : Number(value);
  }

  /** Smallest value of `column` (with its cast applied); `null` when none match. */
  async min<K extends keyof Columns<M> & string>(
    column: K,
  ): Promise<Columns<M>[K] | null> {
    return this.castAggregate(column, await this.aggregate("min", column));
  }

  /** Largest value of `column` (with its cast applied); `null` when none match. */
  async max<K extends keyof Columns<M> & string>(
    column: K,
  ): Promise<Columns<M>[K] | null> {
    return this.castAggregate(column, await this.aggregate("max", column));
  }

  private async aggregate(
    fn: "sum" | "avg" | "min" | "max",
    column: string,
  ): Promise<unknown> {
    const ctx = this.context();
    const result = await this.base(ctx)
      .select((eb: any) => eb.fn[fn](this.ref(column, ctx)).as("aggregate"))
      .executeTakeFirst(this.execOptions);
    return result?.aggregate ?? null;
  }

  private castAggregate(column: string, value: unknown): any {
    if (value === null || value === undefined) return null;
    return castFromDatabase(this.model, { [column]: value })[column];
  }

  // ── Writing ───────────────────────────────────────────────────────────

  /**
   * Update every matching row (and `updated_at` when the model has
   * timestamps). Returns the number of rows updated.
   */
  async update(values: UpdateInput<M>): Promise<number> {
    return this.write(() => {
      const db = getConnection();
      return db
        .updateTable(tableOf(this.model))
        .set(
          toColumns(
            this.model,
            castToDatabase(
              this.model,
              withTimestamps(
                this.model,
                values as Record<string, unknown>,
                "update",
              ),
              db,
            ),
          ),
        );
    });
  }

  /**
   * Add `amount` (default 1) to `column` on every matching row, setting
   * `extra` columns (and `updated_at`) too. Returns the number of rows updated.
   */
  async increment(
    column: ColumnKeys<M>,
    amount = 1,
    extra: UpdateInput<M> = {},
  ): Promise<number> {
    return this.adjust(column, amount, extra);
  }

  /** Subtract `amount` (default 1) from `column`. See {@link increment}. */
  async decrement(
    column: ColumnKeys<M>,
    amount = 1,
    extra: UpdateInput<M> = {},
  ): Promise<number> {
    return this.adjust(column, -amount, extra);
  }

  private adjust(
    column: string,
    amount: number,
    extra: UpdateInput<M>,
  ): Promise<number> {
    return this.write(() => {
      const db = getConnection();
      const data = toColumns(
        this.model,
        castToDatabase(
          this.model,
          withTimestamps(
            this.model,
            extra as Record<string, unknown>,
            "update",
          ),
          db,
        ),
      );
      const name = this.col(column);
      return db.updateTable(tableOf(this.model)).set((eb: any) => ({
        ...data,
        [name]: eb(name, amount < 0 ? "-" : "+", Math.abs(amount)),
      }));
    });
  }

  private async write(build: () => Builder): Promise<number> {
    if (this.joins.length > 0) {
      throw new Error(
        "[Megh ORM] update() and delete() don't take join(); filter with whereHas() or whereIn() instead.",
      );
    }
    const result = await this.applyFilters(
      build(),
      this.context(),
    ).executeTakeFirst(this.execOptions);
    return Number(result?.numUpdatedRows ?? result?.numDeletedRows ?? 0);
  }

  /**
   * Delete every matching row; soft-deletes when the model has
   * `softDeletes`. Returns the number of rows affected.
   */
  async delete(): Promise<number> {
    if (this.model.softDeletes) {
      return this.update({ [this.model.deletedAt]: new Date() } as any);
    }
    return this.forceDelete();
  }

  /** Delete every matching row permanently, even with `softDeletes`. */
  async forceDelete(): Promise<number> {
    return this.write(() => getConnection().deleteFrom(tableOf(this.model)));
  }

  /** Restore matching soft-deleted rows. Returns the number restored. */
  async restore(): Promise<number> {
    assertSoftDeletes(this.model);
    return this.clone()
      .withTrashed()
      .update({ [this.model.deletedAt]: null } as any);
  }

  // ── Inspecting ────────────────────────────────────────────────────────

  /** The SQL and parameters `get()` would run, for debugging. */
  toSQL(): { sql: string; parameters: readonly unknown[] } {
    const { sql, parameters } = this.selectQuery(this.context()).compile();
    return { sql, parameters };
  }

  /** @internal The query as a Kysely select, for subqueries. */
  toKysely(): Builder {
    return this.selectQuery(this.context());
  }

  clone(): ModelQuery<M, P, S, X, E> {
    const copy = new ModelQuery<M, P, S, X, E>(this.model);
    copy.filters = [...this.filters];
    copy.guards = [...this.guards];
    copy.ordering = [...this.ordering];
    copy.limitCount = this.limitCount;
    copy.offsetCount = this.offsetCount;
    copy.eager = [...this.eager];
    copy.selected = this.selected && [...this.selected];
    copy.raws = [...this.raws];
    copy.aggregates = [...this.aggregates];
    copy.trashed = this.trashed;
    copy.joins = [...this.joins];
    copy.groups = [...this.groups];
    copy.havings = [...this.havings];
    copy.isDistinct = this.isDistinct;
    copy.distinctColumns = [...this.distinctColumns];
    copy.lock = this.lock && { ...this.lock };
    copy.unions = [...this.unions];
    copy.skippedScopes =
      this.skippedScopes === "all" ? "all" : new Set(this.skippedScopes);
    copy.execOptions = this.execOptions;
    return copy;
  }

  // ── Building ──────────────────────────────────────────────────────────

  /** The column for a property of this query's model. */
  private col(name: string): string {
    return columnName(this.model, name);
  }

  /** A column as the SQL names it: qualified when the query joins tables. */
  private ref(name: string, ctx: BuildContext): string {
    if (name.includes(".")) return name;
    return ctx.qualify ? `${ctx.ref}.${this.col(name)}` : this.col(name);
  }

  private context(): BuildContext {
    const sqlite = isSqlite(getConnection());
    return {
      bind: (value) => bindable(value, sqlite),
      ref: tableOf(this.model),
      depth: 0,
      qualify: this.joins.length > 0,
    };
  }

  /** Whether `applyFilters()` adds anything beyond the soft-delete scope. */
  private hasFilters(): boolean {
    return (
      this.filters.length > 0 ||
      this.guards.length > 0 ||
      this.activeScopes().length > 0
    );
  }

  private activeScopes(): [string, (q: any) => unknown][] {
    const scopes = this.model.globalScopes;
    if (!scopes || this.skippedScopes === "all") return [];
    const skipped = this.skippedScopes;
    return Object.entries(scopes).filter(([name]) => !skipped.has(name));
  }

  /** `where`: the query's own conditions (one group), its guards, global scopes and soft-delete scope. */
  private applyFilters(qb: Builder, ctx = this.context()): Builder {
    qb = whereAll(qb, this.filters, ctx);
    qb = whereAll(qb, this.guards, ctx);
    for (const [, scope] of this.activeScopes()) {
      const scoped = new ModelQuery<any>(this.model);
      scoped.skippedScopes = "all";
      scope(scoped);
      qb = whereAll(qb, scoped.filters, ctx);
      qb = whereAll(qb, scoped.guards, ctx);
    }
    if (this.model.softDeletes && this.trashed !== "with") {
      qb = qb.where(
        this.ref(this.model.deletedAt, ctx),
        this.trashed === "only" ? "is not" : "is",
        null,
      );
    }
    return qb;
  }

  /** `from` with joins, `where`, `group by` and `having`: no select list. */
  private base(ctx: BuildContext): Builder {
    let qb: Builder = getConnection().selectFrom(tableOf(this.model));
    for (const join of this.joins) {
      const method = {
        inner: "innerJoin",
        left: "leftJoin",
        right: "rightJoin",
      }[join.kind];
      qb =
        join.op === "="
          ? qb[method](join.table, join.left, join.right)
          : qb[method](join.table, (on: any) =>
              on.on(join.left, join.op, on.ref(join.right)),
            );
    }
    qb = this.applyFilters(qb, ctx);
    if (this.groups.length > 0) {
      qb = qb.groupBy(this.groups.map((g) => this.ref(g, ctx)));
    }
    if (this.havings.length > 0) {
      qb = qb.having((eb: any) => combine(eb, this.havings, ctx));
    }
    return qb;
  }

  /** The full select `get()` runs. */
  private selectQuery(ctx: BuildContext): Builder {
    const db = getConnection();
    let qb = this.selectList(
      this.base(ctx),
      ctx,
      ctx.qualify ? ctx.ref : undefined,
    );
    if (this.isDistinct) qb = qb.distinct();
    if (this.distinctColumns.length > 0) {
      if (!usesAdapter(db, "PostgresAdapter")) {
        throw new Error("[Megh ORM] distinctOn() works on PostgreSQL only.");
      }
      qb = qb.distinctOn(this.distinctColumns.map((c) => this.ref(c, ctx)));
    }
    for (const { all, query } of this.unions) {
      const part = query.selectList(
        query.base(query.context()),
        query.context(),
      );
      qb = all ? qb.unionAll(part) : qb.union(part);
    }
    for (const step of this.ordering) qb = step(qb, ctx);
    qb = applyPaging(db, qb, {
      limit: this.limitCount,
      offset: this.offsetCount,
      ordered: this.ordering.length > 0,
    });
    return this.applyLock(db, qb);
  }

  private applyLock(
    db: ReturnType<typeof getConnection>,
    qb: Builder,
  ): Builder {
    if (!this.lock || isSqlite(db)) return qb;
    if (usesAdapter(db, "MssqlAdapter")) {
      throw new Error(
        "[Megh ORM] lockForUpdate() and sharedLock() aren't supported on SQL Server.",
      );
    }
    qb = this.lock.mode === "update" ? qb.forUpdate() : qb.forShare();
    if (this.lock.modifier === "skipLocked") qb = qb.skipLocked();
    if (this.lock.modifier === "noWait") qb = qb.noWait();
    return qb;
  }

  /**
   * Selected columns plus the keys eager loading needs, or `undefined` for
   * all. Grouped and distinct queries keep exactly their columns: an added
   * key would change which rows they return.
   */
  private selectedColumns(): string[] | undefined {
    if (!this.selected) return undefined;
    const columns = new Set(this.selected.map((c) => this.col(c)));
    if (
      this.groups.length > 0 ||
      this.isDistinct ||
      this.distinctColumns.length > 0
    ) {
      return [...columns];
    }
    columns.add(this.col(this.model.primaryKey));
    for (const { path } of this.eager) {
      const def = getRelation(this.model, path.split(".")[0]);
      if (def.kind === "belongsTo") columns.add(this.col(def.foreignKey));
      else if (def.kind === "morphTo") {
        columns.add(this.col(def.foreignKey));
        columns.add(this.col(def.morph!.type));
      } else columns.add(this.col(def.localKey));
    }
    return [...columns];
  }

  /**
   * Add the select list: the selected columns (prefixed with `table.` when
   * given, for joins) or all of them, `selectRaw()` expressions and the
   * related aggregates.
   */
  private selectList(qb: Builder, ctx: BuildContext, table?: string): Builder {
    const columns = this.selectedColumns();
    if (!columns) {
      qb = table ? qb.selectAll(table) : qb.selectAll();
    } else {
      qb = qb.select(table ? columns.map((c) => `${table}.${c}`) : columns);
    }
    for (const raw of this.raws) {
      qb = qb.select(rawSql(raw.sql, raw.bindings.map(ctx.bind)));
    }
    for (const request of this.aggregates) {
      qb = qb.select((eb: any) => this.aggregateColumn(eb, request, ctx));
    }
    return qb;
  }

  /** A related aggregate as a correlated subquery. */
  private aggregateColumn(
    eb: any,
    { relation, fn, column, constrain, alias }: AggregateRequest,
    ctx: BuildContext,
  ): any {
    const def = getRelation(this.model, relation);
    const related = def.related() as unknown as ModelClass;
    const sub = this.relationSubquery(def, constrain, ctx, !!column);
    if (fn === "exists") {
      return eb
        .case()
        .when(eb.exists(sub.select(eb.lit(1).as("one"))))
        .then(1)
        .else(0)
        .end()
        .as(alias);
    }
    if (fn === "count") {
      return sub.select(eb.fn.countAll().as("count")).as(alias);
    }
    const target = `megh_r${ctx.depth + 1}.${columnName(related, column!)}`;
    return sub.select(eb.fn[fn](target).as("aggregate")).as(alias);
  }

  /** Model instances from result rows, with aggregates and `selectRaw()` values as extras. */
  private hydrateRows(rows: Record<string, unknown>[]): M[] {
    return rows.map((row) => {
      const extras: Record<string, unknown> = {};
      for (const { fn, alias } of this.aggregates) {
        const value = row[alias];
        delete row[alias];
        // Postgres returns count(*) and sums as strings.
        extras[alias] =
          fn === "count"
            ? Number(value ?? 0)
            : fn === "exists"
              ? Boolean(Number(value))
              : value === null || value === undefined
                ? null
                : fn === "sum" || fn === "avg"
                  ? Number(value)
                  : value;
      }
      for (const { alias } of this.raws) {
        extras[alias] = row[alias];
        delete row[alias];
      }
      const model = hydrate(this.model, row);
      for (const [key, value] of Object.entries(extras)) {
        defineExtra(model as object, key, value);
      }
      return model;
    });
  }

  /**
   * `from <related> where <related row belongs to the outer row>`, plus the
   * related query's filters (from `constrain`) and soft-delete scope. The
   * caller adds the select list. The related table is aliased
   * `megh_r<depth>`, so self-referencing relations work. `joinRelated`
   * makes the related table's columns available for many-to-many relations
   * (whose subquery otherwise reads only the pivot table).
   */
  private relationSubquery(
    def: RelationDefinition,
    constrain: RelationConstraint<any> | undefined,
    outer: BuildContext,
    joinRelated = false,
  ): Builder {
    if (def.kind === "morphTo") {
      throw new Error(
        "[Megh ORM] whereHas() and related aggregates don't support morphTo relations.",
      );
    }
    const related = def.related() as unknown as ModelClass;
    const query = new ModelQuery<any>(related);
    constrain?.(query);
    const depth = outer.depth + 1;
    const alias = `megh_r${depth}`;
    const inner: BuildContext = { bind: outer.bind, ref: alias, depth };
    const db = getConnection();
    const outerKey = (key: string) => `${outer.ref}.${this.col(key)}`;

    if (def.kind === "belongsToMany") {
      const pivot = def.pivot!;
      const pivotAlias = `megh_p${depth}`;
      const relatedKey = columnName(related, pivot.relatedKey);
      let qb: Builder = db
        .selectFrom(`${pivot.table} as ${pivotAlias}`)
        .whereRef(
          `${pivotAlias}.${def.foreignKey}`,
          "=",
          outerKey(def.localKey),
        );
      if (joinRelated) {
        qb = qb.innerJoin(
          `${tableOf(related)} as ${alias}`,
          `${alias}.${relatedKey}`,
          `${pivotAlias}.${pivot.relatedPivotKey}`,
        );
      }
      if (query.hasFilters() || related.softDeletes) {
        // A separate subquery keeps unqualified columns in `constrain`
        // pointing at the related table, not the pivot.
        const keysAlias = `megh_k${depth}`;
        const keys = query.applyFilters(
          db
            .selectFrom(`${tableOf(related)} as ${keysAlias}`)
            .select(`${keysAlias}.${relatedKey}`),
          { ...inner, ref: keysAlias },
        );
        qb = qb.where(`${pivotAlias}.${pivot.relatedPivotKey}`, "in", keys);
      }
      return qb;
    }

    if (def.kind === "hasManyThrough" || def.kind === "hasOneThrough") {
      const through = def.through!;
      const throughClass = through.model() as unknown as ModelClass;
      const throughAlias = `megh_t${depth}`;
      let keys: Builder = db
        .selectFrom(`${tableOf(throughClass)} as ${throughAlias}`)
        .select(`${throughAlias}.${through.secondLocalKey}`)
        .whereRef(
          `${throughAlias}.${def.foreignKey}`,
          "=",
          outerKey(def.localKey),
        );
      if (throughClass.softDeletes) {
        keys = keys.where(
          `${throughAlias}.${columnName(throughClass, throughClass.deletedAt)}`,
          "is",
          null,
        );
      }
      return query.applyFilters(
        db
          .selectFrom(`${tableOf(related)} as ${alias}`)
          .where(
            `${alias}.${columnName(related, through.secondKey)}`,
            "in",
            keys,
          ),
        inner,
      );
    }

    // belongsTo: outer.foreignKey → related.localKey (owner key)
    // hasMany/hasOne/morphMany/morphOne: outer.localKey → related.foreignKey
    const [ownKey, relatedKey] =
      def.kind === "belongsTo"
        ? [def.foreignKey, def.localKey]
        : [def.localKey, def.foreignKey];
    let qb: Builder = db
      .selectFrom(`${tableOf(related)} as ${alias}`)
      .whereRef(
        `${alias}.${columnName(related, relatedKey)}`,
        "=",
        outerKey(ownKey),
      );
    if (def.morph?.value !== undefined) {
      qb = qb.where(
        `${alias}.${columnName(related, def.morph.type)}`,
        "=",
        def.morph.value,
      );
    }
    return query.applyFilters(qb, inner);
  }

  /**
   * Run a filtered, selected eager-load query. `limit()` and `offset()`
   * apply to each parent's rows, told apart by `partition` (the column
   * linking a row to its parent): `row_number() over (partition by …)`
   * numbers each parent's rows in the query's order, and an outer query
   * keeps the requested range.
   */
  private async eagerRows(
    qb: Builder,
    partition: string,
    ctx: BuildContext,
  ): Promise<Record<string, unknown>[]> {
    if (this.limitCount === undefined && this.offsetCount === undefined) {
      for (const step of this.ordering) qb = step(qb, ctx);
      return qb.execute(this.execOptions);
    }
    qb = qb.select((eb: any) =>
      eb.fn
        .agg("row_number")
        .over((ob: any) => {
          ob = ob.partitionBy(partition);
          // SQL Server requires an order here; the key keeps it stable.
          if (this.ordering.length === 0) {
            return ob.orderBy(`${ctx.ref}.${this.col(this.model.primaryKey)}`);
          }
          for (const step of this.ordering) ob = step(ob, ctx);
          return ob;
        })
        .as(ROW_NUMBER),
    );
    const from = this.offsetCount ?? 0;
    const rowNumber = `${WINDOW}.${ROW_NUMBER}`;
    let outer: Builder = getConnection()
      .selectFrom(qb.as(WINDOW))
      .selectAll(WINDOW)
      .where(rowNumber, ">", from);
    if (this.limitCount !== undefined) {
      outer = outer.where(rowNumber, "<=", from + this.limitCount);
    }
    // Each parent's rows are numbered in the query's order, so the row
    // number orders them; the ordering columns may not be selected.
    outer = outer.orderBy(rowNumber);
    const rows: Record<string, unknown>[] = await outer.execute(
      this.execOptions,
    );
    for (const row of rows) delete row[ROW_NUMBER];
    return rows;
  }

  /** The related query for one `with()` node: constraints, nested paths and the parent's abort signal. */
  private static relatedQuery(
    related: ModelClass,
    node: EagerNode,
    options: ExecOptions,
  ): ModelQuery<any> {
    const query = new ModelQuery<any>(related);
    for (const constrain of node.constraints) constrain(query);
    query.eager.push(...node.nested);
    query.execOptions = options;
    return query;
  }

  /** Load `requests` onto `parents` (instances of `cls`): one query per relation level. */
  private static async eagerLoad(
    cls: ModelClass,
    parents: any[],
    requests: EagerRequest[],
    options: ExecOptions,
  ): Promise<void> {
    if (parents.length === 0 || requests.length === 0) return;

    // "posts.comments", "posts" (constrained), "profile"
    //   → posts: { constraints: [fn], nested: ["comments"] }, profile: {}
    const tree = new Map<string, EagerNode>();
    for (const { path, constrain } of requests) {
      const [head, ...rest] = path.split(".");
      let node = tree.get(head);
      if (!node) tree.set(head, (node = { constraints: [], nested: [] }));
      if (rest.length > 0) {
        node.nested.push({ path: rest.join("."), constrain });
      } else if (constrain) {
        node.constraints.push(constrain);
      }
    }

    for (const [name, node] of tree) {
      const def = getRelation(cls, name);
      if (def.kind === "morphTo") {
        await ModelQuery.loadMorphTo(cls, def, node, parents, name, options);
        continue;
      }
      const related = def.related() as unknown as ModelClass;
      const query = ModelQuery.relatedQuery(related, node, options);
      if (def.kind === "belongsToMany") {
        await ModelQuery.loadPivot(def, query, parents, name);
        continue;
      }
      if (def.kind === "hasManyThrough" || def.kind === "hasOneThrough") {
        await ModelQuery.loadThrough(def, query, parents, name);
        continue;
      }
      if (def.morph?.value !== undefined) {
        query.guard(def.morph.type, def.morph.value);
      }
      // belongsTo: parent.foreignKey → related.localKey (owner key)
      // hasMany/hasOne/morphMany/morphOne: parent.localKey → related.foreignKey
      const [parentKey, relatedKey] =
        def.kind === "belongsTo"
          ? [def.foreignKey, def.localKey]
          : [def.localKey, def.foreignKey];

      const parentProp = propertyName(cls, parentKey);
      const relatedProp = propertyName(related, relatedKey);
      const keys = uniqueKeys(parents, parentProp);
      const children: any[] =
        keys.length === 0 ? [] : await query.eagerFor(relatedProp, keys);

      const groups = groupBy(children, (child) => child[relatedProp]);
      const many = def.kind === "hasMany" || def.kind === "morphMany";
      for (const parent of parents) {
        const matches = groups.get(parent[parentProp]) ?? [];
        parent[name] = many ? matches : (matches[0] ?? null);
      }
    }
  }

  /** Rows whose `prop` is one of `keys`, with their own relations loaded. */
  private async eagerFor(prop: string, keys: unknown[]): Promise<any[]> {
    // The loader matches children to parents by this key.
    if (this.selected && !this.selected.includes(prop))
      this.selected.push(prop);
    this.guard(prop, keys);
    const ctx = this.context();
    const qb = this.selectList(
      this.base(ctx),
      ctx,
      ctx.qualify ? ctx.ref : undefined,
    );
    const rows = await this.eagerRows(
      qb,
      this.ref(prop, { ...ctx, qualify: true }),
      ctx,
    );
    const models = this.hydrateRows(rows);
    await ModelQuery.eagerLoad(
      this.model,
      models,
      this.eager,
      this.execOptions,
    );
    return models;
  }

  /** morphTo: one query per target model the parents' type column names. */
  private static async loadMorphTo(
    cls: ModelClass,
    def: RelationDefinition,
    node: EagerNode,
    parents: any[],
    name: string,
    options: ExecOptions,
  ): Promise<void> {
    const idProp = propertyName(cls, def.foreignKey);
    const typeProp = propertyName(cls, def.morph!.type);
    const targets = def.morph!.targets!() as unknown as ModelClass[];
    for (const parent of parents) parent[name] = null;
    const byType = groupBy(
      parents.filter((p) => p[typeProp] != null && p[idProp] != null),
      (p) => p[typeProp],
    );
    for (const [type, group] of byType) {
      const target = targets.find((t) => morphTypeOf(t) === type);
      if (!target) {
        throw new Error(
          `[Megh ORM] ${cls.name}.${name}: no morphTo target has type "${type}". Targets: ${targets.map((t) => morphTypeOf(t)).join(", ")}.`,
        );
      }
      const query = ModelQuery.relatedQuery(target, node, options);
      const ownerProp = propertyName(target, morphOwnerKey(def, target));
      const children = await query.eagerFor(
        ownerProp,
        uniqueKeys(group, idProp),
      );
      const byKey = new Map(children.map((c) => [c[ownerProp], c]));
      for (const parent of group)
        parent[name] = byKey.get(parent[idProp]) ?? null;
    }
  }

  /** hasManyThrough/hasOneThrough: one join query through the intermediate table. */
  private static async loadThrough(
    def: RelationDefinition,
    query: ModelQuery<any>,
    parents: any[],
    name: string,
  ): Promise<void> {
    const related = query.model;
    const through = def.through!;
    const throughClass = through.model() as unknown as ModelClass;
    const owner: Function = parents[0]?.constructor ?? Object;
    const localProp = propertyName(owner, def.localKey);
    const keys = uniqueKeys(parents, localProp);

    let rows: Record<string, unknown>[] = [];
    if (keys.length > 0) {
      const db = getConnection();
      const table = tableOf(related);
      const throughTable = tableOf(throughClass);
      const ctx = { ...query.context(), qualify: true };
      let qb: Builder = query
        .selectList(
          db
            .selectFrom(table)
            .innerJoin(
              throughTable,
              `${throughTable}.${through.secondLocalKey}`,
              `${table}.${columnName(related, through.secondKey)}`,
            ),
          ctx,
          table,
        )
        .select(`${throughTable}.${def.foreignKey} as ${THROUGH_KEY}`)
        .where(`${throughTable}.${def.foreignKey}`, "in", keys);
      if (throughClass.softDeletes) {
        qb = qb.where(
          `${throughTable}.${columnName(throughClass, throughClass.deletedAt)}`,
          "is",
          null,
        );
      }
      qb = query.filterByKey(db, qb, table, ctx);
      rows = await query.eagerRows(
        qb,
        `${throughTable}.${def.foreignKey}`,
        ctx,
      );
    }

    const children: any[] = [];
    const parentKeys: unknown[] = [];
    for (const row of rows) {
      parentKeys.push(row[THROUGH_KEY]);
      delete row[THROUGH_KEY];
      children.push(query.hydrateRows([row])[0]);
    }
    await ModelQuery.eagerLoad(
      related,
      children,
      query.eager,
      query.execOptions,
    );

    const groups = new Map<unknown, any[]>();
    children.forEach((child, i) => {
      const key = parentKeys[i];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(child);
    });
    const many = def.kind === "hasManyThrough";
    for (const parent of parents) {
      const matches = groups.get(parent[localProp]) ?? [];
      parent[name] = many ? matches : (matches[0] ?? null);
    }
  }

  /**
   * For eager loads that join another table: this query's filters, scopes
   * and soft-delete scope as `table.key in (select key from table where …)`,
   * so their unqualified columns can't be ambiguous.
   */
  private filterByKey(
    db: ReturnType<typeof getConnection>,
    qb: Builder,
    table: string,
    ctx: BuildContext,
  ): Builder {
    if (
      !this.hasFilters() &&
      !(this.model.softDeletes && this.trashed !== "with")
    ) {
      return qb;
    }
    const key = this.col(this.model.primaryKey);
    const alias = "megh_r1";
    return qb.where(
      `${table}.${key}`,
      "in",
      this.applyFilters(
        db.selectFrom(`${table} as ${alias}`).select(`${alias}.${key}`),
        { ...ctx, ref: alias, depth: 1 },
      ),
    );
  }

  /**
   * @internal Many-to-many: one join query through the pivot table per
   * level, narrowed by `query` (the related model's, with any `with()`
   * constraint applied). Used by eager loading and `PivotRelation`.
   */
  static async loadPivot(
    def: RelationDefinition,
    query: ModelQuery<any>,
    parents: any[],
    name: string,
  ): Promise<void> {
    const related = query.model;
    const pivot = def.pivot!;
    // Plain objects (PivotRelation.get) have no mapping, so the key is read as is.
    const owner: Function = parents[0]?.constructor ?? Object;
    const localProp = propertyName(owner, def.localKey);
    const keys = uniqueKeys(parents, localProp);

    let rows: Record<string, unknown>[] = [];
    if (keys.length > 0) {
      const db = getConnection();
      const table = tableOf(related);
      const relatedKey = columnName(related, pivot.relatedKey);
      // Qualified: the pivot table may share column names with the related one.
      const ctx = { ...query.context(), qualify: true };
      const pivotColumns = [
        ...new Set([def.foreignKey, pivot.relatedPivotKey, ...pivot.columns]),
      ];
      let qb: Builder = query
        .selectList(
          db
            .selectFrom(table)
            .innerJoin(
              pivot.table,
              `${pivot.table}.${pivot.relatedPivotKey}`,
              `${table}.${relatedKey}`,
            ),
          ctx,
          table,
        )
        .select(
          pivotColumns.map((c) => `${pivot.table}.${c} as ${PIVOT_PREFIX}${c}`),
        )
        .where(`${pivot.table}.${def.foreignKey}`, "in", keys);
      if (related.softDeletes && query.trashed !== "with") {
        qb = qb.where(
          `${table}.${columnName(related, related.deletedAt)}`,
          query.trashed === "only" ? "is not" : "is",
          null,
        );
      }
      if (query.hasFilters()) {
        // A subquery keeps unqualified columns in the constraint pointing
        // at the related table, not the pivot.
        const alias = "megh_r1";
        qb = qb.where(
          `${table}.${relatedKey}`,
          "in",
          query.applyFilters(
            db
              .selectFrom(`${table} as ${alias}`)
              .select(`${alias}.${relatedKey}`),
            { ...ctx, ref: alias, depth: 1 },
          ),
        );
      }
      rows = await query.eagerRows(qb, `${pivot.table}.${def.foreignKey}`, ctx);
    }

    const children = rows.map((row) => {
      const own: Record<string, unknown> = {};
      const pivotValues: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (key.startsWith(PIVOT_PREFIX)) {
          pivotValues[key.slice(PIVOT_PREFIX.length)] = value;
        } else {
          own[key] = value;
        }
      }
      const [child] = query.hydrateRows([own]);
      defineExtra(child as object, "pivot", pivotValues);
      return child as any;
    });
    await ModelQuery.eagerLoad(
      related,
      children,
      query.eager,
      query.execOptions,
    );

    const groups = groupBy(children, (child) => child.pivot[def.foreignKey]);
    for (const parent of parents) {
      parent[name] = groups.get(parent[localProp]) ?? [];
    }
  }
}

/** One relation in a `with()` tree: its constraints and the paths below it. */
interface EagerNode {
  constraints: RelationConstraint<any>[];
  nested: EagerRequest[];
}

function uniqueKeys(rows: any[], prop: string): unknown[] {
  return [
    ...new Set(
      rows.map((r) => r[prop]).filter((k) => k !== null && k !== undefined),
    ),
  ];
}

function groupBy<T>(items: T[], key: (item: T) => unknown): Map<unknown, T[]> {
  const groups = new Map<unknown, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(item);
  }
  return groups;
}

/** A `belongsToMany` relation's related rows, set as `parents[i][name]`. */
export async function loadBelongsToMany(
  def: RelationDefinition,
  related: ModelClass,
  parents: any[],
  name: string,
): Promise<void> {
  await ModelQuery.loadPivot(def, new ModelQuery<any>(related), parents, name);
}

/**
 * Set a computed value (pivot row, relation count) on a model instance. Not
 * enumerable, so `save()` never writes it as a column; `toJSON()` includes it.
 */
export function defineExtra(instance: object, key: string, value: unknown) {
  Object.defineProperty(instance, key, {
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

export function assertSoftDeletes(cls: ModelClass) {
  if (!cls.softDeletes) {
    throw new Error(
      `[Megh ORM] ${cls.name} does not use soft deletes. Add \`static readonly softDeletes = true\`.`,
    );
  }
}
