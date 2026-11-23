/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 *
 * Megh's own DTO validation and transformation: class-validator and
 * class-transformer decorator names, compiled once per class.
 */
export * from "./decorators";
export {
  Type,
  Transform,
  Expose,
  Exclude,
  plainToInstance,
  instanceToPlain,
} from "./transform";
export type { TypeOptions, ClassTransformOptions } from "./transform";
export {
  Validate,
  ValidatorConstraint,
  registerDecorator,
  ValidateBy,
  buildMessage,
} from "./custom";
export type {
  ValidatorConstraintInterface,
  ValidationDecoratorOptions,
  ValidateByOptions,
} from "./custom";
export { validateDto, validateDtoAsync } from "./compiler";
export type { ValidationIssue, DtoValidationResult } from "./compiler";
export { isMeghValidatorClass, TransformationType } from "./metadata";
export type {
  ValidationArguments,
  ValidationOptions,
  TransformFnParams,
  TransformOptions as TransformDecoratorOptions,
  TypeHelpOptions,
  ExposeOptions,
  ExcludeOptions,
  Discriminator,
} from "./metadata";
