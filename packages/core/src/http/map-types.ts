/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 *
 * PartialType, PickType and OmitType: DTOs derived from another DTO.
 *
 * The derived class doesn't extend the source (an omitted property's rules
 * would still be inherited). Instead, every kind of metadata a DTO can carry
 * is copied for the properties it keeps: class-validator rules (kept in
 * class-validator's own storage), class-transformer's `@Type` / `@Expose` /
 * `@Exclude` / `@Transform`, Megh's validation and transformation decorators,
 * and the reflect metadata OpenAPI reads (`design:type`, `@OpenApiProperty`).
 */
import {
  addValidationRule,
  copyRules,
  getValidationRules,
} from "../validator/metadata";
import {
  getRegisteredSchemaProperties,
  getTransformerStorage,
  registerSchemaProperty,
} from "../openapi/schema-properties";
import {
  classValidator,
  classValidatorRules,
  dtoProperties,
} from "../validator/dto";

type Constructor<T = any> = new (...args: any[]) => T;

export function PartialType<T>(
  BaseClass: Constructor<T>,
): Constructor<Partial<T>> {
  const keys = propertiesOf(BaseClass);
  const Derived = deriveClass(
    BaseClass,
    `Partial${BaseClass.name}`,
    () => true,
  );
  for (const key of keys) makeOptional(BaseClass, Derived, key);
  return Derived as Constructor<Partial<T>>;
}

/** A DTO with only the named properties of `BaseClass`. */
export function PickType<T, K extends keyof T>(
  BaseClass: Constructor<T>,
  keys: readonly K[],
): Constructor<Pick<T, K>> {
  const picked = new Set<string>(keys.map(String));
  return deriveClass(BaseClass, `Pick${BaseClass.name}`, (key) =>
    picked.has(key),
  ) as Constructor<Pick<T, K>>;
}

/** A DTO with every property of `BaseClass` except the named ones. */
export function OmitType<T, K extends keyof T>(
  BaseClass: Constructor<T>,
  keys: readonly K[],
): Constructor<Omit<T, K>> {
  const omitted = new Set<string>(keys.map(String));
  return deriveClass(
    BaseClass,
    `Omit${BaseClass.name}`,
    (key) => !omitted.has(key),
  ) as Constructor<Omit<T, K>>;
}

// ---------------------------------------------------------------------------

function deriveClass(
  BaseClass: Constructor,
  name: string,
  include: (key: string) => boolean,
): Constructor {
  const kept = propertiesOf(BaseClass).filter(include);

  // Property initializers (`page = 1`) live in the constructor, so take the
  // defaults from an instance of the source when the DTO is instantiated.
  class Derived {
    constructor() {
      let defaults: any;
      try {
        defaults = new BaseClass();
      } catch {
        return;
      }
      for (const key of kept) {
        if (Object.prototype.hasOwnProperty.call(defaults, key)) {
          (this as any)[key] = defaults[key];
        }
      }
    }
  }
  Object.defineProperty(Derived, "name", { value: name });

  copyReflectMetadata(BaseClass, Derived, kept);
  copyClassValidatorRules(BaseClass, Derived, include);
  copyClassTransformerRules(BaseClass, Derived, include);
  copyRules(BaseClass, Derived, include);
  return Derived;
}

/** Every property name the DTO declares, plus `design:type` ones. */
function propertiesOf(BaseClass: Function): string[] {
  return dtoProperties(BaseClass);
}

/** `design:type`, `@OpenApiProperty` and other per-property reflect metadata. */
function copyReflectMetadata(
  BaseClass: Function,
  Derived: Function,
  keys: string[],
) {
  const from = BaseClass.prototype;
  const to = Derived.prototype;
  const schemaProps = new Set(getRegisteredSchemaProperties(BaseClass));
  for (const key of keys) {
    for (const metaKey of Reflect.getMetadataKeys(from, key)) {
      Reflect.defineMetadata(
        metaKey,
        Reflect.getMetadata(metaKey, from, key),
        to,
        key,
      );
    }
    if (schemaProps.has(key)) registerSchemaProperty(to, key);
  }
}

// ── class-validator ────────────────────────────────────────────────────────

function copyClassValidatorRules(
  BaseClass: Function,
  Derived: Function,
  include: (key: string) => boolean,
) {
  const cv = classValidator();
  if (!cv) return;
  const storage = cv.getMetadataStorage();
  for (const meta of classValidatorRules(BaseClass)) {
    if (!meta.propertyName || !include(meta.propertyName)) continue;
    storage.addValidationMetadata(
      Object.assign(Object.create(Object.getPrototypeOf(meta)), meta, {
        target: Derived,
      }),
    );
  }
}

// ── class-transformer ──────────────────────────────────────────────────────

function copyClassTransformerRules(
  BaseClass: Function,
  Derived: Function,
  include: (key: string) => boolean,
) {
  const storage = getTransformerStorage();
  if (!storage) return;
  const chain: Function[] = [];
  for (
    let cls: any = BaseClass;
    typeof cls === "function" && cls !== Function.prototype;
    cls = Object.getPrototypeOf(cls)
  ) {
    chain.push(cls);
  }
  const clone = (meta: any) => ({ ...meta, target: Derived });

  // One entry per property; the nearest class wins, as findMetadata reads it.
  const single: [any, (meta: any) => void][] = [
    [storage._typeMetadatas, (m) => storage.addTypeMetadata(m)],
    [storage._exposeMetadatas, (m) => storage.addExposeMetadata(m)],
    [storage._excludeMetadatas, (m) => storage.addExcludeMetadata(m)],
  ];
  for (const [map, add] of single) {
    if (!(map instanceof Map)) continue;
    const done = new Set<unknown>();
    for (const cls of chain) {
      const entry = map.get(cls);
      if (!(entry instanceof Map)) continue;
      for (const [key, meta] of entry) {
        // A class-level @Expose/@Exclude has no property name; keep it.
        if (done.has(key) || (typeof key === "string" && !include(key))) {
          continue;
        }
        done.add(key);
        add(clone(meta));
      }
    }
  }

  // @Transform lists: stored as own ++ ancestors so findTransformMetadatas
  // reads them back in the source's order.
  const transforms = storage._transformMetadatas;
  if (transforms instanceof Map) {
    for (const cls of chain) {
      const entry = transforms.get(cls);
      if (!(entry instanceof Map)) continue;
      for (const [key, list] of entry) {
        if (typeof key !== "string" || !include(key)) continue;
        for (const meta of list as any[]) {
          storage.addTransformMetadata(clone(meta));
        }
      }
    }
  }
}

// ── PartialType: optional ──────────────────────────────────────────────────

/**
 * Add an `@IsOptional()` for `key`, with whichever library the source DTO
 * validates with, so the derived DTO doesn't mix the two. A DTO without any
 * validation rules gets none.
 */
function makeOptional(BaseClass: Function, Derived: Function, key: string) {
  // OpenAPI: a property marked required in @OpenApiProperty isn't any more.
  const meta = Reflect.getMetadata("property:openapi", Derived.prototype, key);
  if (meta?.required) {
    Reflect.defineMetadata(
      "property:openapi",
      { ...meta, required: false },
      Derived.prototype,
      key,
    );
  }

  const condition = (o: any) => o[key] !== null && o[key] !== undefined;
  if (getValidationRules(BaseClass).length > 0) {
    addValidationRule({
      kind: "conditionalValidation",
      name: "isOptional",
      target: Derived,
      propertyName: key,
      constraints: [],
      each: false,
      condition,
    });
    return;
  }
  const cv = classValidator();
  if (cv && classValidatorRules(BaseClass).length > 0) {
    const {
      ValidationMetadata,
    } = require("class-validator/cjs/metadata/ValidationMetadata");
    cv.getMetadataStorage().addValidationMetadata(
      new ValidationMetadata({
        type: cv.ValidationTypes.CONDITIONAL_VALIDATION,
        name: "isOptional",
        target: Derived,
        propertyName: key,
        constraints: [condition],
        validationOptions: {},
      }),
    );
  }
}
