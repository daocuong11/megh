import { Environment } from "./environment-variables";
import { Constructor } from "../common/helpers";
import { Container, Injectable, inject } from "../di";
import { envGeneration } from "./env-generation";
// The abstract base
export abstract class MeghConfig<T = any> {
  abstract config(env: Environment): T;
}

// Constructor type that TypeScript recognizes for subclasses
export type MeghConfigClass<T = any> = Function & {
  prototype: MeghConfig<T>;
};

/**
 * config() results by config instance. Keyed by instance, so a container
 * reset (new instance) starts fresh, and tagged with the environment
 * generation, so Environment.reload() makes the next GetConfig rebuild.
 */
const configCache = new WeakMap<
  object,
  { generation: number; value: unknown }
>();

// Decorator — registers in DI
export function AppConfig<T extends MeghConfig>(
  target: Constructor<T>,
): Constructor<T> {
  Injectable()(target);
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
