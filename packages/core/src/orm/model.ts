/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 */
import type {
  Expression,
  ExpressionBuilder,
  Kysely,
  SqlBool,
  Transaction,
} from "kysely";
import { NotFoundException } from "./core";
import type { PageRequest, Paginated } from "./core";
import { getConnection, runInTransaction, setConnection } from "./connection";
import { castFromDatabase, castToDatabase, type Cast } from "./casts";
import { DB } from "./db";
import { addListener, fire, type ModelEvent } from "./events";
import { HasRelation } from "./has-relation";
import { columnName, toColumns, toProperties } from "./naming";
import { PivotRelation } from "./pivot";
import {
  ModelQuery,
  assertSoftDeletes,
  type ComparisonOperator,
  type Counted,
  type CursorPageRequest,
  type CursorPaginated,
  type ConstrainedAt,
  type ConstrainedMap,
  type EagerConstraints,
  type ModelAt,
  type RelationConstraint,
  type Scope,
  type SimplePaginated,
} from "./query";
import { getRelation, getRelations, isRelationMarker } from "./relations";
import {
  changedValues,
  columnValues,
  emptyInstance,
  getState,
  insertRow,
  markDeleted,
  markPersisted,
  tableOf,
  updateRow,
  withTimestamps,
} from "./state";
import type {
  BelongsToManyKeys,
  ColumnKeys,
  Columns,
  CreateInput,
  HasRelationKeys,
  IsManyRelation,
  ModelClass,
  PivotOf,
  PrimaryKeyValue,
  RelatedModel,
  RelationKeys,
  RelationPaths,
  Row,
  UpdateInput,
} from "./types";

type Instance<C extends ModelClass> = InstanceType<C>;

/** Per-instance `makeVisible()` / `makeHidden()` overrides of `static hidden`. */
const visibility = new WeakMap<
  object,
  { shown: Set<string>; hidden: Set<string> }
>();

function visibilityOf(instance: object) {
  let entry = visibility.get(instance);
  if (!entry) {
    visibility.set(instance, (entry = { shown: new Set(), hidden: new Set() }));
  }
  return entry;
}

/** A value as JSON sees it: models (also inside arrays) by their `toJSON()`. */
function serialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(serialize);
  if (value instanceof Model) return value.toJSON();
  return value;
}

/**
 * Base class for models.
 *
 * ```ts
 * class User extends Model {
 *   static readonly table = "users";
 *
 *   id: number;
 *   email: string;
 *   name: string | null;
 *
 *   posts = hasMany(() => Post);
 * }
 *
 * const users = await User.where("email", "like", "%@acme.io").with("posts").get();
 * ```
 *
 * Every field that is not a method, a relation or a getter is a column.
 * Columns must not be `readonly`: read-only properties are treated as
 * computed values.
 *
 * Opt-in behaviour, set as static fields:
 *
 * - `timestamps = true`: fill `created_at` / `updated_at`
 * - `softDeletes = true`: `delete()` sets `deleted_at`; queries skip those rows
 * - `casts = { is_admin: "boolean", settings: "json" }`: convert stored values
 * - `hidden = ["password"]`: leave columns out of `toJSON()` (and API responses)
 * - `globalScopes = { active: (q) => q.where("active", true) }`: filter every query
 */
export abstract class Model {
  /** Table name. Required. */
  static readonly table: string;
  /** Primary key column. */
  static readonly primaryKey: string = "id";
  /**
   * Columns the database fills in, optional in `create()`. Declare a literal
   * (`["id", "created_at"] as const`) to override the default `["id"]`.
   */
  static readonly generated: readonly string[] = ["id"];

  /** Fill `createdAt` on insert and `updatedAt` on every write. */
  static readonly timestamps: boolean = false;
  /** `null` when the model has no such column (`@CreatedAt` without `@UpdatedAt`). */
  static readonly createdAt: string | null = "created_at";
  static readonly updatedAt: string | null = "updated_at";

  /**
   * `delete()` sets `deletedAt` instead of removing the row, and queries
   * leave such rows out unless `withTrashed()` / `onlyTrashed()` is used.
   */
  static readonly softDeletes: boolean = false;
  static readonly deletedAt: string = "deleted_at";

  /**
   * Column casts, e.g. `{ is_admin: "boolean", settings: "json" }`.
   * Timestamp and soft-delete columns are cast as `"datetime"` already.
   */
  static readonly casts: Readonly<Record<string, Cast>> = {};

  /** Properties `toJSON()` leaves out, e.g. `["password"]`. `makeVisible()` shows them on one instance. */
  static readonly hidden: readonly string[] = [];

  /**
   * When set, the only columns `toJSON()` includes. Loaded relations,
   * counts and `appends` are still included.
   */
  static readonly visible: readonly string[] | null = null;

  /** Getters `toJSON()` adds: `appends = ["full_name"]` with `get full_name()`. */
  static readonly appends: readonly string[] = [];

  /**
   * Filters every query on the model applies, by name. Skip them with
   * `withoutGlobalScope(name)` / `withoutGlobalScopes()`. Only `where`
   * conditions count.
   *
   * ```ts
   * static readonly globalScopes = {
   *   published: (q: ModelQuery<Post>) => q.whereNotNull("published_at"),
   * };
   * ```
   */
  static readonly globalScopes: Readonly<
    Record<string, (query: any) => unknown>
  > = {};

  /** The value polymorphic `<name>_type` columns store for this model. Defaults to the table name. */
  static readonly morphType?: string;

  // ── Connection ──────────────────────────────────────────────────────────

  /**
   * Set the connection models use. `app.useDatabase(kysely)` does this for
   * apps; call it directly in scripts and tests.
   */
  static useConnection(db: Kysely<any>): void {
    setConnection(db);
  }

  /**
   * The Kysely instance for raw queries: the current transaction inside
   * {@link Model.transaction}, else the root connection. Type it with
   * `DatabaseOf`: `Model.db<DatabaseOf<typeof User | typeof Post>>()`.
   */
  static db<DB = any>(): Kysely<DB> {
    return getConnection() as Kysely<DB>;
  }

  /**
   * Run `fn` in a transaction that every model query inside it uses, however
   * deep in the call chain. Commits when `fn` resolves, rolls back if it
   * throws. A nested call runs in a savepoint: if it throws, only its own
   * work is rolled back (and the error still propagates).
   */
  static transaction<T>(fn: (trx: Transaction<any>) => Promise<T>): Promise<T> {
    return runInTransaction(fn, { savepoint: true });
  }

  // ── Events ──────────────────────────────────────────────────────────────

  /**
   * Run `handler` on a lifecycle event of this model's instances (and its
   * subclasses'). `-ing` handlers run before the write and can change the
   * model, or throw to stop the write. Returns a function that removes the
   * handler. See {@link ModelEvent}.
   *
   * ```ts
   * User.on("creating", (user) => { user.email = user.email.toLowerCase(); });
   * ```
   */
  static on<C extends ModelClass>(
    this: C,
    event: ModelEvent,
    handler: (model: Row<Instance<C>>) => unknown,
  ): () => void {
    return addListener(this, event, handler);
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  static query<C extends ModelClass>(this: C): ModelQuery<Instance<C>> {
    return new ModelQuery<Instance<C>>(this);
  }

  static where<
    C extends ModelClass,
    K extends keyof Columns<Instance<C>> & string,
  >(
    this: C,
    column: K,
    value: Columns<Instance<C>>[K],
  ): ModelQuery<Instance<C>>;
  static where<
    C extends ModelClass,
    K extends keyof Columns<Instance<C>> & string,
  >(
    this: C,
    column: K,
    op: ComparisonOperator,
    value: Columns<Instance<C>>[K] | readonly Columns<Instance<C>>[K][],
  ): ModelQuery<Instance<C>>;
  static where<C extends ModelClass>(
    this: C,
    expression: (eb: ExpressionBuilder<any, any>) => Expression<SqlBool>,
  ): ModelQuery<Instance<C>>;
  static where(this: ModelClass, ...args: any[]): ModelQuery<any> {
    return (new ModelQuery<any>(this).where as any)(...args);
  }

  /** Eager-load relations. See {@link ModelQuery.with}. */
  static with<C extends ModelClass, Q extends RelationPaths<Instance<C>>>(
    this: C,
    ...paths: Q[]
  ): ModelQuery<Instance<C>, Q>;
  /** Eager-load a relation through a constraint: `Todo.with("user", q => q.select("name", "role"))`. */
  static with<C extends ModelClass, Q extends RelationPaths<Instance<C>>, R>(
    this: C,
    path: Q,
    constrain: (query: ModelQuery<ModelAt<Instance<C>, Q>>) => R,
  ): ModelQuery<
    Instance<C>,
    Q,
    ColumnKeys<Instance<C>>,
    {},
    ConstrainedAt<Q, R>
  >;
  /** Several constrained relations: `Todo.with({ user: q => q.select("name") })`. */
  static with<C extends ModelClass, T extends EagerConstraints<Instance<C>>>(
    this: C,
    relations: T,
  ): ModelQuery<
    Instance<C>,
    keyof T & string,
    ColumnKeys<Instance<C>>,
    {},
    ConstrainedMap<T>
  >;
  static with(this: ModelClass, ...args: any[]): any {
    return (new ModelQuery<any>(this).with as any)(...args);
  }

  /** Rows with at least one related row. See {@link ModelQuery.whereHas}. */
  static whereHas<C extends ModelClass, Q extends RelationPaths<Instance<C>>>(
    this: C,
    relation: Q,
    constrain?: RelationConstraint<ModelAt<Instance<C>, Q>>,
  ): ModelQuery<Instance<C>> {
    return new ModelQuery<Instance<C>>(this).whereHas(relation, constrain);
  }

  /** Rows with no related row. See {@link ModelQuery.whereDoesntHave}. */
  static whereDoesntHave<
    C extends ModelClass,
    Q extends RelationPaths<Instance<C>>,
  >(
    this: C,
    relation: Q,
    constrain?: RelationConstraint<ModelAt<Instance<C>, Q>>,
  ): ModelQuery<Instance<C>> {
    return new ModelQuery<Instance<C>>(this).whereDoesntHave(
      relation,
      constrain,
    );
  }

  /** Add `<relation>_count` to each result. See {@link ModelQuery.withCount}. */
  static withCount<C extends ModelClass, N extends RelationKeys<Instance<C>>>(
    this: C,
    ...relations: N[]
  ): ModelQuery<Instance<C>, never, ColumnKeys<Instance<C>>, Counted<N>>;
  static withCount<C extends ModelClass, N extends RelationKeys<Instance<C>>>(
    this: C,
    relation: N,
    constrain: RelationConstraint<RelatedModel<Instance<C>[N]>>,
  ): ModelQuery<Instance<C>, never, ColumnKeys<Instance<C>>, Counted<N>>;
  static withCount(this: ModelClass, ...args: any[]): any {
    return (new ModelQuery<any>(this).withCount as any)(...args);
  }

  /** Query with a reusable {@link Scope} applied. */
  static scope<C extends ModelClass, A extends unknown[]>(
    this: C,
    scope: Scope<Instance<C>, A>,
    ...args: A
  ): ModelQuery<Instance<C>> {
    return new ModelQuery<Instance<C>>(this).scope(scope, ...args);
  }

  /** Query without one of the model's `static globalScopes`. */
  static withoutGlobalScope<C extends ModelClass>(
    this: C,
    name: string,
  ): ModelQuery<Instance<C>> {
    return new ModelQuery<Instance<C>>(this).withoutGlobalScope(name);
  }

  /** Query without the model's `static globalScopes`: all, or those named. */
  static withoutGlobalScopes<C extends ModelClass>(
    this: C,
    names?: readonly string[],
  ): ModelQuery<Instance<C>> {
    return new ModelQuery<Instance<C>>(this).withoutGlobalScopes(names);
  }

  /** Query including soft-deleted rows. */
  static withTrashed<C extends ModelClass>(this: C): ModelQuery<Instance<C>> {
    return new ModelQuery<Instance<C>>(this).withTrashed();
  }

  /** Query only soft-deleted rows. */
  static onlyTrashed<C extends ModelClass>(this: C): ModelQuery<Instance<C>> {
    return new ModelQuery<Instance<C>>(this).onlyTrashed();
  }

  static all<C extends ModelClass>(this: C): Promise<Row<Instance<C>>[]> {
    return new ModelQuery<Instance<C>>(this).get();
  }

  /** Find by primary key. */
  static find<C extends ModelClass>(
    this: C,
    id: PrimaryKeyValue<C>,
  ): Promise<Row<Instance<C>> | undefined> {
    return (new ModelQuery<Instance<C>>(this) as ModelQuery<any>)
      .where(this.primaryKey, id)
      .first() as Promise<Row<Instance<C>> | undefined>;
  }

  /** Find by primary key, or throw a 404 `NotFoundException`. */
  static async findOrFail<C extends ModelClass>(
    this: C,
    id: PrimaryKeyValue<C>,
  ): Promise<Row<Instance<C>>> {
    const found = await (this as any).find(id);
    if (!found) throw new NotFoundException(`${this.name} not found`);
    return found;
  }

  /**
   * The first row matching a column value, or every given column:
   * `User.findBy("email", "ann@x.io")`, `User.findBy({ email, active: true })`.
   */
  static findBy<
    C extends ModelClass,
    K extends keyof Columns<Instance<C>> & string,
  >(
    this: C,
    column: K,
    value: Columns<Instance<C>>[K],
  ): Promise<Row<Instance<C>> | undefined>;
  static findBy<C extends ModelClass>(
    this: C,
    values: Partial<Columns<Instance<C>>>,
  ): Promise<Row<Instance<C>> | undefined>;
  static findBy(this: ModelClass, ...args: any[]): Promise<any> {
    return whereAll(this, args).first();
  }

  /** Like {@link Model.findBy}, but throws a 404 `NotFoundException` when nothing matches. */
  static findByOrFail<
    C extends ModelClass,
    K extends keyof Columns<Instance<C>> & string,
  >(
    this: C,
    column: K,
    value: Columns<Instance<C>>[K],
  ): Promise<Row<Instance<C>>>;
  static findByOrFail<C extends ModelClass>(
    this: C,
    values: Partial<Columns<Instance<C>>>,
  ): Promise<Row<Instance<C>>>;
  static findByOrFail(this: ModelClass, ...args: any[]): Promise<any> {
    return whereAll(this, args).firstOrFail();
  }

  /** Number of rows (soft-deleted rows excluded). */
  static count<C extends ModelClass>(this: C): Promise<number> {
    return new ModelQuery<Instance<C>>(this).count();
  }

  /** Sum of `column`; `0` for an empty table. */
  static sum<C extends ModelClass>(
    this: C,
    column: keyof Columns<Instance<C>> & string,
  ): Promise<number> {
    return new ModelQuery<Instance<C>>(this).sum(column);
  }

  /** Average of `column`; `null` for an empty table. */
  static avg<C extends ModelClass>(
    this: C,
    column: keyof Columns<Instance<C>> & string,
  ): Promise<number | null> {
    return new ModelQuery<Instance<C>>(this).avg(column);
  }

  /** Smallest value of `column`; `null` for an empty table. */
  static min<
    C extends ModelClass,
    K extends keyof Columns<Instance<C>> & string,
  >(this: C, column: K): Promise<Columns<Instance<C>>[K] | null> {
    return new ModelQuery<Instance<C>>(this).min(column);
  }

  /** Largest value of `column`; `null` for an empty table. */
  static max<
    C extends ModelClass,
    K extends keyof Columns<Instance<C>> & string,
  >(this: C, column: K): Promise<Columns<Instance<C>>[K] | null> {
    return new ModelQuery<Instance<C>>(this).max(column);
  }

  /** One page of every row. See {@link ModelQuery.paginate}. */
  static paginate<C extends ModelClass>(
    this: C,
    request?: PageRequest,
  ): Promise<Paginated<Row<Instance<C>>>> {
    return new ModelQuery<Instance<C>>(this).paginate(request);
  }

  /** One page without a total count. See {@link ModelQuery.simplePaginate}. */
  static simplePaginate<C extends ModelClass>(
    this: C,
    request?: PageRequest,
  ): Promise<SimplePaginated<Row<Instance<C>>>> {
    return new ModelQuery<Instance<C>>(this).simplePaginate(request);
  }

  /** Keyset pagination. See {@link ModelQuery.cursorPaginate}. */
  static cursorPaginate<C extends ModelClass>(
    this: C,
    request?: CursorPageRequest<keyof Columns<Instance<C>> & string>,
  ): Promise<CursorPaginated<Row<Instance<C>>>> {
    return new ModelQuery<Instance<C>>(this).cursorPaginate(request);
  }

  /** Insert a row and return it as a model instance. Fires `saving`, `creating`, `created` and `saved`. */
  static async create<C extends ModelClass>(
    this: C,
    values: CreateInput<C>,
  ): Promise<Row<Instance<C>>> {
    const instance: any = emptyInstance(this);
    Object.assign(instance, values);
    await instance.save();
    return instance;
  }

  /** Insert several rows in one transaction, each through {@link create} (with events). */
  static createMany<C extends ModelClass>(
    this: C,
    list: readonly CreateInput<C>[],
  ): Promise<Row<Instance<C>>[]> {
    return runInTransaction(async () => {
      const out: Row<Instance<C>>[] = [];
      for (const values of list) out.push(await (this as any).create(values));
      return out;
    });
  }

  /**
   * Insert many rows in as few statements as possible, with casts and
   * timestamps but without events or returning the rows. For bulk loads.
   */
  static async insert<C extends ModelClass>(
    this: C,
    list: readonly CreateInput<C>[],
  ): Promise<void> {
    if (list.length === 0) return;
    const db = getConnection();
    await DB.table(tableOf(this)).insert(
      list.map((values) =>
        toColumns(
          this,
          castToDatabase(
            this,
            withTimestamps(this, values as Record<string, unknown>, "insert"),
            db,
          ),
        ),
      ),
    );
  }

  /**
   * Insert rows, or update those whose `uniqueBy` columns match an existing
   * row (they need a unique index). `update` lists the columns to
   * overwrite: by default every given column except `uniqueBy` and
   * `created_at`. Casts and timestamps apply; events don't fire. Returns
   * the database's count of affected rows.
   *
   * ```ts
   * await Price.upsert(
   *   [{ sku: "A1", amount: 10 }, { sku: "B2", amount: 20 }],
   *   "sku",
   * );
   * ```
   */
  static async upsert<C extends ModelClass>(
    this: C,
    rows: CreateInput<C> | readonly CreateInput<C>[],
    uniqueBy: ColumnKeys<Instance<C>> | readonly ColumnKeys<Instance<C>>[],
    update?: readonly ColumnKeys<Instance<C>>[],
  ): Promise<number> {
    const list = [rows].flat() as Record<string, unknown>[];
    if (list.length === 0) return 0;
    const db = getConnection();
    const data = list.map((values) =>
      toColumns(
        this,
        castToDatabase(this, withTimestamps(this, values, "insert"), db),
      ),
    );
    const keys = ([uniqueBy].flat() as string[]).map((k) =>
      columnName(this, k),
    );
    const created =
      this.timestamps && this.createdAt
        ? columnName(this, this.createdAt)
        : undefined;
    const updated =
      this.timestamps && this.updatedAt
        ? columnName(this, this.updatedAt)
        : undefined;
    const columns = update
      ? [
          ...new Set([
            ...update.map((c) => columnName(this, c)),
            ...(updated ? [updated] : []),
          ]),
        ]
      : Object.keys(data[0]).filter((c) => !keys.includes(c) && c !== created);
    return DB.table(tableOf(this)).upsert(data, keys, columns);
  }

  /** The first row matching `match`, or a new unsaved instance with `match` and `values`. */
  static async firstOrNew<C extends ModelClass>(
    this: C,
    match: Partial<Columns<Instance<C>>>,
    values: Partial<Columns<Instance<C>>> = {},
  ): Promise<Row<Instance<C>>> {
    const found = await (this as any).findBy(match);
    if (found) return found;
    const instance: any = emptyInstance(this);
    Object.assign(instance, match, values);
    return instance;
  }

  /** The first row matching `match`, or one created from `match` and `values`. */
  static async firstOrCreate<C extends ModelClass>(
    this: C,
    match: Partial<Columns<Instance<C>>>,
    values: Partial<Columns<Instance<C>>> = {},
  ): Promise<Row<Instance<C>>> {
    const found = await (this as any).findBy(match);
    return found ?? (this as any).create({ ...match, ...values });
  }

  /**
   * Update the first row matching `match` with `values`, or create one from
   * both. Runs in a transaction; events fire.
   */
  static updateOrCreate<C extends ModelClass>(
    this: C,
    match: Partial<Columns<Instance<C>>>,
    values: Partial<Columns<Instance<C>>>,
  ): Promise<Row<Instance<C>>> {
    return runInTransaction(async () => {
      const found = await (this as any).findBy(match);
      if (found) return found.fill(values).save();
      return (this as any).create({ ...match, ...values });
    });
  }

  // ── Instances ───────────────────────────────────────────────────────────

  /** Whether this instance's row exists in the database. */
  isPersisted(): boolean {
    return getState(this).exists;
  }

  /** Assign column values. Call `save()` to persist them. */
  fill(values: UpdateInput<this>): this {
    Object.assign(this, values);
    return this;
  }

  /**
   * Insert the instance if it is new, otherwise update the columns that
   * changed since it was loaded (and `updated_at` with timestamps). Writes
   * nothing when nothing changed. Fires `saving`, then `creating` /
   * `created` or `updating` / `updated`, then `saved`.
   */
  async save(): Promise<this> {
    const cls = this.constructor as ModelClass;
    await fire(this, "saving");
    if (!getState(this).exists) {
      await fire(this, "creating");
      const row = await insertRow(cls, columnValues(this));
      Object.assign(this, row);
      markPersisted(this, row);
      await fire(this, "created");
      await fire(this, "saved");
      return this;
    }

    const changed = (): Record<string, unknown> => {
      const changes = changedValues(this);
      delete changes[cls.primaryKey];
      return changes;
    };
    if (Object.keys(changed()).length > 0) {
      await fire(this, "updating");
      // `updating` handlers may change more columns.
      const values = withTimestamps(cls, changed(), "update");
      await updateRow(cls, this.key(), values);
      Object.assign(this, values);
      markPersisted(this, columnValues(this));
      await fire(this, "updated");
    } else {
      markPersisted(this, columnValues(this));
    }
    await fire(this, "saved");
    return this;
  }

  /** Delete the row; with `softDeletes`, set `deleted_at` instead. Fires `deleting` and `deleted`. */
  async delete(): Promise<void> {
    const cls = this.constructor as ModelClass;
    await fire(this, "deleting");
    if (!cls.softDeletes) {
      await this.deleteRow();
    } else {
      const values = withTimestamps(
        cls,
        { [cls.deletedAt]: new Date() },
        "update",
      );
      await updateRow(cls, this.key(), values);
      Object.assign(this, values);
      markPersisted(this, columnValues(this));
    }
    await fire(this, "deleted");
  }

  /** Delete the row permanently, even with `softDeletes`. Fires `deleting` and `deleted`. */
  async forceDelete(): Promise<void> {
    await fire(this, "deleting");
    await this.deleteRow();
    await fire(this, "deleted");
  }

  private async deleteRow(): Promise<void> {
    const cls = this.constructor as ModelClass;
    await getConnection()
      .deleteFrom(tableOf(cls))
      .where(columnName(cls, cls.primaryKey), "=", this.key())
      .execute();
    markDeleted(this);
  }

  /** Undo a soft delete. Fires `restoring` and `restored`. */
  async restore(): Promise<this> {
    const cls = this.constructor as ModelClass;
    assertSoftDeletes(cls);
    await fire(this, "restoring");
    const values = withTimestamps(cls, { [cls.deletedAt]: null }, "update");
    await updateRow(cls, this.key(), values);
    Object.assign(this, values);
    markPersisted(this, columnValues(this));
    await fire(this, "restored");
    return this;
  }

  /** Reload the columns from the database (soft-deleted or not). Loaded relations stay. */
  async refresh(): Promise<this> {
    const cls = this.constructor as ModelClass;
    const row = await getConnection()
      .selectFrom(tableOf(cls))
      .selectAll()
      .where(columnName(cls, cls.primaryKey), "=", this.key())
      .executeTakeFirst();
    if (!row) throw new NotFoundException(`${cls.name} not found`);
    const values = castFromDatabase(cls, toProperties(cls, row));
    Object.assign(this, values);
    markPersisted(this, values);
    return this;
  }

  /** A new instance of this row, read from the database; `undefined` if it's gone. */
  async fresh(): Promise<this | undefined> {
    const cls = this.constructor as ModelClass;
    const query = new ModelQuery<any>(cls).withoutGlobalScopes();
    if (cls.softDeletes) query.withTrashed();
    return (await query.guard(cls.primaryKey, this.key()).first()) as
      this | undefined;
  }

  /** Set `updated_at` to now and save. Does nothing without timestamps. */
  async touch(): Promise<this> {
    const cls = this.constructor as ModelClass;
    if (!cls.timestamps || !cls.updatedAt) return this;
    (this as any)[cls.updatedAt] = new Date();
    return this.save();
  }

  /**
   * An unsaved copy without the primary key, timestamps and soft-delete
   * column (and `except`): `await post.replicate().fill({ title }).save()`.
   */
  replicate(except: readonly string[] = []): this {
    const cls = this.constructor as ModelClass;
    const skip = new Set<string>([cls.primaryKey, ...except]);
    if (cls.timestamps) {
      if (cls.createdAt) skip.add(cls.createdAt);
      if (cls.updatedAt) skip.add(cls.updatedAt);
    }
    if (cls.softDeletes) skip.add(cls.deletedAt);
    const copy: any = emptyInstance(cls);
    for (const [key, value] of Object.entries(columnValues(this))) {
      if (!skip.has(key)) copy[key] = value;
    }
    return copy;
  }

  /**
   * Add `amount` (default 1) to `column` in the database, in one statement
   * (`set views = views + 1`, safe under concurrent writes), and on this
   * instance. Sets `extra` columns and `updated_at` too. No events fire.
   */
  async increment(
    column: ColumnKeys<this>,
    amount = 1,
    extra: UpdateInput<this> = {},
  ): Promise<this> {
    const cls = this.constructor as ModelClass;
    const values = withTimestamps(
      cls,
      extra as Record<string, unknown>,
      "update",
    );
    await new ModelQuery<any>(cls)
      .withoutGlobalScopes()
      .withTrashed()
      .guard(cls.primaryKey, this.key())
      .increment(column, amount, values);
    Object.assign(this, values);
    (this as any)[column] = Number((this as any)[column] ?? 0) + amount;
    markPersisted(this, columnValues(this));
    return this;
  }

  /** Subtract `amount` (default 1). See {@link increment}. */
  decrement(
    column: ColumnKeys<this>,
    amount = 1,
    extra: UpdateInput<this> = {},
  ): Promise<this> {
    return this.increment(column, -amount, extra);
  }

  /** Whether the instance is soft-deleted. */
  isTrashed(): boolean {
    const cls = this.constructor as ModelClass;
    const value = (this as any)[cls.deletedAt];
    return cls.softDeletes && value !== null && value !== undefined;
  }

  /**
   * The pivot rows of a `belongsToMany` relation, to attach, detach or sync
   * related models: `await user.related("roles").sync([1, 2])`.
   */
  related<K extends BelongsToManyKeys<this>>(
    name: K,
  ): PivotRelation<RelatedModel<this[K]>, PivotOf<this[K]>>;
  /**
   * The rows of a `hasMany` / `hasOne` relation, to query or create them
   * with the foreign key set: `await user.related("posts").create({ title })`.
   */
  related<K extends HasRelationKeys<this>>(
    name: K,
  ): HasRelation<
    RelatedModel<this[K]>,
    IsManyRelation<this[K]> extends true ? "many" : "one"
  >;
  related(name: string): unknown {
    const def = getRelation(this.constructor as ModelClass, name);
    if (def.kind === "belongsToMany") return new PivotRelation(this, def);
    if (
      def.kind === "hasMany" ||
      def.kind === "hasOne" ||
      def.kind === "morphMany" ||
      def.kind === "morphOne"
    ) {
      return new HasRelation(this, def);
    }
    throw new Error(
      `[Megh ORM] related("${name}") works with hasMany, hasOne, morphMany, morphOne and belongsToMany relations.`,
    );
  }

  private key(): unknown {
    return (this as any)[(this.constructor as ModelClass).primaryKey];
  }

  /** Show properties `static hidden` leaves out of this instance's `toJSON()`. */
  makeVisible(...keys: string[]): this {
    const entry = visibilityOf(this);
    for (const key of keys) {
      entry.shown.add(key);
      entry.hidden.delete(key);
    }
    return this;
  }

  /** Leave more properties out of this instance's `toJSON()`. */
  makeHidden(...keys: string[]): this {
    const entry = visibilityOf(this);
    for (const key of keys) {
      entry.hidden.add(key);
      entry.shown.delete(key);
    }
    return this;
  }

  /**
   * Columns, loaded relations (as JSON too), extras such as `pivot` and
   * `withCount()` counts, and `static appends` getters. Leaves out
   * `static hidden` properties, and columns `static visible` doesn't list.
   */
  toJSON(): Record<string, unknown> {
    const cls = this.constructor as ModelClass;
    const overrides = visibility.get(this);
    const hidden = new Set([
      ...(cls.hidden ?? []),
      ...(overrides?.hidden ?? []),
    ]);
    for (const key of overrides?.shown ?? []) hidden.delete(key);
    const visible = cls.visible ? new Set(cls.visible) : null;
    const relations = getRelations(cls);
    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(this)) {
      const value = (this as any)[key];
      if (value === undefined || isRelationMarker(value) || hidden.has(key)) {
        continue;
      }
      // `visible` limits columns: enumerable fields that aren't relations.
      const isColumn =
        !relations.has(key) &&
        Object.getOwnPropertyDescriptor(this, key)?.enumerable;
      if (
        visible &&
        isColumn &&
        !visible.has(key) &&
        !overrides?.shown.has(key)
      ) {
        continue;
      }
      out[key] = serialize(value);
    }
    for (const key of cls.appends ?? []) {
      if (!hidden.has(key)) out[key] = serialize((this as any)[key]);
    }
    return out;
  }
}

/** A query matching `findBy(column, value)` or `findBy({ column: value })`. */
function whereAll(cls: ModelClass, args: any[]): ModelQuery<any> {
  const query = new ModelQuery<any>(cls);
  if (args.length >= 2) return query.where(args[0], args[1]);
  for (const [column, value] of Object.entries(args[0] ?? {})) {
    query.where(column, value);
  }
  return query;
}
