/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 *
 * API versioning: `app.useVersioning()` and `@Version()`.
 */

export const VERSION_META_KEY = Symbol.for("megh:version");

/** Options for `app.useVersioning()`. */
export type VersioningOptions =
  | {
      /** The version is a path segment: `/v1/users`. */
      type: "uri";
      /** Text before the version in the path. Defaults to `"v"`. */
      prefix?: string;
      /** Version for controllers and routes without `@Version()`. */
      defaultVersion?: string | string[];
    }
  | {
      /** The version comes from a request header: `X-API-Version: 1`. */
      type: "header";
      /** The header to read. Defaults to `"x-api-version"`. */
      header?: string;
      /**
       * Version for controllers and routes without `@Version()`, and for
       * requests that send no version header.
       */
      defaultVersion?: string | string[];
    };

/**
 * The API version(s) a controller or route serves, once `app.useVersioning()`
 * is on. On a method it overrides the controller's version.
 *
 *   @Version("2")
 *   @ApiController("/users")
 *   class UsersV2Controller { ... }   // GET /v2/users
 *
 *   @Get("/")
 *   @Version(["1", "2"])
 *   list() { ... }                    // GET /v1/... and /v2/...
 */
export function Version(version: string | string[]) {
  const versions = normalizeVersions(version);
  return function (target: object, propertyKey?: string | symbol): void {
    if (propertyKey === undefined) {
      Reflect.defineMetadata(VERSION_META_KEY, versions, target);
    } else {
      Reflect.defineMetadata(VERSION_META_KEY, versions, target, propertyKey);
    }
  } as ClassDecorator & MethodDecorator;
}

/** `"1"` or `["1", "2"]` as a non-empty list of trimmed strings. */
export function normalizeVersions(version: unknown): string[] {
  const list = (Array.isArray(version) ? version : [version]).map((v) =>
    String(v ?? "").trim(),
  );
  if (list.length === 0 || list.some((v) => v === "" || v.includes("/"))) {
    throw new Error(
      `[Megh] A version must be a non-empty string without "/", got ${JSON.stringify(version)}.`,
    );
  }
  return [...new Set(list)];
}
