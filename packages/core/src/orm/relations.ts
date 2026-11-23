/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 *
 * Model relations. A relation is declared once, as a field initializer:
 *
 * ```ts
 * class User extends Model {
 *   posts = hasMany(() => Post);
 * }
 * ```
 *
 * The initializer returns a marker whose type carries the related model, and
 * the marker's runtime definition is read from a probe instance.
 */

import { getModelMetadata } from "./decorators";

/** Brand of a relation marker. */
export const RELATION: unique symbol = Symbol("megh.orm.relation");

type RelatedClass = abstract new () => any;

export type RelationKind =
  | "hasMany"
  | "hasOne"
  | "belongsTo"
  | "belongsToMany"
  | "hasManyThrough"
  | "hasOneThrough"
  | "morphMany"
  | "morphOne"
  | "morphTo";

/** The intermediate table of a `hasManyThrough` / `hasOneThrough` relation. */
export interface ThroughDefinition {
  /** The intermediate model. */
  model: () => RelatedClass;
  /** Column on the related table holding the intermediate row's key. */
  secondKey: string;
  /** Key on the intermediate table that `secondKey` matches. */
  secondLocalKey: string;
}

/** The type column of a polymorphic relation. */
export interface MorphDefinition {
  /** Column holding the owner's type, e.g. `commentable_type`. */
  type: string;
  /** morphMany/morphOne: this model's type value. */
  value?: string;
  /** morphTo: the models the type column may name. */
  targets?: () => RelatedClass[];
}

/** The pivot table of a many-to-many relation. */
export interface PivotDefinition {
  table: string;
  /** Pivot column holding the related model's key. */
  relatedPivotKey: string;
  /** Key on the related table that `relatedPivotKey` matches. */
  relatedKey: string;
  /** Extra pivot columns loaded into `pivot`. */
  columns: string[];
}

/** A relation's runtime definition, with defaults resolved. */
export interface RelationDefinition {
  kind: RelationKind;
  related: () => RelatedClass;
  /**
   * hasMany/hasOne/morphMany/morphOne: column on the related table.
   * belongsTo/morphTo: column on this table. belongsToMany: pivot column
   * holding this model's key. hasManyThrough/hasOneThrough: column on the
   * intermediate table holding this model's key.
   */
  foreignKey: string;
  /**
   * hasMany/hasOne/belongsToMany: key on this table. belongsTo: key on the
   * related table.
   */
  localKey: string;
  /** belongsToMany only. */
  pivot?: PivotDefinition;
  /** hasManyThrough/hasOneThrough only. */
  through?: ThroughDefinition;
  /** morphMany/morphOne/morphTo only. */
  morph?: MorphDefinition;
}

/** Options for {@link hasManyThrough} / {@link hasOneThrough}. */
export interface ThroughOptions {
  /** Column on the intermediate table holding this model's key. Defaults to `<snake_case this class>_id`. */
  firstKey?: string;
  /** Column on the related table holding the intermediate key. Defaults to `<snake_case intermediate class>_id`. */
  secondKey?: string;
  /** Key on this table. Defaults to the primary key. */
  localKey?: string;
  /** Key on the intermediate table. Defaults to its primary key. */
  secondLocalKey?: string;
}

/** Options for {@link belongsToMany}. */
export interface BelongsToManyOptions {
  /** Pivot table. Defaults to both snake_case class names, sorted: `role_user`. */
  table?: string;
  /** Pivot column for this model's key. Defaults to `<snake_case class>_id`. */
  foreignPivotKey?: string;
  /** Pivot column for the related model's key. Defaults to `<snake_case related>_id`. */
  relatedPivotKey?: string;
  /** Key on this table. Defaults to the primary key. */
  parentKey?: string;
  /** Key on the related table. Defaults to its primary key. */
  relatedKey?: string;
}

/** The definition as declared, before defaults are filled in. */
export interface DeclaredRelation {
  kind: RelationKind;
  related: () => RelatedClass;
  foreignKey?: string;
  localKey?: string;
  pivot?: BelongsToManyOptions & { columns: string[] };
  through?: { model: () => RelatedClass } & ThroughOptions;
  /** Polymorphic name, e.g. `commentable`: columns `commentable_id` and `commentable_type`. */
  morphName?: string;
  morphTargets?: () => RelatedClass[];
}

/** One-to-many: `posts = hasMany(() => Post)`. Loads as `Post[]`. */
export interface HasMany<M> {
  readonly [RELATION]: {
    kind: "many";
    type: "hasMany";
    model: M;
    def: DeclaredRelation;
  };
}
/** One-to-one: `profile = hasOne(() => Profile)`. Loads as `Profile | null`. */
export interface HasOne<M> {
  readonly [RELATION]: {
    kind: "one";
    type: "hasOne";
    model: M;
    def: DeclaredRelation;
  };
}
/** Inverse side: `author = belongsTo(() => User, "user_id")`. Loads as `User | null`. */
export interface BelongsTo<M> {
  readonly [RELATION]: {
    kind: "one";
    type: "belongsTo";
    model: M;
    def: DeclaredRelation;
  };
}

/**
 * Many-to-many through a pivot table: `roles = belongsToMany(() => Role)`.
 * Loads as `Role[]`, each with a `pivot` object.
 */
export interface BelongsToMany<M, Pivot = {}> {
  readonly [RELATION]: {
    kind: "many";
    type: "belongsToMany";
    model: M;
    pivot: Pivot;
    def: DeclaredRelation;
  };
  /**
   * Also load these pivot columns into `pivot`:
   * `belongsToMany(() => Role).withPivot<{ granted_at: string }>("granted_at")`.
   */
  withPivot<T extends Record<string, unknown>>(
    ...columns: (keyof T & string)[]
  ): BelongsToMany<M, Pivot & T>;
}

/** Distant one-to-many through an intermediate model: `posts = hasManyThrough(() => Post, () => User)`. Loads as `Post[]`. */
export interface HasManyThrough<M> {
  readonly [RELATION]: {
    kind: "many";
    type: "hasManyThrough";
    model: M;
    def: DeclaredRelation;
  };
}
/** Distant one-to-one through an intermediate model. Loads as `M | null`. */
export interface HasOneThrough<M> {
  readonly [RELATION]: {
    kind: "one";
    type: "hasOneThrough";
    model: M;
    def: DeclaredRelation;
  };
}
/** Polymorphic one-to-many: `comments = morphMany(() => Comment, "commentable")`. Loads as `Comment[]`. */
export interface MorphMany<M> {
  readonly [RELATION]: {
    kind: "many";
    type: "morphMany";
    model: M;
    def: DeclaredRelation;
  };
}
/** Polymorphic one-to-one: `image = morphOne(() => Image, "imageable")`. Loads as `Image | null`. */
export interface MorphOne<M> {
  readonly [RELATION]: {
    kind: "one";
    type: "morphOne";
    model: M;
    def: DeclaredRelation;
  };
}
/** Inverse of a polymorphic relation: `commentable = morphTo(() => [Post, Video])`. Loads as `Post | Video | null`. */
export interface MorphTo<M> {
  readonly [RELATION]: {
    kind: "one";
    type: "morphTo";
    model: M;
    def: DeclaredRelation;
  };
}

export type AnyRelation =
  | HasMany<any>
  | HasOne<any>
  | BelongsTo<any>
  | BelongsToMany<any, any>
  | HasManyThrough<any>
  | HasOneThrough<any>
  | MorphMany<any>
  | MorphOne<any>
  | MorphTo<any>;

const MANY: ReadonlySet<RelationKind> = new Set([
  "hasMany",
  "belongsToMany",
  "hasManyThrough",
  "morphMany",
]);

/** Whether a relation loads a list. */
export function isManyKind(kind: RelationKind): boolean {
  return MANY.has(kind);
}

function marker(def: DeclaredRelation): any {
  const kind = isManyKind(def.kind) ? "many" : "one";
  const out: any = { [RELATION]: { kind, type: def.kind, def } };
  if (def.kind === "belongsToMany") {
    out.withPivot = (...columns: string[]) => {
      def.pivot!.columns.push(...columns);
      return out;
    };
  }
  return out;
}

/**
 * One-to-many relation.
 *
 * @param foreignKey Column on the related table. Defaults to
 *   `<snake_case owner class>_id`, e.g. `user_id` on `User`.
 * @param localKey Key on this table it matches. Defaults to the primary key.
 */
export function hasMany<C extends RelatedClass>(
  related: () => C,
  foreignKey?: string,
  localKey?: string,
): HasMany<InstanceType<C>> {
  return marker({ kind: "hasMany", related, foreignKey, localKey });
}

/** One-to-one relation. Same keys as {@link hasMany}. */
export function hasOne<C extends RelatedClass>(
  related: () => C,
  foreignKey?: string,
  localKey?: string,
): HasOne<InstanceType<C>> {
  return marker({ kind: "hasOne", related, foreignKey, localKey });
}

/**
 * Inverse of {@link hasMany} / {@link hasOne}.
 *
 * @param foreignKey Column on this table. Defaults to
 *   `<snake_case relation name>_id`, e.g. `author_id` for `author`.
 * @param ownerKey Key on the related table. Defaults to its primary key.
 */
export function belongsTo<C extends RelatedClass>(
  related: () => C,
  foreignKey?: string,
  ownerKey?: string,
): BelongsTo<InstanceType<C>> {
  return marker({ kind: "belongsTo", related, foreignKey, localKey: ownerKey });
}

/**
 * Many-to-many relation through a pivot table.
 *
 * ```ts
 * class User extends Model {
 *   roles = belongsToMany(() => Role); // pivot table role_user (user_id, role_id)
 * }
 * ```
 */
export function belongsToMany<C extends RelatedClass>(
  related: () => C,
  options: BelongsToManyOptions = {},
): BelongsToMany<InstanceType<C>> {
  return marker({
    kind: "belongsToMany",
    related,
    pivot: { ...options, columns: [] },
  });
}

/**
 * A distant one-to-many relation through an intermediate model. A country
 * has many posts through its users:
 *
 * ```ts
 * class Country extends Model {
 *   // countries.id → users.country_id, users.id → posts.user_id
 *   posts = hasManyThrough(() => Post, () => User);
 * }
 * ```
 */
export function hasManyThrough<C extends RelatedClass>(
  related: () => C,
  through: () => RelatedClass,
  options: ThroughOptions = {},
): HasManyThrough<InstanceType<C>> {
  return marker({
    kind: "hasManyThrough",
    related,
    through: { model: through, ...options },
  });
}

/** A distant one-to-one relation through an intermediate model. Same keys as {@link hasManyThrough}. */
export function hasOneThrough<C extends RelatedClass>(
  related: () => C,
  through: () => RelatedClass,
  options: ThroughOptions = {},
): HasOneThrough<InstanceType<C>> {
  return marker({
    kind: "hasOneThrough",
    related,
    through: { model: through, ...options },
  });
}

/**
 * Polymorphic one-to-many: the related rows point at their owner with two
 * columns, `<name>_id` and `<name>_type`. The type is the owner's
 * `static morphType`, or its table name.
 *
 * ```ts
 * class Post extends Model {
 *   comments = morphMany(() => Comment, "commentable");
 * }
 * ```
 *
 * @param localKey Key on this table. Defaults to the primary key.
 */
export function morphMany<C extends RelatedClass>(
  related: () => C,
  name: string,
  localKey?: string,
): MorphMany<InstanceType<C>> {
  return marker({ kind: "morphMany", related, morphName: name, localKey });
}

/** Polymorphic one-to-one. Same arguments as {@link morphMany}. */
export function morphOne<C extends RelatedClass>(
  related: () => C,
  name: string,
  localKey?: string,
): MorphOne<InstanceType<C>> {
  return marker({ kind: "morphOne", related, morphName: name, localKey });
}

/**
 * The inverse of {@link morphMany} / {@link morphOne}: the owner named by
 * `<name>_id` and `<name>_type`, one of `targets`.
 *
 * ```ts
 * class Comment extends Model {
 *   commentable_id: number;
 *   commentable_type: string;
 *   commentable = morphTo(() => [Post, Video]);
 * }
 * ```
 *
 * @param name Defaults to the field name.
 */
export function morphTo<const T extends readonly RelatedClass[]>(
  targets: () => T,
  name?: string,
): MorphTo<InstanceType<T[number]>> {
  return marker({
    kind: "morphTo",
    related: () => targets()[0],
    morphName: name,
    morphTargets: targets as unknown as () => RelatedClass[],
  });
}

/** The value a model's rows are named by in polymorphic `<name>_type` columns. */
export function morphTypeOf(cls: Function): string {
  const own = cls as unknown as {
    morphType?: string;
    table?: string;
    name: string;
  };
  return own.morphType ?? own.table ?? own.name;
}

/** A relation definition, as the relation decorators record it. */
export function declareRelation(
  kind: RelationKind,
  related: () => RelatedClass,
  options: Omit<DeclaredRelation, "kind" | "related"> = {},
): DeclaredRelation {
  return { kind, related, ...options };
}

export function isRelationMarker(value: unknown): boolean {
  return !!value && typeof value === "object" && RELATION in value;
}

export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

const cache = new WeakMap<Function, Map<string, RelationDefinition>>();

/**
 * Relations of a model class: those declared with decorators, and those
 * declared as field initializers, read once from a probe instance.
 */
export function getRelations(
  cls: (new () => any) & { primaryKey?: string },
): Map<string, RelationDefinition> {
  let defs = cache.get(cls);
  if (defs) return defs;

  defs = new Map();
  for (const [name, declared] of getModelMetadata(cls)?.relations ?? []) {
    defs.set(name, resolve(cls, name, declared));
  }
  const probe = new cls();
  for (const [name, value] of Object.entries(probe)) {
    if (!isRelationMarker(value)) continue;
    const declared: DeclaredRelation = (value as any)[RELATION].def;
    defs.set(name, resolve(cls, name, declared));
  }
  cache.set(cls, defs);
  return defs;
}

type OwnerClass = (new () => any) & { primaryKey?: string };

function resolve(
  cls: OwnerClass,
  name: string,
  declared: DeclaredRelation,
): RelationDefinition {
  const ownPk = cls.primaryKey ?? "id";
  const related = () => declared.related() as unknown as OwnerClass;
  const { kind } = declared;

  if (kind === "belongsTo") {
    return {
      kind,
      related: declared.related,
      foreignKey: declared.foreignKey ?? `${snakeCase(name)}_id`,
      // The related class may not be defined yet when this runs.
      get localKey() {
        return declared.localKey ?? related().primaryKey ?? "id";
      },
    };
  }

  if (kind === "belongsToMany") {
    const options = declared.pivot!;
    return {
      kind,
      related: declared.related,
      foreignKey: options.foreignPivotKey ?? `${snakeCase(cls.name)}_id`,
      localKey: options.parentKey ?? ownPk,
      get pivot() {
        const relatedName = snakeCase(related().name);
        return {
          table:
            options.table ??
            [snakeCase(cls.name), relatedName].sort().join("_"),
          relatedPivotKey: options.relatedPivotKey ?? `${relatedName}_id`,
          relatedKey: options.relatedKey ?? related().primaryKey ?? "id",
          columns: options.columns,
        };
      },
    };
  }

  if (kind === "hasManyThrough" || kind === "hasOneThrough") {
    const options = declared.through!;
    const through = () => options.model() as unknown as OwnerClass;
    return {
      kind,
      related: declared.related,
      foreignKey: options.firstKey ?? `${snakeCase(cls.name)}_id`,
      localKey: options.localKey ?? ownPk,
      // The intermediate class may not be defined yet when this runs.
      get through() {
        return {
          model: options.model,
          secondKey: options.secondKey ?? `${snakeCase(through().name)}_id`,
          secondLocalKey:
            options.secondLocalKey ?? through().primaryKey ?? "id",
        };
      },
    };
  }

  if (kind === "morphTo") {
    const morphName = declared.morphName ?? name;
    return {
      kind,
      related: declared.related,
      foreignKey: declared.foreignKey ?? `${morphName}_id`,
      // Empty: each target's own primary key, see morphOwnerKey().
      localKey: declared.localKey ?? "",
      morph: { type: `${morphName}_type`, targets: declared.morphTargets },
    };
  }

  if (kind === "morphMany" || kind === "morphOne") {
    const morphName = declared.morphName!;
    return {
      kind,
      related: declared.related,
      foreignKey: declared.foreignKey ?? `${morphName}_id`,
      localKey: declared.localKey ?? ownPk,
      morph: { type: `${morphName}_type`, value: morphTypeOf(cls) },
    };
  }

  return {
    kind,
    related: declared.related,
    foreignKey: declared.foreignKey ?? `${snakeCase(cls.name)}_id`,
    localKey: declared.localKey ?? ownPk,
  };
}

/** morphTo: the key on `target` that `<name>_id` matches. */
export function morphOwnerKey(
  def: RelationDefinition,
  target: (new () => any) & { primaryKey?: string },
): string {
  return def.localKey || (target.primaryKey ?? "id");
}

export function getRelation(
  cls: (new () => any) & { primaryKey?: string },
  name: string,
): RelationDefinition {
  const def = getRelations(cls).get(name);
  if (!def) throw new Error(`[Megh ORM] ${cls.name} has no relation "${name}"`);
  return def;
}
