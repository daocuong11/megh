import { Environment } from "./environment-variables";
import { Constructor } from "../common/helpers";
import { Container, Injectable, inject } from "../di";
import { envGeneration } from "./env-generation";
import {
  describeIssues,
  dtoProperties,
  validateDtoSync,
  type DtoIssue,
} from "../validator/dto";

// The abstract base
export abstract class MeghConfig<T = any> {
  abstract config(env: Environment): T;
}

// Constructor type that TypeScript recognizes for subclasses
export type MeghConfigClass<T = any> = Function & {
  prototype: MeghConfig<T>;
};

/** Options for `@AppConfig({ ... })`. */
export type AppConfigOptions = {
  /**
   * A DTO class (Megh or class-validator decorators) the object returned by
   * `config()` must satisfy. Checked on the first `GetConfig()` and when the
   * app starts, so a bad setting fails at boot. Only the properties the DTO
   * declares are checked; others are left alone.
   */
  schema?: Constructor<object>;
};

/** Thrown when the environment or a config object doesn't match its schema. */
export class ConfigValidationError extends Error {
  constructor(
    /** What was validated: `environment` or the config class name. */
    readonly source: string,
    /** Each failing property and its messages. */
    readonly issues: DtoIssue[],
  ) {
    super(`[Megh] Invalid ${source}:\n  ${describeIssues(issues)}`);
    this.name = "ConfigValidationError";
  }
}

/**
 * config() results by config instance. Keyed by instance, so a container
 * reset (new instance) starts fresh, and tagged with the environment
 * generation, so Environment.reload() makes the next GetConfig rebuild.
 */
const configCache = new WeakMap<
  object,
  { generation: number; value: unknown }
>();

const CONFIG_SCHEMA_KEY = Symbol.for("megh:config:schema");

/** Config classes declared with a schema, validated when the app starts. */
const schemaConfigs = new Set<Constructor<MeghConfig>>();

/**
 * Register a config class with dependency injection. Use it bare, or with
 * options to validate what `config()` returns:
 *
 *   @AppConfig
 *   class MailConfig extends MeghConfig<MailSettings> { ... }
 *
 *   @AppConfig({ schema: MailSettingsDto })
 *   class MailConfig extends MeghConfig<MailSettings> { ... }
 */
export function AppConfig<T extends MeghConfig>(
  target: Constructor<T>,
): Constructor<T>;
export function AppConfig(
  options: AppConfigOptions,
): <T extends MeghConfig>(target: Constructor<T>) => Constructor<T>;
export function AppConfig(arg: any): any {
  if (typeof arg === "function") return registerConfig(arg, {});
  const options: AppConfigOptions = arg ?? {};
  return (target: Constructor<MeghConfig>) => registerConfig(target, options);
}

function registerConfig<T extends MeghConfig>(
  target: Constructor<T>,
  options: AppConfigOptions,
): Constructor<T> {
  Injectable()(target);
  if (options.schema) {
    Reflect.defineMetadata(CONFIG_SCHEMA_KEY, options.schema, target);
    schemaConfigs.add(target);
  }
  return target;
}

export function GetConfig<T extends MeghConfig<R>, R>(
  ConfigClass: Constructor<T>,
): R;
export function GetConfig<T = any>(token: string | symbol): T;
export function GetConfig<R>(token: any): R {
  if (
    typeof token === "function" &&
    token.prototype != null &&
    typeof token.prototype.config === "function"
  ) {
    let instance: MeghConfig<R>;
    // Only the lookup is guarded: an error thrown inside config() (for
    // example from getOrThrow) must reach the caller as it is.
    try {
      instance = Container.get<MeghConfig<R>>(
        token as Constructor<MeghConfig<R>>,
      );
    } catch {
      throw new Error(
        `Config class "${(token as Constructor<unknown>).name}" is not registered. ` +
          "Did you forget to apply the @AppConfig decorator?",
      );
    }
    const cached = configCache.get(instance);
    if (cached && cached.generation === envGeneration()) {
      return cached.value as R;
    }
    const value = instance.config(inject(Environment));
    const schema = Reflect.getMetadata(CONFIG_SCHEMA_KEY, token);
    if (schema) assertMatches(schema, value, token.name);
    configCache.set(instance, { generation: envGeneration(), value });
    return value;
  }
  try {
    return Container.get<R>(token);
  } catch {
    throw new Error(
      `Config token "${String(token)}" is not registered in the container.`,
    );
  }
}

/** Throw a ConfigValidationError when `value` doesn't match `schema`. */
function assertMatches(
  schema: Constructor<object>,
  value: unknown,
  source: string,
) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigValidationError(source, [
      { path: "", constraints: { isObject: "config() must return an object" } },
    ]);
  }
  const picked: Record<string, unknown> = {};
  for (const key of dtoProperties(schema)) {
    if (key in (value as object)) picked[key] = (value as any)[key];
  }
  const { errors } = validateDtoSync(schema as new () => object, picked);
  if (errors) throw new ConfigValidationError(source, errors);
}

/**
 * Build every config class declared with `@AppConfig({ schema })`, so an
 * invalid one fails when the app starts rather than on first use.
 * @internal Called by `app.run()`.
 */
export function validateConfigSchemas(): void {
  for (const ConfigClass of schemaConfigs) GetConfig(ConfigClass);
}

/**
 * Validate environment variables against a DTO class and return them
 * converted: properties typed `number` or `boolean` are converted from the
 * string first (`"4000"` → `4000`, `"true"`/`"1"` → `true`). Only the
 * properties the DTO declares are read. Throws a ConfigValidationError that
 * lists every invalid variable.
 *
 *   class Env {
 *     @IsInt() @Min(1) PORT: number;
 *     @IsUrl() DATABASE_URL: string;
 *   }
 *   const env = validateEnv(Env);
 */
export function validateEnv<T extends object>(
  schema: Constructor<T>,
  source: Record<string, string | undefined> = inject(Environment).getAll(),
): T {
  const plain: Record<string, unknown> = {};
  for (const key of dtoProperties(schema)) {
    const raw = source[key];
    if (raw === undefined) continue;
    plain[key] = convertEnvValue(
      Reflect.getMetadata("design:type", schema.prototype, key),
      raw,
    );
  }
  const { value, errors } = validateDtoSync(schema as new () => T, plain);
  if (errors) throw new ConfigValidationError("environment", errors);
  return value;
}

function convertEnvValue(type: unknown, raw: string): unknown {
  const text = raw.trim();
  if (type === Number && text !== "" && !Number.isNaN(Number(text))) {
    return Number(text);
  }
  if (type === Boolean) {
    if (/^(true|1|yes|on)$/i.test(text)) return true;
    if (/^(false|0|no|off)$/i.test(text)) return false;
  }
  return raw;
}
