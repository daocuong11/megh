/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 *
 * `@Type`, `@Transform`, `@Expose` and `@Exclude` with class-transformer's
 * names and behaviour, and the conversions they drive: `plainToInstance`
 * (request bodies, query strings) and `instanceToPlain` (responses).
 */
import {
  addExcludeRule,
  addExposeRule,
  addTransformRule,
  addTypeRule,
  Discriminator,
  ExcludeOptions,
  ExposeOptions,
  findExposedPropertyByName,
  findExposeRule,
  findTransformRules,
  findTypeRule,
  getExcludedProperties,
  getExposedProperties,
  getStrategy,
  getTransformedProperties,
  metadataRevision,
  TransformationType,
  TransformFnParams,
  TransformOptions,
  TransformRule,
  TypeHelpOptions,
  TypeRule,
} from "./metadata";

export type TypeOptions = {
  /**
   * Pick the nested class from a property of the plain object:
   * `{ property: "kind", subTypes: [{ name: "cat", value: CatDto }] }`.
   */
  discriminator?: Discriminator;
  /** Keep the discriminator property on the instance (it is removed by default). */
  keepDiscriminatorProperty?: boolean;
};

/**
 * The class (or `Number`, `String`, `Boolean`, `Date`) a property's value is
 * converted to. Needed for `@ValidateNested` and for query values, which
 * arrive as strings.
 */
export function Type(
  typeFunction?: (options?: TypeHelpOptions) => Function,
  options: TypeOptions = {},
): PropertyDecorator {
  return (target, propertyName) => {
    const reflectedType =
      typeof (Reflect as any).getMetadata === "function"
        ? (Reflect as any).getMetadata("design:type", target, propertyName)
        : undefined;
    addTypeRule(target.constructor, String(propertyName), {
      typeFunction,
      reflectedType,
      options,
    });
  };
}

/** Change a property's value while the request body becomes the DTO. */
export function Transform(
  transformFn: (params: TransformFnParams) => any,
  options: TransformOptions = {},
): PropertyDecorator {
  return (target, propertyName) => {
    addTransformRule(target.constructor, String(propertyName), {
      transformFn,
      options,
    });
  };
}

/**
 * Include a property when converting (with `excludeExtraneousValues`, only
 * exposed properties are kept), optionally under another `name` in plain
 * objects. On a class, exposes every property.
 */
export function Expose(
  options: ExposeOptions = {},
): PropertyDecorator & ClassDecorator {
  return ((target: any, propertyName?: string | symbol) => {
    if (propertyName === undefined) {
      addExposeRule(target, undefined, options);
    } else {
      addExposeRule(target.constructor, String(propertyName), options);
    }
  }) as PropertyDecorator & ClassDecorator;
}

/**
 * Leave a property out when converting: from responses (`toPlainOnly`), from
 * request DTOs (`toClassOnly`), or both. On a class, excludes every property
 * that isn't `@Expose`d.
 */
export function Exclude(
  options: ExcludeOptions = {},
): PropertyDecorator & ClassDecorator {
  return ((target: any, propertyName?: string | symbol) => {
    if (propertyName === undefined) {
      addExcludeRule(target, undefined, options);
    } else {
      addExcludeRule(target.constructor, String(propertyName), options);
    }
  }) as PropertyDecorator & ClassDecorator;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** The class-transformer options Megh supports. */
export type ClassTransformOptions = {
  /** Keep only `@Expose`d properties. */
  excludeExtraneousValues?: boolean;
  /** Convert values to the property's declared TypeScript type when it has no `@Type`. */
  enableImplicitConversion?: boolean;
  /** Set properties whose value is `undefined` (default `true`). */
  exposeUnsetFields?: boolean;
};

/** class-transformer's default options, as `@Transform` functions see them. */
const DEFAULT_OPTIONS = Object.freeze({
  enableCircularCheck: false,
  enableImplicitConversion: false,
  excludeExtraneousValues: false,
  excludePrefixes: undefined,
  exposeDefaultValues: false,
  exposeUnsetFields: true,
  groups: undefined,
  ignoreDecorators: false,
  strategy: undefined,
  targetMaps: undefined,
  version: undefined,
});

type Run = {
  type: TransformationType;
  options: Readonly<Record<string, any>> & ClassTransformOptions;
};

function makeRun(
  type: TransformationType,
  options?: ClassTransformOptions,
): Run {
  return {
    type,
    options: options
      ? Object.freeze({ ...DEFAULT_OPTIONS, ...options })
      : DEFAULT_OPTIONS,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Own prototype properties without a setter: never assigned (getters, methods). */
const readonlyKeysCache = new WeakMap<object, Set<string>>();
function readonlyKeys(prototype: object): Set<string> {
  let keys = readonlyKeysCache.get(prototype);
  if (!keys) {
    keys = new Set();
    for (const key of Object.getOwnPropertyNames(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (descriptor && !descriptor.set) keys.add(key);
    }
    readonlyKeysCache.set(prototype, keys);
  }
  return keys;
}

function instantiateArrayType(arrayType: any): any {
  const array = new arrayType();
  if (!(array instanceof Set) && !("push" in array)) return [];
  return array;
}

/** A class's resolved `@Type` / `@Transform` rules, by property and direction. */
type ClassRules = {
  revision: number;
  types: Map<string, TypeRule>;
  toClass: Map<string, TransformRule[]>;
  toPlain: Map<string, TransformRule[]>;
};
const classRulesCache = new WeakMap<Function, ClassRules>();
function classRules(type: Function): ClassRules {
  const cached = classRulesCache.get(type);
  if (cached && cached.revision === metadataRevision()) return cached;
  const rules: ClassRules = {
    revision: metadataRevision(),
    types: new Map(),
    toClass: new Map(),
    toPlain: new Map(),
  };
  for (const key of getTransformedProperties(type)) {
    const typeRule = findTypeRule(type, key);
    if (typeRule) rules.types.set(key, typeRule);
    const toClass = findTransformRules(
      type,
      key,
      TransformationType.PLAIN_TO_CLASS,
    );
    if (toClass.length) rules.toClass.set(key, toClass);
    const toPlain = findTransformRules(
      type,
      key,
      TransformationType.CLASS_TO_PLAIN,
    );
    if (toPlain.length) rules.toPlain.set(key, toPlain);
  }
  classRulesCache.set(type, rules);
  return rules;
}

const isPromise = (p: any) =>
  p !== null && typeof p === "object" && typeof p.then === "function";

/** class-transformer's `getKeys`. */
function getKeys(
  target: Function | undefined,
  object: any,
  isMap: boolean,
  run: Run,
): string[] {
  let strategy = target ? getStrategy(target) : "none";
  if (strategy === "none") strategy = "exposeAll";
  let keys: string[] = [];
  if (strategy === "exposeAll" || isMap) {
    keys =
      object instanceof Map ? Array.from(object.keys()) : Object.keys(object);
  }
  if (isMap) return keys;
  if (target) {
    let exposed = getExposedProperties(target, run.type);
    if (run.type === TransformationType.PLAIN_TO_CLASS) {
      exposed = exposed.map((key) => findExposeRule(target, key)?.name || key);
    }
    keys = run.options.excludeExtraneousValues ? exposed : keys.concat(exposed);
    const excluded = getExcludedProperties(target, run.type);
    if (excluded.length > 0) keys = keys.filter((k) => !excluded.includes(k));
    // Megh transforms without groups: a grouped @Expose never applies.
    keys = keys.filter((key) => {
      const expose = findExposeRule(target, key);
      return !expose || !expose.groups || !expose.groups.length;
    });
  }
  return keys.filter((key, index, self) => self.indexOf(key) === index);
}

/** The class `@Type({ discriminator })` selects for one value. */
function discriminatedType(
  rule: TypeRule,
  subValue: any,
  helpOptions: TypeHelpOptions,
): any {
  const { discriminator, keepDiscriminatorProperty } = rule.options!;
  const hasProperty =
    subValue &&
    subValue instanceof Object &&
    discriminator!.property in subValue;
  const found = hasProperty
    ? discriminator!.subTypes.find(
        (subType) => subType.name === subValue[discriminator!.property],
      )
    : undefined;
  if (!keepDiscriminatorProperty && hasProperty) {
    delete subValue[discriminator!.property];
  }
  if (found) return found.value;
  return rule.typeFunction ? rule.typeFunction(helpOptions) : undefined;
}

const hasDiscriminator = (rule: TypeRule | undefined) =>
  !!(
    rule?.options?.discriminator?.property &&
    rule.options.discriminator.subTypes
  );

/** For CLASS_TO_PLAIN: write the subtype's name back to the discriminator property. */
function markDiscriminator(rule: TypeRule, subValue: any) {
  if (!subValue || typeof subValue !== "object") return;
  const { discriminator } = rule.options!;
  const found = discriminator!.subTypes.find(
    (subType) => subType.value === subValue.constructor,
  );
  if (found) subValue[discriminator!.property] = found.name;
}

/** Conversions of primitives, dates, buffers and promises, shared by both directions. */
function convertScalar(
  value: any,
  targetType: any,
  isMap: boolean,
  again: (v: any) => any,
): { done: boolean; value?: any } {
  if (!isMap) {
    if (targetType === String)
      return { done: true, value: value == null ? value : String(value) };
    if (targetType === Number)
      return { done: true, value: value == null ? value : Number(value) };
    if (targetType === Boolean)
      return { done: true, value: value == null ? value : Boolean(value) };
    if (targetType === Date || value instanceof Date) {
      if (value instanceof Date)
        return { done: true, value: new Date(value.valueOf()) };
      return { done: true, value: value == null ? value : new Date(value) };
    }
    if (
      typeof Buffer !== "undefined" &&
      (targetType === Buffer || value instanceof Buffer)
    ) {
      return { done: true, value: value == null ? value : Buffer.from(value) };
    }
    if (isPromise(value)) {
      return {
        done: true,
        value: new Promise((resolve, reject) => {
          value.then((data: any) => resolve(again(data)), reject);
        }),
      };
    }
  }
  if (typeof value !== "object" || value === null) return { done: true, value };
  return { done: false };
}

/** The class an object converts as: the given one, else its own constructor. */
function objectType(value: any, targetType: any): any {
  let type = targetType;
  if (!type && value.constructor !== Object) {
    // An object pretending to be an array (`{ __proto__: [] }`) is not trusted.
    if (!(!Array.isArray(value) && value.constructor === Array)) {
      type = value.constructor;
    }
  }
  // `{"constructor": 1}` makes class-transformer throw; treat it as plain.
  return typeof type === "function" ? type : undefined;
}

// ---------------------------------------------------------------------------
// plainToInstance
// ---------------------------------------------------------------------------

/**
 * `plainToInstance(target, plain)`: a new instance of `target` with every key
 * of `plain` converted by the class's `@Type`, `@Transform` and `@Expose`
 * rules.
 */
export function toInstance<T>(
  target: new () => T,
  plain: object,
  options?: ClassTransformOptions,
): T {
  return toClass(
    plain,
    target,
    undefined,
    false,
    makeRun(TransformationType.PLAIN_TO_CLASS, options),
  );
}

/**
 * Convert a plain object (or an array of them) into instances of `cls`, as
 * class-transformer's `plainToInstance` does, using Megh's decorators.
 */
export function plainToInstance<T>(
  cls: new (...args: any[]) => T,
  plain: unknown[],
  options?: ClassTransformOptions,
): T[];
export function plainToInstance<T>(
  cls: new (...args: any[]) => T,
  plain: unknown,
  options?: ClassTransformOptions,
): T;
export function plainToInstance(
  cls: any,
  plain: any,
  options?: ClassTransformOptions,
): any {
  return toClass(
    plain,
    cls,
    undefined,
    false,
    makeRun(TransformationType.PLAIN_TO_CLASS, options),
  );
}

/** class-transformer's `TransformOperationExecutor.transform`, plain → class. */
function toClass(
  value: any,
  targetType: any,
  arrayType: any,
  isMap: boolean,
  run: Run,
): any {
  if (Array.isArray(value) || value instanceof Set) {
    const out = arrayType ? instantiateArrayType(arrayType) : [];
    value.forEach((sub: any) => {
      let itemType = targetType;
      if (targetType && typeof targetType === "object") {
        // A discriminated @Type on an array property: pick per item.
        itemType = discriminatedType(targetType, sub, {
          newObject: out,
          object: sub,
          property: undefined as any,
        });
      }
      const converted = toClass(
        sub,
        itemType,
        undefined,
        sub instanceof Map,
        run,
      );
      if (out instanceof Set) out.add(converted);
      else out.push(converted);
    });
    return out;
  }
  const scalar = convertScalar(value, targetType, isMap, (data) =>
    toClass(data, targetType, undefined, false, run),
  );
  if (scalar.done) return scalar.value;

  const type = objectType(value, targetType);
  const keys = getKeys(type, value, isMap, run);
  const out: any = isMap ? new Map() : type ? new type() : {};
  const prototype = out.constructor ? out.constructor.prototype : undefined;
  const skip = prototype ? readonlyKeys(prototype) : undefined;
  const rules = type ? classRules(type) : undefined;

  for (const key of keys) {
    if (key === "__proto__" || key === "constructor") continue;
    let propertyName = key;
    if (type) {
      const exposed = findExposedPropertyByName(type, key);
      if (exposed) propertyName = exposed;
    }
    const sub = value[key];

    let subType: any;
    let subIsMap = sub instanceof Map;
    let arrayItemsType: any;
    if (type && isMap) {
      subType = type;
    } else if (type) {
      const rule = rules!.types.get(propertyName);
      if (rule) {
        const helpOptions = {
          newObject: out,
          object: value,
          property: propertyName,
        };
        if (hasDiscriminator(rule)) {
          subType = Array.isArray(sub)
            ? rule
            : discriminatedType(rule, sub, helpOptions);
        } else {
          subType = rule.typeFunction
            ? rule.typeFunction(helpOptions)
            : rule.reflectedType;
        }
        subIsMap = subIsMap || rule.reflectedType === Map;
        if (Array.isArray(sub)) arrayItemsType = rule.reflectedType;
      } else if (run.options.enableImplicitConversion) {
        const reflected =
          typeof (Reflect as any).getMetadata === "function"
            ? (Reflect as any).getMetadata(
                "design:type",
                type.prototype,
                propertyName,
              )
            : undefined;
        if (reflected) subType = reflected;
      }
    }

    if (
      skip &&
      (skip.has(propertyName) || out[propertyName] instanceof Function)
    )
      continue;

    let result = toClass(sub, subType, arrayItemsType, subIsMap, run);
    const transforms = rules?.toClass.get(propertyName);
    if (transforms) {
      for (const rule of transforms) {
        result = rule.transformFn({
          value: result,
          key: propertyName,
          obj: value,
          type: TransformationType.PLAIN_TO_CLASS,
          options: run.options,
        });
      }
    }
    if (result !== undefined || run.options.exposeUnsetFields) {
      if (out instanceof Map) out.set(propertyName, result);
      else out[propertyName] = result;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// instanceToPlain
// ---------------------------------------------------------------------------

/**
 * Convert an instance (or an array of them) into a plain object, as
 * class-transformer's `instanceToPlain` does: `@Exclude`d properties are
 * dropped, `@Expose({ name })` renames, `@Transform` (to plain) applies and
 * getters are read.
 */
export function instanceToPlain(
  object: unknown,
  options?: ClassTransformOptions,
): any {
  return toPlain(
    object,
    undefined,
    false,
    makeRun(TransformationType.CLASS_TO_PLAIN, options),
  );
}

/** class-transformer's `TransformOperationExecutor.transform`, class → plain. */
function toPlain(value: any, targetType: any, isMap: boolean, run: Run): any {
  if (Array.isArray(value) || value instanceof Set) {
    const out: any[] = [];
    value.forEach((sub: any) => {
      let itemType = targetType;
      if (targetType && typeof targetType === "object") {
        markDiscriminator(targetType, sub);
        itemType = undefined;
      }
      out.push(toPlain(sub, itemType, sub instanceof Map, run));
    });
    return out;
  }
  const scalar = convertScalar(value, targetType, isMap, (data) =>
    toPlain(data, targetType, false, run),
  );
  if (scalar.done) return scalar.value;

  const type = objectType(value, targetType);
  const keys = getKeys(type, value, isMap, run);
  const out: any = {};
  const rules = type ? classRules(type) : undefined;

  for (const key of keys) {
    if (key === "__proto__" || key === "constructor") continue;
    let newKey = key;
    if (type) {
      const expose = findExposeRule(type, key);
      if (expose && expose.name) newKey = expose.name;
    }
    let sub: any;
    if (value instanceof Map) sub = value.get(key);
    else if (value[key] instanceof Function) sub = value[key]();
    else sub = value[key];

    let subType: any;
    let subIsMap = sub instanceof Map;
    if (type && isMap) {
      subType = type;
    } else if (type) {
      const rule = rules!.types.get(key);
      if (rule) {
        const helpOptions = { newObject: out, object: value, property: key };
        const newType = rule.typeFunction
          ? rule.typeFunction(helpOptions)
          : rule.reflectedType;
        if (hasDiscriminator(rule)) {
          if (!Array.isArray(value[key])) {
            markDiscriminator(rule, sub);
            subType = newType;
          } else subType = rule;
        } else subType = newType;
        subIsMap = subIsMap || rule.reflectedType === Map;
      }
    }

    let result = value instanceof Map ? sub : value[key];
    const original = result;
    const transforms = rules?.toPlain.get(key);
    if (transforms) {
      for (const rule of transforms) {
        result = rule.transformFn({
          value: result,
          key,
          obj: value,
          type: TransformationType.CLASS_TO_PLAIN,
          options: run.options,
        });
      }
    }
    if (result === original) result = sub;
    result = toPlain(result, subType, subIsMap, run);
    if (result !== undefined || run.options.exposeUnsetFields) {
      out[newKey] = result;
    }
  }
  return out;
}
