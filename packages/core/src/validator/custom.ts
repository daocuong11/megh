/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 *
 * Custom validators with class-validator's API: `@ValidatorConstraint` +
 * `@Validate`, `registerDecorator` and `ValidateBy`. Constraint keys and
 * messages follow class-validator's rules, and a validator may return a
 * promise (async validation).
 */
import {
  addValidationRule,
  ValidationArguments,
  ValidationOptions,
} from "./metadata";

/** class-validator's `ValidatorConstraintInterface`. */
export interface ValidatorConstraintInterface {
  validate(
    value: any,
    validationArguments?: ValidationArguments,
  ): Promise<boolean> | boolean;
  defaultMessage?(validationArguments?: ValidationArguments): string;
}

/** A class implementing `ValidatorConstraintInterface`. */
export type ValidatorConstraintClass = new (
  ...args: any[]
) => ValidatorConstraintInterface;

/** class-validator's `ValidationDecoratorOptions` (for `registerDecorator`). */
export type ValidationDecoratorOptions = {
  target: Function;
  propertyName: string;
  /** The constraint key in errors. */
  name?: string;
  async?: boolean;
  options?: ValidationOptions;
  constraints?: any[];
  validator: ValidatorConstraintInterface | ValidatorConstraintClass;
};

/** class-validator's `ValidateByOptions`. */
export type ValidateByOptions = {
  name: string;
  constraints?: any[];
  validator: ValidatorConstraintInterface | ValidatorConstraintClass;
  async?: boolean;
};

type Constraint = { name: string; async: boolean; instance?: any };

const constraints = new WeakMap<Function, Constraint>();

/** Instances are created on first use and shared, as class-validator's container does. */
function instanceOf(cls: Function, constraint: Constraint) {
  if (!constraint.instance) constraint.instance = new (cls as any)();
  return constraint.instance;
}

/**
 * Mark a class as a custom validator. Without a `name`, the constraint key in
 * errors is the class name.
 */
export function ValidatorConstraint(options?: {
  name?: string;
  async?: boolean;
}): ClassDecorator {
  return (target) => {
    let name = options && options.name ? options.name : "";
    if (!name) name = target.name;
    constraints.set(target, { name, async: !!(options && options.async) });
  };
}

function addCustomRule(
  target: Function,
  propertyName: string,
  cls: Function,
  constraint: Constraint,
  ruleConstraints: any[] | undefined,
  options: ValidationOptions | undefined,
) {
  addValidationRule({
    kind: "customValidation",
    name: constraint.name,
    target,
    propertyName,
    constraints: ruleConstraints as any,
    each: !!options?.each,
    message: options?.message,
    custom: true,
    async: constraint.async,
    // A custom constraint's message comes from its `defaultMessage`, with no
    // "each value in " prefix, as in class-validator.
    defaultMessage: (_eachPrefix, args) => {
      const instance = instanceOf(cls, constraint);
      return instance.defaultMessage instanceof Function
        ? instance.defaultMessage(args)
        : "";
    },
    check: {
      fn: (value, ruleConstraintList, _prepared, object?: any, whole?: any) =>
        instanceOf(cls, constraint).validate(value, {
          targetName: object?.constructor ? object.constructor.name : undefined,
          property: propertyName,
          object,
          // With `each`, class-validator passes the whole value here.
          value: whole !== undefined ? whole : value,
          constraints: ruleConstraintList,
        }),
    },
  });
}

/** Constraint metadata for `cls`, or an error naming the missing decorator. */
function constraintOf(cls: Function): Constraint {
  const found = constraints.get(cls);
  if (found) return found;
  // class-validator falls back to an unnamed constraint; Megh keys it by class name.
  const fallback = { name: cls.name, async: false };
  constraints.set(cls, fallback);
  return fallback;
}

/** Check a property with a `@ValidatorConstraint` class. */
export function Validate(
  constraintClass: Function,
  validationOptions?: ValidationOptions,
): PropertyDecorator;
export function Validate(
  constraintClass: Function,
  constraints?: any[],
  validationOptions?: ValidationOptions,
): PropertyDecorator;
export function Validate(
  constraintClass: Function,
  constraintsOrValidationOptions?: any[] | ValidationOptions,
  maybeValidationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object, propertyName) => {
    const ruleConstraints = Array.isArray(constraintsOrValidationOptions)
      ? constraintsOrValidationOptions
      : undefined;
    const options = !Array.isArray(constraintsOrValidationOptions)
      ? constraintsOrValidationOptions
      : maybeValidationOptions;
    addCustomRule(
      object.constructor,
      String(propertyName),
      constraintClass,
      constraintOf(constraintClass),
      ruleConstraints,
      options,
    );
  };
}

/** Register a custom validation decorator, as class-validator's `registerDecorator`. */
export function registerDecorator(options: ValidationDecoratorOptions): void {
  let cls: Function;
  let constraint: Constraint;
  if (options.validator instanceof Function) {
    cls = options.validator;
    constraint = constraintOf(cls);
  } else {
    const validator = options.validator as ValidatorConstraintInterface;
    cls = class CustomConstraint {
      validate(value: any, args: ValidationArguments) {
        return validator.validate(value, args);
      }
      defaultMessage(args: ValidationArguments) {
        return validator.defaultMessage ? validator.defaultMessage(args) : "";
      }
    };
    constraint = {
      name: options.name || "customValidation",
      async: !!options.async,
    };
    constraints.set(cls, constraint);
  }
  addCustomRule(
    options.target,
    options.propertyName,
    cls,
    constraint,
    options.constraints,
    options.options,
  );
}

/** class-validator's `ValidateBy`: build a property decorator from a validator. */
export function ValidateBy(
  options: ValidateByOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      name: options.name,
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      constraints: options.constraints,
      validator: options.validator,
      async: options.async,
    });
  };
}

/** class-validator's `buildMessage`, for `ValidateBy` validators. */
export function buildMessage(
  impl: (eachPrefix: string, args?: ValidationArguments) => string,
  validationOptions?: ValidationOptions,
): (validationArguments?: ValidationArguments) => string {
  return (validationArguments?: ValidationArguments) => {
    const eachPrefix =
      validationOptions && validationOptions.each ? "each value in " : "";
    return impl(eachPrefix, validationArguments);
  };
}
