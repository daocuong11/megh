/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 */
export class SystemUseError extends Error {
  constructor(message: string) {
    super(message);
  }
}
/** Thrown by `Environment.getOrThrow()` when the variable is not set. */
export class EnvironmentVariableNotFound extends Error {
  /** The variable that was not found. */
  readonly key: string;

  constructor(key: string) {
    super(`${key} not found in environment variables.`);
    this.name = "EnvironmentVariableNotFound";
    this.key = key;
  }
}
