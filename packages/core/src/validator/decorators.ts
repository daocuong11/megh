/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 *
 * Validation decorators with class-validator's names, options, checks,
 * constraint keys and default messages. Switching a DTO over is a change of
 * import:
 *
 *   import { IsString, MinLength } from "class-validator";   // before
 *   import { IsString, MinLength } from "@meghjs/core";      // after
 *
 * Megh compiles each DTO's rules once into a single function; see
 * `compiler.ts`. `@IsUrl`, `@IsEmail` with non-default options and the
 * string-format checks (`@IsAlpha`, `@IsISO8601`, `@IsMongoId`, …) call the
 * `validator` package, as class-validator does, so they accept exactly the
 * same values; install it to use them. `@IsEmail()` with default options and
 * `@IsUUID()` need no package (see `is-email.ts`). `@IsPhoneNumber` uses
 * `libphonenumber-js`, as class-validator does.
 */
import {
  addValidationRule,
  RuleCheck,
  RuleKind,
  ValidationArguments,
  ValidationOptions,
} from "./metadata";
import { isEmailDefault, usesDefaultEmailOptions } from "./is-email";

type Message = (eachPrefix: string, args: ValidationArguments) => string;

/** class-validator's `ValidateBy`: one named, synchronous check. */
function validateBy(
  name: string,
  constraints: any[],
  check: RuleCheck,
  message: Message,
  options?: ValidationOptions,
): PropertyDecorator {
  return (object, propertyName) => {
    addValidationRule({
      // class-validator gives `isDefined` its own metadata type.
      kind: (name === "isDefined"
        ? "isDefined"
        : "customValidation") as RuleKind,
      name,
      target: object.constructor,
      propertyName: String(propertyName),
      constraints,
      each: !!options?.each,
      message: options?.message,
      defaultMessage: message,
      check,
    });
  };
}

/** Load a `validator` package function, or explain how to install it. */
function validatorLib(
  fn: string,
  decorator: string,
): (...args: any[]) => boolean {
  try {
    const mod = require(`validator/lib/${fn}`);
    return mod.default ?? mod;
  } catch {
    throw new Error(
      `[Megh] @${decorator}() uses the "validator" package. Install it: npm install validator`,
    );
  }
}

/**
 * `validator`'s `isEmail` throws `URIError` for an unpaired surrogate; that is
 * an invalid address, not a server error.
 */
function rejectOnUriError(fn: (...args: any[]) => boolean) {
  return (...args: any[]) => {
    try {
      return fn(...args);
    } catch (error) {
      if (error instanceof URIError) return false;
      throw error;
    }
  };
}

// ── Common ──────────────────────────────────────────────────────────────────

/** Skip every other rule on this property when the value is `null` or `undefined`. */
export function IsOptional(options?: ValidationOptions): PropertyDecorator {
  return (object, propertyName) => {
    const key = String(propertyName);
    addValidationRule({
      kind: "conditionalValidation",
      name: "isOptional",
      target: object.constructor,
      propertyName: key,
      constraints: [],
      each: !!options?.each,
      message: options?.message,
      condition: (o) => o[key] !== null && o[key] !== undefined,
    });
  };
}

/** Validate this property only when `condition(object, value)` is truthy. */
export function ValidateIf(
  condition: (object: any, value: any) => boolean,
  options?: ValidationOptions,
): PropertyDecorator {
  return (object, propertyName) => {
    addValidationRule({
      kind: "conditionalValidation",
      target: object.constructor,
      propertyName: String(propertyName),
      constraints: [condition],
      each: !!options?.each,
      message: options?.message,
      condition,
    });
  };
}

/** Allow the property through the whitelist without checking it. */
export function Allow(options?: ValidationOptions): PropertyDecorator {
  return (object, propertyName) => {
    addValidationRule({
      kind: "whitelistValidation",
      target: object.constructor,
      propertyName: String(propertyName),
      constraints: [],
      each: !!options?.each,
      message: options?.message,
    });
  };
}

/**
 * Validate the nested object (or each item of an array) against its own
 * class. Pair it with `@Type(() => Class)` so the value becomes an instance.
 */
export function ValidateNested(options?: ValidationOptions): PropertyDecorator {
  const eachPrefix = options?.each ? "each value in " : "";
  const message =
    options?.message ||
    eachPrefix + "nested property $property must be either object or array";
  return (object, propertyName) => {
    addValidationRule({
      kind: "nestedValidation",
      target: object.constructor,
      propertyName: String(propertyName),
      constraints: [],
      each: !!options?.each,
      message,
    });
  };
}

export const IsDefined = (options?: ValidationOptions) =>
  validateBy(
    "isDefined",
    [],
    {
      fn: (v) => v !== undefined && v !== null,
      inline: (x) => `(${x} !== undefined && ${x} !== null)`,
    },
    (p) => p + "$property should not be null or undefined",
    options,
  );

export const IsNotEmpty = (options?: ValidationOptions) =>
  validateBy(
    "isNotEmpty",
    [],
    {
      fn: (v) => v !== "" && v !== null && v !== undefined,
      inline: (x) => `(${x} !== "" && ${x} !== null && ${x} !== undefined)`,
    },
    (p) => p + "$property should not be empty",
    options,
  );

export const IsEmpty = (options?: ValidationOptions) =>
  validateBy(
    "isEmpty",
    [],
    {
      fn: (v) => v === "" || v === null || v === undefined,
      inline: (x) => `(${x} === "" || ${x} === null || ${x} === undefined)`,
    },
    (p) => p + "$property must be empty",
    options,
  );

export const IsIn = (values: readonly any[], options?: ValidationOptions) =>
  validateBy(
    "isIn",
    [values],
    {
      fn: (v, [list]) => Array.isArray(list) && list.some((item) => item === v),
      // indexOf compares with ===, like `some(item => item === v)`.
      inline: (x, k) =>
        `(Array.isArray(${k}[0]) && ${k}[0].indexOf(${x}) !== -1)`,
    },
    (p) => p + "$property must be one of the following values: $constraint1",
    options,
  );

export const IsNotIn = (values: readonly any[], options?: ValidationOptions) =>
  validateBy(
    "isNotIn",
    [values],
    {
      fn: (v, [list]) =>
        !Array.isArray(list) || !list.some((item) => item === v),
      inline: (x, k) =>
        `(!Array.isArray(${k}[0]) || ${k}[0].indexOf(${x}) === -1)`,
    },
    (p) =>
      p + "$property should not be one of the following values: $constraint1",
    options,
  );

// ── Type checks ─────────────────────────────────────────────────────────────

export const IsString = (options?: ValidationOptions) =>
  validateBy(
    "isString",
    [],
    {
      fn: (v) => v instanceof String || typeof v === "string",
      inline: (x) => `(typeof ${x} === "string" || ${x} instanceof String)`,
    },
    (p) => p + "$property must be a string",
    options,
  );

export type IsNumberOptions = {
  allowNaN?: boolean;
  allowInfinity?: boolean;
  maxDecimalPlaces?: number;
};

function isNumber(value: any, options: IsNumberOptions = {}): boolean {
  if (typeof value !== "number") return false;
  if (value === Infinity || value === -Infinity) return !!options.allowInfinity;
  if (Number.isNaN(value)) return !!options.allowNaN;
  if (options.maxDecimalPlaces !== undefined) {
    let decimalPlaces = 0;
    if (value % 1 !== 0) decimalPlaces = value.toString().split(".")[1].length;
    if (decimalPlaces > options.maxDecimalPlaces) return false;
  }
  return Number.isFinite(value);
}

export const IsNumber = (
  numberOptions: IsNumberOptions = {},
  options?: ValidationOptions,
) =>
  validateBy(
    "isNumber",
    [numberOptions],
    {
      fn: (v, [o]) => isNumber(v, o),
      // With no options a number is valid exactly when it is finite.
      prepare: ([o]) =>
        !o ||
        (!o.allowNaN && !o.allowInfinity && o.maxDecimalPlaces === undefined),
      inline: (x, k, p) =>
        `(${p} ? (typeof ${x} === "number" && Number.isFinite(${x})) : H.isNumber(${x}, ${k}[0]))`,
    },
    (p) =>
      p + "$property must be a number conforming to the specified constraints",
    options,
  );

export const IsInt = (options?: ValidationOptions) =>
  validateBy(
    "isInt",
    [],
    {
      fn: (v) => typeof v === "number" && Number.isInteger(v),
      inline: (x) => `(typeof ${x} === "number" && Number.isInteger(${x}))`,
    },
    (p) => p + "$property must be an integer number",
    options,
  );

export const IsBoolean = (options?: ValidationOptions) =>
  validateBy(
    "isBoolean",
    [],
    {
      fn: (v) => v instanceof Boolean || typeof v === "boolean",
      inline: (x) => `(typeof ${x} === "boolean" || ${x} instanceof Boolean)`,
    },
    (p) => p + "$property must be a boolean value",
    options,
  );

export const IsDate = (options?: ValidationOptions) =>
  validateBy(
    "isDate",
    [],
    {
      fn: (v) => v instanceof Date && !isNaN(v.getTime()),
      inline: (x) => `(${x} instanceof Date && !isNaN(${x}.getTime()))`,
    },
    (p) => p + "$property must be a Date instance",
    options,
  );

export const IsArray = (options?: ValidationOptions) =>
  validateBy(
    "isArray",
    [],
    { fn: (v) => Array.isArray(v), inline: (x) => `Array.isArray(${x})` },
    (p) => p + "$property must be an array",
    options,
  );

export const IsObject = (options?: ValidationOptions) =>
  validateBy(
    "isObject",
    [],
    {
      fn: (v) =>
        v != null &&
        (typeof v === "object" || typeof v === "function") &&
        !Array.isArray(v),
      inline: (x) =>
        `(${x} != null && (typeof ${x} === "object" || typeof ${x} === "function") && !Array.isArray(${x}))`,
    },
    (p) => p + "$property must be an object",
    options,
  );

function validEnumValues(entity: any): any[] {
  return Object.entries(entity)
    .filter(([key]) => isNaN(parseInt(key)))
    .map(([, value]) => value);
}

export const IsEnum = (entity: object, options?: ValidationOptions) =>
  validateBy(
    "isEnum",
    [entity, validEnumValues(entity)],
    {
      fn: (v, [e]) =>
        Object.keys(e)
          .map((k) => e[k])
          .includes(v),
      prepare: ([e]) => Object.keys(e).map((k) => e[k]),
      inline: (x, k, p) => `${p}.includes(${x})`,
    },
    (p) => p + "$property must be one of the following values: $constraint2",
    options,
  );

// ── Numbers ─────────────────────────────────────────────────────────────────

export const Min = (minValue: number, options?: ValidationOptions) =>
  validateBy(
    "min",
    [minValue],
    {
      fn: (v, [m]) => typeof v === "number" && typeof m === "number" && v >= m,
      inline: (x, k) =>
        `(typeof ${x} === "number" && typeof ${k}[0] === "number" && ${x} >= ${k}[0])`,
    },
    (p) => p + "$property must not be less than $constraint1",
    options,
  );

export const Max = (maxValue: number, options?: ValidationOptions) =>
  validateBy(
    "max",
    [maxValue],
    {
      fn: (v, [m]) => typeof v === "number" && typeof m === "number" && v <= m,
      inline: (x, k) =>
        `(typeof ${x} === "number" && typeof ${k}[0] === "number" && ${x} <= ${k}[0])`,
    },
    (p) => p + "$property must not be greater than $constraint1",
    options,
  );

export const IsPositive = (options?: ValidationOptions) =>
  validateBy(
    "isPositive",
    [],
    {
      fn: (v) => typeof v === "number" && v > 0,
      inline: (x) => `(typeof ${x} === "number" && ${x} > 0)`,
    },
    (p) => p + "$property must be a positive number",
    options,
  );

export const IsNegative = (options?: ValidationOptions) =>
  validateBy(
    "isNegative",
    [],
    {
      fn: (v) => typeof v === "number" && v < 0,
      inline: (x) => `(typeof ${x} === "number" && ${x} < 0)`,
    },
    (p) => p + "$property must be a negative number",
    options,
  );

// ── Strings ─────────────────────────────────────────────────────────────────

/**
 * Length as the `validator` package's `isLength` counts it: a surrogate pair
 * or a character followed by a variation selector is one character.
 */
export function stringLength(str: string): number {
  // Both patterns need one of these code units; skip the regexes otherwise.
  if (!/[\uD800-\uDBFF︎️]/.test(str)) return str.length;
  const presentationSequences = str.match(/[^️︎][️︎]/g) || [];
  const surrogatePairs = str.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g) || [];
  return str.length - presentationSequences.length - surrogatePairs.length;
}

/** `validator`'s `isLength(str, { min, max })`. */
export function isLength(str: string, min: any, max: any): boolean {
  const len = stringLength(str);
  const lower = min || 0;
  return len >= lower && (typeof max === "undefined" || len <= max);
}

export const MinLength = (min: number, options?: ValidationOptions) =>
  validateBy(
    "minLength",
    [min],
    {
      fn: (v, [m]) => typeof v === "string" && isLength(v, m, undefined),
      inline: (x, k) =>
        `(typeof ${x} === "string" && H.isLength(${x}, ${k}[0], undefined))`,
    },
    (p) =>
      p + "$property must be longer than or equal to $constraint1 characters",
    options,
  );

export const MaxLength = (max: number, options?: ValidationOptions) =>
  validateBy(
    "maxLength",
    [max],
    {
      fn: (v, [m]) => typeof v === "string" && isLength(v, 0, m),
      inline: (x, k) =>
        `(typeof ${x} === "string" && H.isLength(${x}, 0, ${k}[0]))`,
    },
    (p) =>
      p + "$property must be shorter than or equal to $constraint1 characters",
    options,
  );

export const Length = (
  min: number,
  max?: number,
  options?: ValidationOptions,
) =>
  validateBy(
    "isLength",
    [min, max],
    {
      fn: (v, [lo, hi]) => typeof v === "string" && isLength(v, lo, hi),
      inline: (x, k) =>
        `(typeof ${x} === "string" && H.isLength(${x}, ${k}[0], ${k}[1]))`,
    },
    (p, args) => {
      const isMinLength =
        args?.constraints[0] !== null && args?.constraints[0] !== undefined;
      const isMaxLength =
        args?.constraints[1] !== null && args?.constraints[1] !== undefined;
      if (
        isMinLength &&
        (!args.value || args.value.length < args?.constraints[0])
      ) {
        return (
          p +
          "$property must be longer than or equal to $constraint1 characters"
        );
      } else if (isMaxLength && args.value.length > args?.constraints[1]) {
        return (
          p +
          "$property must be shorter than or equal to $constraint2 characters"
        );
      }
      return (
        p +
        "$property must be longer than or equal to $constraint1 and shorter than or equal to $constraint2 characters"
      );
    },
    options,
  );

/** `validator`'s `matches`. */
function matchesPattern(
  str: string,
  pattern: any,
  modifiers?: string,
): boolean {
  if (Object.prototype.toString.call(pattern) !== "[object RegExp]") {
    pattern = new RegExp(pattern, modifiers);
  }
  return !!str.match(pattern);
}

export function Matches(
  pattern: RegExp,
  options?: ValidationOptions,
): PropertyDecorator;
export function Matches(
  pattern: string | RegExp,
  modifiers?: string,
  options?: ValidationOptions,
): PropertyDecorator;
export function Matches(
  pattern: string | RegExp,
  modifiersOrOptions?: string | ValidationOptions,
  options?: ValidationOptions,
): PropertyDecorator {
  let modifiers: string | undefined;
  if (modifiersOrOptions && modifiersOrOptions instanceof Object && !options) {
    options = modifiersOrOptions;
  } else {
    modifiers = modifiersOrOptions as string | undefined;
  }
  return validateBy(
    "matches",
    [pattern, modifiers],
    {
      fn: (v, [pt, mod]) => typeof v === "string" && matchesPattern(v, pt, mod),
      // A string pattern is compiled once. A sticky one keeps per-call state,
      // so it is rebuilt each time, as `validator` does.
      prepare: ([pt, mod]) =>
        Object.prototype.toString.call(pt) === "[object RegExp]"
          ? pt
          : typeof mod === "string" && mod.includes("y")
            ? undefined
            : new RegExp(pt, mod),
      inline: (x, k, p) =>
        `(typeof ${x} === "string" && (${p} !== undefined ? !!${x}.match(${p}) : H.matches(${x}, ${k}[0], ${k}[1])))`,
    },
    (p) => p + "$property must match $constraint1 regular expression",
    options,
  );
}

export function IsEmail(emailOptions?: object, options?: ValidationOptions) {
  // Default options are checked by Megh itself; others by the `validator` package.
  const isEmail = usesDefaultEmailOptions(emailOptions)
    ? (value: string, _options?: unknown) => isEmailDefault(value)
    : rejectOnUriError(validatorLib("isEmail", "IsEmail"));
  return validateBy(
    "isEmail",
    [emailOptions],
    {
      fn: (v, [o]) => typeof v === "string" && isEmail(v, o),
      prepare: () => isEmail,
      inline: (x, k, p) => `(typeof ${x} === "string" && ${p}(${x}, ${k}[0]))`,
    },
    (p) => p + "$property must be an email",
    options,
  );
}

/** `validator` 13.15's UUID patterns, so `@IsUUID` needs no package. */
const UUID_PATTERNS: Record<string, RegExp> = {
  1: /^[0-9A-F]{8}-[0-9A-F]{4}-1[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
  2: /^[0-9A-F]{8}-[0-9A-F]{4}-2[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
  3: /^[0-9A-F]{8}-[0-9A-F]{4}-3[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
  4: /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
  5: /^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
  6: /^[0-9A-F]{8}-[0-9A-F]{4}-6[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
  7: /^[0-9A-F]{8}-[0-9A-F]{4}-7[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
  8: /^[0-9A-F]{8}-[0-9A-F]{4}-8[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
  nil: /^00000000-0000-0000-0000-000000000000$/i,
  max: /^ffffffff-ffff-ffff-ffff-ffffffffffff$/i,
  loose: /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i,
  all: /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i,
};

function isUUID(str: string, version?: any): boolean {
  const key =
    version === undefined || version === null ? "all" : String(version);
  return Object.prototype.hasOwnProperty.call(UUID_PATTERNS, key)
    ? UUID_PATTERNS[key].test(str)
    : false;
}

export function IsUUID(version?: any, options?: ValidationOptions) {
  return validateBy(
    "isUuid",
    [version],
    {
      fn: (v, [ver]) => typeof v === "string" && isUUID(v, ver),
      prepare: () => isUUID,
      inline: (x, k, p) => `(typeof ${x} === "string" && ${p}(${x}, ${k}[0]))`,
    },
    (p) => p + "$property must be a UUID",
    options,
  );
}

export function IsUrl(urlOptions?: object, options?: ValidationOptions) {
  const isURL = validatorLib("isURL", "IsUrl");
  return validateBy(
    "isUrl",
    [urlOptions],
    {
      fn: (v, [o]) => typeof v === "string" && isURL(v, o),
      prepare: () => isURL,
      inline: (x, k, p) => `(typeof ${x} === "string" && ${p}(${x}, ${k}[0]))`,
    },
    (p) => p + "$property must be a URL address",
    options,
  );
}

// ── Arrays ──────────────────────────────────────────────────────────────────

export const ArrayMinSize = (min: number, options?: ValidationOptions) =>
  validateBy(
    "arrayMinSize",
    [min],
    {
      fn: (v, [m]) => Array.isArray(v) && v.length >= m,
      inline: (x, k) => `(Array.isArray(${x}) && ${x}.length >= ${k}[0])`,
    },
    (p) => p + "$property must contain at least $constraint1 elements",
    options,
  );

export const ArrayMaxSize = (max: number, options?: ValidationOptions) =>
  validateBy(
    "arrayMaxSize",
    [max],
    {
      fn: (v, [m]) => Array.isArray(v) && v.length <= m,
      inline: (x, k) => `(Array.isArray(${x}) && ${x}.length <= ${k}[0])`,
    },
    (p) => p + "$property must contain no more than $constraint1 elements",
    options,
  );

export const ArrayNotEmpty = (options?: ValidationOptions) =>
  validateBy(
    "arrayNotEmpty",
    [],
    {
      fn: (v) => Array.isArray(v) && v.length > 0,
      inline: (x) => `(Array.isArray(${x}) && ${x}.length > 0)`,
    },
    (p) => p + "$property should not be empty",
    options,
  );

export function ArrayUnique(
  identifierOrOptions?: ((item: any) => any) | ValidationOptions,
  validationOptions?: ValidationOptions,
) {
  const identifier =
    typeof identifierOrOptions === "function" ? identifierOrOptions : undefined;
  const options =
    typeof identifierOrOptions !== "function"
      ? identifierOrOptions
      : validationOptions;
  return validateBy(
    "arrayUnique",
    [],
    {
      fn: (v) => {
        if (!Array.isArray(v)) return false;
        const list = identifier
          ? v.map((o) => (o != null ? identifier(o) : o))
          : v;
        // indexOf, not a Set, so NaN is handled as class-validator handles it.
        const unique = list.filter((a, b, c) => c.indexOf(a) === b);
        return list.length === unique.length;
      },
    },
    (p) => p + "All $property's elements must be unique",
    options,
  );
}

export const ArrayContains = (values: any[], options?: ValidationOptions) =>
  validateBy(
    "arrayContains",
    [values],
    {
      fn: (v, [list]) =>
        Array.isArray(v) && list.every((item: any) => v.indexOf(item) !== -1),
    },
    (p) => p + "$property must contain $constraint1 values",
    options,
  );

export const ArrayNotContains = (values: any[], options?: ValidationOptions) =>
  validateBy(
    "arrayNotContains",
    [values],
    {
      fn: (v, [list]) =>
        Array.isArray(v) && list.every((item: any) => v.indexOf(item) === -1),
    },
    (p) => p + "$property should not contain $constraint1 values",
    options,
  );

// ── Common (more) ───────────────────────────────────────────────────────────

export const Equals = (comparison: any, options?: ValidationOptions) =>
  validateBy(
    "equals",
    [comparison],
    { fn: (v, [c]) => v === c, inline: (x, k) => `(${x} === ${k}[0])` },
    (p) => p + "$property must be equal to $constraint1",
    options,
  );

export const NotEquals = (comparison: any, options?: ValidationOptions) =>
  validateBy(
    "notEquals",
    [comparison],
    { fn: (v, [c]) => v !== c, inline: (x, k) => `(${x} !== ${k}[0])` },
    (p) => p + "$property should not be equal to $constraint1",
    options,
  );

// ── Objects ─────────────────────────────────────────────────────────────────

function isObjectValue(v: any): boolean {
  return (
    v != null &&
    (typeof v === "object" || typeof v === "function") &&
    !Array.isArray(v)
  );
}

export const IsNotEmptyObject = (
  objectOptions?: { nullable?: boolean },
  options?: ValidationOptions,
) =>
  validateBy(
    "isNotEmptyObject",
    [objectOptions],
    {
      fn: (v, [o]) => {
        if (!isObjectValue(v)) return false;
        if (o?.nullable === false) {
          return !Object.values(v).every((x) => x === null || x === undefined);
        }
        for (const key in v) {
          if (Object.prototype.hasOwnProperty.call(v, key)) return true;
        }
        return false;
      },
    },
    (p) => p + "$property must be a non-empty object",
    options,
  );

export const IsInstance = (targetType: Function, options?: ValidationOptions) =>
  validateBy(
    "isInstance",
    [targetType],
    {
      fn: (v, [t]) => !!t && typeof t === "function" && v instanceof t,
    },
    (p, args) =>
      args?.constraints[0]
        ? p + `$property must be an instance of ${args.constraints[0].name}`
        : p +
          "isInstance decorator expects and object as value, but got falsy value.",
    options,
  );

// ── Dates ───────────────────────────────────────────────────────────────────

const dateOf = (d: Date | (() => Date)) => (d instanceof Date ? d : d());

export const MinDate = (
  date: Date | (() => Date),
  options?: ValidationOptions,
) =>
  validateBy(
    "minDate",
    [date],
    {
      fn: (v, [d]) => v instanceof Date && v.getTime() >= dateOf(d).getTime(),
    },
    (p) => "minimal allowed date for " + p + "$property is $constraint1",
    options,
  );

export const MaxDate = (
  date: Date | (() => Date),
  options?: ValidationOptions,
) =>
  validateBy(
    "maxDate",
    [date],
    {
      fn: (v, [d]) => v instanceof Date && v.getTime() <= dateOf(d).getTime(),
    },
    (p) => "maximal allowed date for " + p + "$property is $constraint1",
    options,
  );

// ── Numbers (more) ──────────────────────────────────────────────────────────

export function IsDivisibleBy(num: number, options?: ValidationOptions) {
  const isDivisibleBy = validatorLib("isDivisibleBy", "IsDivisibleBy");
  return validateBy(
    "isDivisibleBy",
    [num],
    {
      fn: (v, [n]) =>
        typeof v === "number" &&
        typeof n === "number" &&
        isDivisibleBy(String(v), n),
    },
    (p) => p + "$property must be divisible by $constraint1",
    options,
  );
}

// ── Strings checked by the `validator` package ─────────────────────────────

/**
 * A string check from the `validator` package, as class-validator wraps it:
 * non-strings fail, the constraints are passed after the value.
 */
function stringCheck(
  name: string,
  fnName: string,
  decorator: string,
  constraints: any[],
  text: string,
  options?: ValidationOptions,
): PropertyDecorator {
  const lib = validatorLib(fnName, decorator);
  return validateBy(
    name,
    constraints,
    { fn: (v, k) => typeof v === "string" && lib(v, ...k) },
    (p) => p + text,
    options,
  );
}

export const IsNumberString = (
  numericOptions?: object,
  options?: ValidationOptions,
) =>
  stringCheck(
    "isNumberString",
    "isNumeric",
    "IsNumberString",
    [numericOptions],
    "$property must be a number string",
    options,
  );

export const IsBooleanString = (options?: ValidationOptions) =>
  stringCheck(
    "isBooleanString",
    "isBoolean",
    "IsBooleanString",
    [],
    "$property must be a boolean string",
    options,
  );

export const IsISO8601 = (isoOptions?: object, options?: ValidationOptions) =>
  stringCheck(
    "isIso8601",
    "isISO8601",
    "IsISO8601",
    [isoOptions],
    "$property must be a valid ISO 8601 date string",
    options,
  );

export const IsDateString = (
  isoOptions?: object,
  options?: ValidationOptions,
) =>
  stringCheck(
    "isDateString",
    "isISO8601",
    "IsDateString",
    [isoOptions],
    "$property must be a valid ISO 8601 date string",
    options,
  );

export const IsAlpha = (locale?: string, options?: ValidationOptions) =>
  stringCheck(
    "isAlpha",
    "isAlpha",
    "IsAlpha",
    [locale],
    "$property must contain only letters (a-zA-Z)",
    options,
  );

export const IsAlphanumeric = (locale?: string, options?: ValidationOptions) =>
  stringCheck(
    "isAlphanumeric",
    "isAlphanumeric",
    "IsAlphanumeric",
    [locale],
    "$property must contain only letters and numbers",
    options,
  );

export const IsAscii = (options?: ValidationOptions) =>
  stringCheck(
    "isAscii",
    "isAscii",
    "IsAscii",
    [],
    "$property must contain only ASCII characters",
    options,
  );

export const IsLowercase = (options?: ValidationOptions) =>
  stringCheck(
    "isLowercase",
    "isLowercase",
    "IsLowercase",
    [],
    "$property must be a lowercase string",
    options,
  );

export const IsUppercase = (options?: ValidationOptions) =>
  stringCheck(
    "isUppercase",
    "isUppercase",
    "IsUppercase",
    [],
    "$property must be uppercase",
    options,
  );

export const Contains = (seed: string, options?: ValidationOptions) =>
  stringCheck(
    "contains",
    "contains",
    "Contains",
    [seed],
    "$property must contain a $constraint1 string",
    options,
  );

export function NotContains(seed: string, options?: ValidationOptions) {
  const contains = validatorLib("contains", "NotContains");
  return validateBy(
    "notContains",
    [seed],
    { fn: (v, [s]) => typeof v === "string" && !contains(v, s) },
    (p) => p + "$property should not contain a $constraint1 string",
    options,
  );
}

export const IsJSON = (options?: ValidationOptions) =>
  stringCheck(
    "isJson",
    "isJSON",
    "IsJSON",
    [],
    "$property must be a json string",
    options,
  );

export const IsJWT = (options?: ValidationOptions) =>
  stringCheck(
    "isJwt",
    "isJWT",
    "IsJWT",
    [],
    "$property must be a jwt string",
    options,
  );

export const IsHexColor = (options?: ValidationOptions) =>
  stringCheck(
    "isHexColor",
    "isHexColor",
    "IsHexColor",
    [],
    "$property must be a hexadecimal color",
    options,
  );

export const IsHexadecimal = (options?: ValidationOptions) =>
  stringCheck(
    "isHexadecimal",
    "isHexadecimal",
    "IsHexadecimal",
    [],
    "$property must be a hexadecimal number",
    options,
  );

export const IsMongoId = (options?: ValidationOptions) =>
  stringCheck(
    "isMongoId",
    "isMongoId",
    "IsMongoId",
    [],
    "$property must be a mongodb id",
    options,
  );

export function IsIP(version?: 4 | 6 | "4" | "6", options?: ValidationOptions) {
  const isIP = validatorLib("isIP", "IsIP");
  return validateBy(
    "isIp",
    [version],
    {
      fn: (v, [ver]) =>
        typeof v === "string" && isIP(v, ver ? `${ver}` : undefined),
    },
    (p) => p + "$property must be an ip address",
    options,
  );
}

export const IsBase64 = (base64Options?: object, options?: ValidationOptions) =>
  stringCheck(
    "isBase64",
    "isBase64",
    "IsBase64",
    [base64Options],
    "$property must be base64 encoded",
    options,
  );

export const IsCreditCard = (options?: ValidationOptions) =>
  stringCheck(
    "isCreditCard",
    "isCreditCard",
    "IsCreditCard",
    [],
    "$property must be a credit card",
    options,
  );

export const IsCurrency = (
  currencyOptions?: object,
  options?: ValidationOptions,
) =>
  stringCheck(
    "isCurrency",
    "isCurrency",
    "IsCurrency",
    [currencyOptions],
    "$property must be a currency",
    options,
  );

export const IsDecimal = (
  decimalOptions?: object,
  options?: ValidationOptions,
) =>
  stringCheck(
    "isDecimal",
    "isDecimal",
    "IsDecimal",
    [decimalOptions],
    "$property is not a valid decimal number.",
    options,
  );

export const IsFQDN = (fqdnOptions?: object, options?: ValidationOptions) =>
  stringCheck(
    "isFqdn",
    "isFQDN",
    "IsFQDN",
    [fqdnOptions],
    "$property must be a valid domain name",
    options,
  );

export const IsLatLong = (options?: ValidationOptions) =>
  stringCheck(
    "isLatLong",
    "isLatLong",
    "IsLatLong",
    [],
    "$property must be a latitude,longitude string",
    options,
  );

export const IsPostalCode = (locale: string, options?: ValidationOptions) =>
  stringCheck(
    "isPostalCode",
    "isPostalCode",
    "IsPostalCode",
    [locale],
    "$property must be a postal code",
    options,
  );

export const IsSemVer = (options?: ValidationOptions) =>
  stringCheck(
    "isSemVer",
    "isSemVer",
    "IsSemVer",
    [],
    "$property must be a Semantic Versioning Specification",
    options,
  );

export const IsMobilePhone = (
  locale?: string | string[],
  phoneOptions?: object,
  options?: ValidationOptions,
) =>
  stringCheck(
    "isMobilePhone",
    "isMobilePhone",
    "IsMobilePhone",
    [locale, phoneOptions],
    "$property must be a phone number",
    options,
  );

export const IsStrongPassword = (
  passwordOptions?: object,
  options?: ValidationOptions,
) =>
  stringCheck(
    "isStrongPassword",
    "isStrongPassword",
    "IsStrongPassword",
    [passwordOptions],
    "$property is not strong enough",
    options,
  );

// ── Strings checked without a package ───────────────────────────────────────

export const IsTimeZone = (options?: ValidationOptions) =>
  validateBy(
    "isTimeZone",
    [],
    {
      fn: (v) => {
        if (typeof v !== "string") return false;
        try {
          Intl.DateTimeFormat(undefined, { timeZone: v });
          return true;
        } catch {
          return false;
        }
      },
    },
    (p) => p + "$property must be a valid IANA time-zone",
    options,
  );

/**
 * A valid phone number, optionally in `region` (`"BD"`, `"US"`). Uses the
 * `libphonenumber-js` package, as class-validator does; install it to use it.
 */
export function IsPhoneNumber(region?: string, options?: ValidationOptions) {
  let parsePhoneNumber: (value: string, region?: string) => any;
  try {
    parsePhoneNumber = require("libphonenumber-js/max").parsePhoneNumber;
  } catch {
    throw new Error(
      "[Megh] @IsPhoneNumber() uses the \"libphonenumber-js\" package. Install it: npm install libphonenumber-js",
    );
  }
  return validateBy(
    "isPhoneNumber",
    [region],
    {
      fn: (v, [r]) => {
        if (typeof v !== "string" || v.trim() !== v) return false;
        try {
          const phoneNumber = parsePhoneNumber(v, r);
          if (r && phoneNumber.country !== r) return false;
          return phoneNumber.isValid();
        } catch {
          return false;
        }
      },
    },
    (p) => p + "$property must be a valid phone number",
    options,
  );
}

/** Helpers the compiled code calls (`H.*`). */
export const checkHelpers = { isNumber, isLength, matches: matchesPattern };
