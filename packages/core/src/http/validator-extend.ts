/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 */
import { registerDecorator } from "../validator/custom";
import type { ValidationOptions } from "../validator/metadata";

/**
 * The value must be an array with at least one item. Same check as
 * `ArrayNotEmpty`, with its own constraint key and message.
 */
export function IsArrayNotEmpty(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      name: "isArrayWithAtLeastOneElement",
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          return Array.isArray(value) && value.length > 0;
        },
        defaultMessage(args: any) {
          return `${args.property} must contain at least one item.`;
        },
      },
    });
  };
}
