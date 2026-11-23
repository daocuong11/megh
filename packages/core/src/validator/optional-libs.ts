/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 *
 * class-validator and class-transformer are optional. Megh only loads them
 * for DTOs written with their decorators, and works without them installed.
 */

let cv: any;
let ct: any;

/** class-validator, or `undefined` when it isn't installed. */
export function classValidator(): any {
  if (cv === undefined) {
    try {
      cv = require("class-validator");
    } catch {
      cv = null;
    }
  }
  return cv ?? undefined;
}

/** class-transformer, or `undefined` when it isn't installed. */
export function classTransformer(): any {
  if (ct === undefined) {
    try {
      ct = require("class-transformer");
    } catch {
      ct = null;
    }
  }
  return ct ?? undefined;
}

/** The class's class-validator rules, own and inherited (`[]` without class-validator). */
export function classValidatorRules(target: Function): any[] {
  const lib = classValidator();
  if (!lib || typeof target !== "function") return [];
  return (
    lib
      .getMetadataStorage()
      .getTargetValidationMetadatas(target, undefined, true, false) ?? []
  );
}

/** Does `target` (or an ancestor) carry class-transformer metadata, class-level included? */
export function usesClassTransformer(target: Function): boolean {
  if (typeof target !== "function" || !classTransformer()) return false;
  let storage: any;
  try {
    storage = require("class-transformer/cjs/storage").defaultMetadataStorage;
  } catch {
    return false;
  }
  const maps = [
    storage._typeMetadatas,
    storage._exposeMetadatas,
    storage._excludeMetadatas,
    storage._transformMetadatas,
  ];
  for (
    let cls: any = target;
    typeof cls === "function" && cls !== Function.prototype;
    cls = Object.getPrototypeOf(cls)
  ) {
    if (maps.some((map) => map instanceof Map && map.has(cls))) return true;
  }
  return false;
}

/** Explain which package a class-validator / class-transformer DTO needs. */
export function missingLibraryError(target: Function, pkg: string): Error {
  return new Error(
    `[Megh] ${target.name} uses ${pkg} decorators, but ${pkg} isn't installed. ` +
      `Install it (npm install ${pkg}), or import the decorators from "@meghjs/core" instead.`,
  );
}
