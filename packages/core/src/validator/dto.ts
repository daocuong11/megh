/**
 * Internal helpers for working with DTO classes whichever library their
 * decorators come from: Megh's own, or class-validator / class-transformer.
 */
import { getValidationRules, isMeghValidatorClass } from "./metadata";
import { validateDto } from "./compiler";
import {
  getRegisteredSchemaProperties,
  getTransformerProperties,
} from "../openapi/schema-properties";
import { REQUEST_VALIDATION_OPTIONS } from "../common/utils/validation-utils";

export type DtoIssue = { path: string; constraints: Record<string, string> };

/** class-validator, when installed. */
export function classValidator(): any {
  try {
    return require("class-validator");
  } catch {
    return undefined;
  }
}

/** The class's class-validator rules, own and inherited. */
export function classValidatorRules(target: Function): any[] {
  const cv = classValidator();
  if (!cv) return [];
  return cv
    .getMetadataStorage()
    .getTargetValidationMetadatas(target, undefined, true, false);
}

/** Every property name the class's decorators (of any library) declare. */
export function dtoProperties(target: Function): string[] {
  const names = new Set<string>();
  for (const meta of classValidatorRules(target)) {
    if (meta.propertyName) names.add(meta.propertyName);
  }
  for (const rule of getValidationRules(target)) names.add(rule.propertyName);
  for (const key of getTransformerProperties(target)) names.add(key);
  for (const key of getRegisteredSchemaProperties(target)) names.add(key);
  return [...names];
}

/**
 * Validate `plain` against the DTO `target` synchronously, with Megh's
 * validator or class-validator, whichever the DTO uses. Returns the
 * transformed instance and the failing properties (`null` when valid).
 */
export function validateDtoSync<T extends object>(
  target: new () => T,
  plain: Record<string, unknown>,
): { value: T; errors: DtoIssue[] | null } {
  if (isMeghValidatorClass(target)) {
    const { value, errors } = validateDto(target, plain);
    return { value, errors: errors && errors.length ? errors : null };
  }
  const cv = classValidator();
  let transformer: any;
  try {
    transformer = require("class-transformer");
  } catch {
    transformer = undefined;
  }
  if (!cv || !transformer) {
    throw new Error(
      `[Megh] ${target.name} uses class-validator decorators, but class-validator or class-transformer isn't installed.`,
    );
  }
  const instance = transformer.plainToInstance(target, plain) as T;
  const errors = cv.validateSync(instance, REQUEST_VALIDATION_OPTIONS);
  return { value: instance, errors: errors.length ? flatten(errors) : null };
}

function flatten(errors: any[], parent = "", out: DtoIssue[] = []): DtoIssue[] {
  for (const err of errors) {
    const path = parent ? `${parent}.${err.property}` : String(err.property);
    if (err.constraints && Object.keys(err.constraints).length > 0) {
      out.push({ path, constraints: err.constraints });
    }
    if (err.children?.length) flatten(err.children, path, out);
  }
  return out;
}

/** "path: message; path: message" for an error message. */
export function describeIssues(issues: DtoIssue[]): string {
  return issues
    .map(
      (i) =>
        `${i.path || "(value)"}: ${Object.values(i.constraints).join(", ")}`,
    )
    .join("\n  ");
}
