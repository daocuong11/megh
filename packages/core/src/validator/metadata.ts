/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 *
 * Metadata for Megh's validation and transformation decorators.
 *
 * Rules are stored and looked up the way class-validator and class-transformer
 * store theirs, so a DTO validates, transforms and reports errors the same
 * whichever set of decorators it uses.
 */

/** What a message function receives (class-validator's `ValidationArguments`). */
export type ValidationArguments = {
  value: any;
  constraints: any[];
  targetName: string;
  object: object;
  property: string;
};

/** Options every validation decorator accepts (class-validator's `ValidationOptions`). */
export type ValidationOptions = {
  /** Validate each item of an array, Set or Map instead of the value itself. */
  each?: boolean;
  /** Replaces the default message. `$property`, `$value`, `$target` and `$constraint1`… are filled in. */
  message?: string | ((args: ValidationArguments) => string);
  /** Accepted for compatibility. Request validation runs without groups, so every rule applies. */
  groups?: string[];
  /** Accepted for compatibility; has no effect without groups. */
  always?: boolean;
  /** Accepted for compatibility; not part of request errors. */
  context?: any;
};

/**
 * class-validator's metadata types. Inherited rules are dropped when the
 * subclass declares a rule of the same kind on the same property.
 */
export type RuleKind =
  | "customValidation"
  | "isDefined"
  | "conditionalValidation"
  | "nestedValidation"
  | "whitelistValidation";

export type RuleCheck = {
  /**
   * Reference implementation: is `value` valid? Custom checks also get the
   * object being validated, and may return a promise.
   */
  fn: (
    value: any,
    constraints: any[],
    prepared: any,
    object?: any,
    whole?: any,
  ) => boolean | Promise<boolean>;
  /**
   * The same check as a JavaScript expression, for the compiler. `x` is the
   * value expression, `k` the constraints array, `p` the prepared value.
   */
  inline?: (x: string, k: string, p: string) => string;
  /** Computed once when the validator is compiled (e.g. enum values, a RegExp). */
  prepare?: (constraints: any[]) => any;
};

export type ValidationRule = {
  kind: RuleKind;
  /** Constraint key in errors (`isString`), or `isOptional` / undefined. */
  name?: string;
  target: Function;
  propertyName: string;
  constraints: any[];
  each: boolean;
  message?: ValidationOptions["message"];
  defaultMessage?: (eachPrefix: string, args: ValidationArguments) => string;
  check?: RuleCheck;
  /** For `conditionalValidation`: validate only when this returns truthy. */
  condition?: (object: any, value: any) => boolean;
  /**
   * A user-defined check (`@Validate`, `registerDecorator`, `ValidateBy`). Its
   * `fn` gets the object as a fourth argument and may return a promise.
   */
  custom?: boolean;
  /** Declared async (`@ValidatorConstraint({ async: true })`, `registerDecorator({ async: true })`). */
  async?: boolean;
};

export type TypeHelpOptions = {
  newObject: any;
  object: Record<string, any>;
  property: string;
};

/** class-transformer's `DiscriminatorDescriptor`. */
export type Discriminator = {
  /** The property of the plain object that names its type. */
  property: string;
  /** `name` is the property's value, `value` the class it selects. */
  subTypes: { name: string; value: Function }[];
};

export type TypeRule = {
  typeFunction?: (options?: TypeHelpOptions) => Function;
  reflectedType: any;
  options?: {
    discriminator?: Discriminator;
    keepDiscriminatorProperty?: boolean;
  };
};

/** class-transformer's `TransformationType`. */
export enum TransformationType {
  PLAIN_TO_CLASS = 0,
  CLASS_TO_PLAIN = 1,
  CLASS_TO_CLASS = 2,
}

export type TransformFnParams = {
  value: any;
  key: string;
  obj: any;
  type: TransformationType;
  options: Record<string, any>;
};

export type TransformOptions = {
  toClassOnly?: boolean;
  toPlainOnly?: boolean;
  groups?: string[];
  since?: number;
  until?: number;
};

export type TransformRule = {
  transformFn: (params: TransformFnParams) => any;
  options: TransformOptions;
};

/** class-transformer's `ExposeOptions`. */
export type ExposeOptions = {
  /** The key the property has in plain objects (request bodies, responses). */
  name?: string;
  /** Accepted for compatibility. Megh transforms without groups, so a grouped `@Expose` never applies. */
  groups?: string[];
  /** Accepted for compatibility; Megh transforms without a version. */
  since?: number;
  /** Accepted for compatibility; Megh transforms without a version. */
  until?: number;
  toClassOnly?: boolean;
  toPlainOnly?: boolean;
};

/** class-transformer's `ExcludeOptions`. */
export type ExcludeOptions = {
  toClassOnly?: boolean;
  toPlainOnly?: boolean;
};

export type Strategy = "none" | "exposeAll" | "excludeAll";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Rules per class, in the order the decorators ran. Map order = registration order. */
const validationRules = new Map<Function, ValidationRule[]>();
const typeRules = new Map<Function, Map<string, TypeRule>>();
const transformRules = new Map<Function, Map<string, TransformRule[]>>();
const exposeRules = new Map<Function, Map<string, ExposeOptions>>();
const excludeRules = new Map<Function, Map<string, ExcludeOptions>>();
/** Class-level `@Expose()` / `@Exclude()`. */
const classExpose = new Set<Function>();
const classExclude = new Set<Function>();

/** Bumped on every registration, so compiled validators can be rebuilt. */
let revision = 0;
export const metadataRevision = () => revision;

export function addValidationRule(rule: ValidationRule) {
  let list = validationRules.get(rule.target);
  if (!list) validationRules.set(rule.target, (list = []));
  list.push(rule);
  revision++;
}

export function addTypeRule(
  target: Function,
  propertyName: string,
  rule: TypeRule,
) {
  let map = typeRules.get(target);
  if (!map) typeRules.set(target, (map = new Map()));
  // class-transformer keeps one @Type per property; the last one registered wins.
  map.set(propertyName, rule);
  revision++;
}

export function addTransformRule(
  target: Function,
  propertyName: string,
  rule: TransformRule,
) {
  let map = transformRules.get(target);
  if (!map) transformRules.set(target, (map = new Map()));
  let list = map.get(propertyName);
  if (!list) map.set(propertyName, (list = []));
  list.push(rule);
  revision++;
}

export function addExposeRule(
  target: Function,
  propertyName: string | undefined,
  options: ExposeOptions,
) {
  if (propertyName === undefined) classExpose.add(target);
  else {
    let map = exposeRules.get(target);
    if (!map) exposeRules.set(target, (map = new Map()));
    map.set(propertyName, options);
  }
  revision++;
}

export function addExcludeRule(
  target: Function,
  propertyName: string | undefined,
  options: ExcludeOptions,
) {
  if (propertyName === undefined) classExclude.add(target);
  else {
    let map = excludeRules.get(target);
    if (!map) excludeRules.set(target, (map = new Map()));
    map.set(propertyName, options);
  }
  revision++;
}

/** class-transformer's `getStrategy`: from class-level `@Expose` / `@Exclude` on `target` itself. */
export function getStrategy(target: Function): Strategy {
  const exclude = classExclude.has(target);
  const expose = classExpose.has(target);
  if (exclude === expose) return "none";
  return exclude ? "excludeAll" : "exposeAll";
}

/** Does `toClassOnly` / `toPlainOnly` let a rule apply in this direction? */
function appliesTo(
  options: { toClassOnly?: boolean; toPlainOnly?: boolean } | undefined,
  type: TransformationType,
): boolean {
  if (!options) return true;
  if (options.toClassOnly === true && options.toPlainOnly === true) return true;
  if (options.toClassOnly === true)
    return (
      type === TransformationType.CLASS_TO_CLASS ||
      type === TransformationType.PLAIN_TO_CLASS
    );
  if (options.toPlainOnly === true)
    return type === TransformationType.CLASS_TO_PLAIN;
  return true;
}

/** Ancestors first, then the class: class-transformer's `getMetadata` order. */
function collect<V>(
  maps: Map<Function, Map<string, V>>,
  target: Function,
): [string, V][] {
  const out: [string, V][] = [];
  for (const cls of [...getAncestors(target).reverse(), target]) {
    for (const entry of maps.get(cls) ?? []) out.push(entry);
  }
  return out;
}

/** Names of `@Expose`d properties for a direction (`getExposedProperties`). */
export function getExposedProperties(
  target: Function,
  type: TransformationType,
): string[] {
  return collect(exposeRules, target)
    .filter(([, options]) => appliesTo(options, type))
    .map(([name]) => name);
}

/** Names of `@Exclude`d properties for a direction (`getExcludedProperties`). */
export function getExcludedProperties(
  target: Function,
  type: TransformationType,
): string[] {
  return collect(excludeRules, target)
    .filter(([, options]) => appliesTo(options, type))
    .map(([name]) => name);
}

/** `@Expose` options for a property: the class's own, else the nearest ancestor's. */
export function findExposeRule(
  target: Function,
  propertyName: string,
): ExposeOptions | undefined {
  for (const cls of [target, ...getAncestors(target)]) {
    const found = exposeRules.get(cls)?.get(propertyName);
    if (found) return found;
  }
  return undefined;
}

/** The property whose `@Expose({ name })` is `name` (`findExposeMetadataByCustomName`). */
export function findExposedPropertyByName(
  target: Function,
  name: string,
): string | undefined {
  for (const [property, options] of collect(exposeRules, target)) {
    if (options.name === name) return property;
  }
  return undefined;
}

/**
 * The rules that apply to `target`: its own, then inherited ones, as
 * class-validator's `getTargetValidationMetadatas` returns them.
 */
export function getValidationRules(target: Function): ValidationRule[] {
  if (typeof target !== "function" || !target.prototype) return [];
  const original = validationRules.get(target) ?? [];
  const inherited: ValidationRule[] = [];
  for (const [cls, list] of validationRules) {
    if (target.prototype instanceof cls) inherited.push(...list);
  }
  const unique = inherited.filter(
    (rule) =>
      !original.some(
        (own) =>
          own.propertyName === rule.propertyName && own.kind === rule.kind,
      ),
  );
  return original.concat(unique);
}

/** Does `target` (or an ancestor) carry Megh validation decorators? */
export function isMeghValidatorClass(target: unknown): boolean {
  return typeof target === "function" && getValidationRules(target).length > 0;
}

/** class-transformer's `getAncestors`: nearest first. */
function getAncestors(target: Function): Function[] {
  const ancestors: Function[] = [];
  for (
    let base = Object.getPrototypeOf(target.prototype.constructor);
    base && typeof base.prototype !== "undefined";
    base = Object.getPrototypeOf(base.prototype.constructor)
  ) {
    ancestors.push(base);
  }
  return ancestors;
}

/** `@Type` for a property: the class's own, else the nearest ancestor's. */
export function findTypeRule(
  target: Function,
  propertyName: string,
): TypeRule | undefined {
  const own = typeRules.get(target)?.get(propertyName);
  if (own) return own;
  for (const ancestor of getAncestors(target)) {
    const found = typeRules.get(ancestor)?.get(propertyName);
    if (found) return found;
  }
  return undefined;
}

/**
 * `@Transform`s that apply when turning a plain object into a class, in
 * class-transformer's order (`findTransformMetadatas` + group filtering).
 */
export function findTransformRules(
  target: Function,
  propertyName: string,
  type: TransformationType = TransformationType.PLAIN_TO_CLASS,
): TransformRule[] {
  const fromAncestors: TransformRule[] = [];
  for (const ancestor of getAncestors(target)) {
    const list = transformRules.get(ancestor)?.get(propertyName);
    if (list) fromAncestors.push(...list);
  }
  const own = transformRules.get(target)?.get(propertyName) ?? [];
  return fromAncestors
    .slice()
    .reverse()
    .concat(own.slice().reverse())
    .filter(({ options }) => {
      if (!options) return true;
      if (options.groups && options.groups.length) return false;
      return appliesTo(options, type);
    });
}

/**
 * Property names with `@Type`, `@Transform`, `@Expose` or `@Exclude`, on the
 * class and its ancestors.
 */
export function getTransformedProperties(target: Function): string[] {
  const names = new Set<string>();
  if (typeof target !== "function" || !target.prototype) return [];
  for (const cls of [target, ...getAncestors(target)]) {
    for (const key of typeRules.get(cls)?.keys() ?? []) names.add(key);
    for (const key of transformRules.get(cls)?.keys() ?? []) names.add(key);
    for (const key of exposeRules.get(cls)?.keys() ?? []) names.add(key);
    for (const key of excludeRules.get(cls)?.keys() ?? []) names.add(key);
  }
  return [...names];
}

/** Has `target` (or an ancestor) any Megh transformation decorator, class-level ones included? */
export function hasTransformRules(target: Function): boolean {
  if (typeof target !== "function" || !target.prototype) return false;
  if (getTransformedProperties(target).length > 0) return true;
  return [target, ...getAncestors(target)].some(
    (cls) => classExpose.has(cls) || classExclude.has(cls),
  );
}

/** Is `name` `@Exclude`d in both directions on `target`? Used by OpenAPI. */
export function isExcludedEverywhere(target: Function, name: string): boolean {
  for (const cls of [target, ...getAncestors(target)]) {
    const options = excludeRules.get(cls)?.get(name);
    if (options) return !options.toClassOnly && !options.toPlainOnly;
  }
  return false;
}

/**
 * Copy the Megh rules of `source` (own and inherited) that apply to the
 * properties `include` accepts onto `target`. Used by PartialType, PickType
 * and OmitType, whose classes don't extend the source.
 */
export function copyRules(
  source: Function,
  target: Function,
  include: (propertyName: string) => boolean,
): void {
  for (const rule of getValidationRules(source)) {
    if (include(rule.propertyName)) addValidationRule({ ...rule, target });
  }
  for (const name of getTransformedProperties(source)) {
    if (!include(name)) continue;
    const type = findTypeRule(source, name);
    if (type) addTypeRule(target, name, type);
    // findTransformRules reads ancestors, then the class, each newest first;
    // stored as own ++ ancestors, the copy reads back in that same order.
    for (const cls of [source, ...getAncestors(source)]) {
      for (const rule of transformRules.get(cls)?.get(name) ?? []) {
        addTransformRule(target, name, rule);
      }
    }
    const expose = findExposeRule(source, name);
    if (expose) addExposeRule(target, name, expose);
    for (const cls of [source, ...getAncestors(source)]) {
      const exclude = excludeRules.get(cls)?.get(name);
      if (exclude) {
        addExcludeRule(target, name, exclude);
        break;
      }
    }
  }
  const strategy = getStrategy(source);
  if (strategy === "excludeAll") addExcludeRule(target, undefined, {});
  else if (strategy === "exposeAll") addExposeRule(target, undefined, {});
}
