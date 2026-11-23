/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 */
import { runInTransaction } from "./connection";
import { propertyName } from "./naming";
import { ModelQuery } from "./query";
import type { RelationDefinition } from "./relations";
import type { ModelClass, Row, UpdateInput } from "./types";

/**
 * The related rows of one model's `hasMany` / `hasOne` (or `morphMany` /
 * `morphOne`) relation, to query or create them with the foreign key (and
 * type) filled in:
 *
 * ```ts
 * const post = await user.related("posts").create({ title: "Hello" });
 * const drafts = await user.related("posts").query().where("published", 0).get();
 * ```
 */
export class HasRelation<R, Kind extends "many" | "one" = "many"> {
  constructor(
    private readonly parent: any,
    private readonly def: RelationDefinition,
  ) {}

  private get relatedClass(): ModelClass<R> {
    return this.def.related() as unknown as ModelClass<R>;
  }

  /** The related model's property holding the foreign key. */
  private get foreignProperty(): string {
    return propertyName(this.relatedClass, this.def.foreignKey);
  }

  private parentKey(): unknown {
    const key =
      this.parent[propertyName(this.parent.constructor, this.def.localKey)];
    if (key === null || key === undefined) {
      throw new Error(
        `[Megh ORM] Save the ${this.parent.constructor.name} before using its related ${this.relatedClass.name} rows.`,
      );
    }
    return key;
  }

  /** Columns pointing a related row at the parent: the foreign key, and the type of a polymorphic relation. */
  private owner(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      [this.foreignProperty]: this.parentKey(),
    };
    const morph = this.def.morph;
    if (morph?.value !== undefined) {
      out[propertyName(this.relatedClass, morph.type)] = morph.value;
    }
    return out;
  }

  /**
   * A query on the related rows. The link to the parent is kept apart from
   * your conditions, so `orWhere()` can't reach other parents' rows.
   */
  query(): ModelQuery<R> {
    const query = new ModelQuery<R>(this.relatedClass);
    for (const [column, value] of Object.entries(this.owner())) {
      query.guard(column, value);
    }
    return query;
  }

  /** The related rows (`hasMany`) or row (`hasOne`, `null` when missing). */
  async get(): Promise<Kind extends "many" ? Row<R>[] : Row<R> | null> {
    if (this.def.kind === "hasOne" || this.def.kind === "morphOne") {
      return ((await this.query().first()) ?? null) as any;
    }
    return (await this.query().get()) as any;
  }

  /** Insert a related row with the foreign key set to this model's key. */
  async create(values: UpdateInput<R>): Promise<Row<R>> {
    return (this.relatedClass as any).create({ ...values, ...this.owner() });
  }

  /** Insert several related rows in one transaction. */
  async createMany(list: readonly UpdateInput<R>[]): Promise<Row<R>[]> {
    return runInTransaction(async () => {
      const out: Row<R>[] = [];
      for (const values of list) out.push(await this.create(values));
      return out;
    });
  }

  /** Point `model` at this parent (set its foreign key) and save it. */
  async save<T extends R>(model: T): Promise<T> {
    Object.assign(model as object, this.owner());
    return (model as any).save();
  }
}
