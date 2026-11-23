/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 *
 * Guards for DTOs that mix Megh's decorators with class-validator's or
 * class-transformer's. Each library only sees its own rules, so a mixed DTO
 * would silently skip some of them.
 */
import { isMeghValidatorClass } from "./metadata";
import { classValidatorRules, usesClassTransformer } from "./optional-libs";

/**
 * Throw when `target` uses Megh decorators together with class-validator or
 * class-transformer ones.
 */
export function assertMeghOnly(target: Function) {
  if (!isMeghValidatorClass(target)) return;
  const other =
    classValidatorRules(target).length > 0
      ? "class-validator"
      : usesClassTransformer(target)
        ? "class-transformer"
        : undefined;
  if (other) {
    throw new Error(
      `[Megh] ${target.name} mixes @meghjs/core validation decorators with ${other} ones. ` +
        "Import every decorator of this DTO from one place (e.g. IsString, Type and Transform from \"@meghjs/core\").",
    );
  }
}
