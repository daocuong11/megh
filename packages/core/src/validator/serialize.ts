/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 *
 * Internal: convert with whichever library a class's decorators come from.
 * Classes decorated only with class-transformer keep using it; everything
 * else (Megh decorators, or none) uses Megh's own conversion.
 */
import { hasTransformRules } from "./metadata";
import {
  ClassTransformOptions,
  instanceToPlain,
  plainToInstance,
} from "./transform";
import { classTransformer, usesClassTransformer } from "./optional-libs";

function library(cls: Function): {
  plainToInstance: (cls: any, plain: any, options?: any) => any;
  instanceToPlain: (object: any, options?: any) => any;
} {
  if (usesClassTransformer(cls) && !hasTransformRules(cls)) {
    return classTransformer();
  }
  return { plainToInstance, instanceToPlain };
}

/** `plainToInstance(cls, plain)` with the class's own library. */
export function toInstanceOf<T>(
  cls: new (...args: any[]) => T,
  plain: unknown,
  options?: ClassTransformOptions,
): any {
  return library(cls).plainToInstance(cls, plain, options);
}

/**
 * `instanceToPlain(plainToInstance(cls, data))` with the class's own library:
 * shape `data` (an object or an array) as the class `cls` describes it.
 */
export function shapeAs<T>(
  cls: new (...args: any[]) => T,
  data: unknown,
  toClassOptions?: ClassTransformOptions,
  toPlainOptions?: ClassTransformOptions,
): any {
  const lib = library(cls);
  return lib.instanceToPlain(
    lib.plainToInstance(cls, data, toClassOptions),
    toPlainOptions,
  );
}
