/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 */
import { Injectable } from "../di";
import { IRequest, IResponse } from "../core/types";
import { HttpExceptionTypes as HttpException } from "../common/exceptions";
import { AUTHORIZATION_META_KEY, PUBLIC_META_KEY } from "../common/container";
import { Constructor } from "../common/helpers";

export abstract class MeghMiddleware {
  abstract invoke(
    req: IRequest,
    res?: IResponse,
  ): Promise<IRequest | HttpException>;
}
/**
 * Shape of an authorization handler registered with `app.useAuthorization`.
 * Return `false` (or throw) to deny with 403.
 */
export interface AuthorizeClass {
  authorize(req: IRequest, options?: any): unknown;
}

/**
 * Marks a class as an authorization handler and registers it for DI.
 *
 *   @CanAuthorize
 *   class JwtAuthorization {
 *     authorize(req: IRequest, options?: { roles?: string[] }) { ... }
 *   }
 *
 *   app.useAuthorization(JwtAuthorization);
 */
export function CanAuthorize(target: { new (...args: any[]): AuthorizeClass }) {
  if (typeof target.prototype.authorize !== "function") {
    throw new Error(
      `Class "${target.name}" must implement an "authorize" method.`,
    );
  }
  Injectable()(target);
}

/**
 * Options accepted by @Authorized.
 *
 * @example
 * // Use the default (only) authorizer
 * @Authorized()
 *
 * @example
 * // Select a named authorizer registered via useAuthorization({ jwt: JwtAuth })
 * @Authorized("jwt")
 * @Authorized({ name: "oauth" })
 * @Authorized({ name: "jwt", roles: ["admin"] })
 */
export type AuthorizedOptions =
  | string // shorthand: the authorizer name
  | { name?: string; [key: string]: any }; // object form: { name, roles, ... }

/**
 * Leave a controller or route out of the default authorization set with
 * `useAuthorization(handler, { default })`. Without a default, routes are
 * public anyway and this has no effect. An explicit `@Authorized` still
 * applies.
 *
 *   @Public()
 *   @Get("/status")
 *   status() {}
 */
export function Public(): ClassDecorator & MethodDecorator {
  return function (target: any, propertyKey?: string | symbol) {
    if (propertyKey !== undefined) {
      Reflect.defineMetadata(
        PUBLIC_META_KEY,
        true,
        target.constructor,
        propertyKey,
      );
    } else {
      Reflect.defineMetadata(PUBLIC_META_KEY, true, target);
    }
  } as ClassDecorator & MethodDecorator;
}

/**
 * What a route without `@Authorized` or `@Public` requires when a default is
 * set with `useAuthorization(handler, { default })`:
 *
 * - `"authenticated"`: a user from `useAuthentication()`, else 401.
 * - `true`: the default authorizer, like a bare `@Authorized()`.
 * - a name or `{ name, ...options }`: like `@Authorized(name)`.
 */
export type AuthorizationDefault = "authenticated" | true | AuthorizedOptions;

/** Options for `app.useAuthorization(handler, options)`. */
export interface UseAuthorizationOptions {
  /**
   * Protect every controller and inline route that has neither `@Authorized`
   * nor `@Public`. Off by default. Health probes, the OpenAPI UI and static
   * files are not routes Megh authorizes, so they stay public.
   */
  default?: AuthorizationDefault;
}

export function Authorized(): ClassDecorator & MethodDecorator;
export function Authorized(
  options: AuthorizedOptions,
): ClassDecorator & MethodDecorator;
export function Authorized(
  options: AuthorizedOptions = {},
): MethodDecorator | ClassDecorator {
  // Normalise to { name?, ...rest } so the router always sees a consistent shape
  const normalised: { name?: string; [key: string]: any } =
    typeof options === "string" ? { name: options } : options;

  return function (
    target: any,
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) {
    if (propertyKey && descriptor) {
      Reflect.defineMetadata(
        AUTHORIZATION_META_KEY,
        { authorize: true, options: normalised },
        target.constructor,
        propertyKey,
      );
    } else {
      Reflect.defineMetadata(
        AUTHORIZATION_META_KEY,
        { authorize: true, options: normalised },
        target,
      );
    }
  };
}

export function AppMiddleware(target: Constructor<MeghMiddleware>) {
  if (typeof target.prototype.invoke !== "function") {
    throw new Error(
      `Class "${target.name}" must implement an "invoke" method.`,
    );
  }

  Injectable()(target);
}

/**
 * A decorator function that applies one or more middleware to a class or a method.
 *
 * When applied to a class, the middleware are registered for the entire controller.
 * When applied to a method, the middleware are registered for that specific route.
 *
 * Classes are resolved through the DI container when the route is registered,
 * so middleware can use constructor injection. They run after authentication,
 * authorization and the global middlewares, class-level before method-level.
 *
 * @param options - A single middleware instance/class or an array of middleware instances/classes to be applied.
 * @returns A decorator that registers the middleware metadata.
 */
export function UseMiddleware<
  T extends MeghMiddleware | (new (...args: any[]) => MeghMiddleware),
>(options: T | T[]): MethodDecorator & ClassDecorator {
  return function (
    target: Object | Function,
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) {
    const middlewareList = Array.isArray(options) ? options : [options];
    if (typeof target === "function" && !propertyKey) {
      const existingMiddlewares =
        Reflect.getMetadata("controller:middleware", target) || [];
      Reflect.defineMetadata(
        "controller:middleware",
        [...existingMiddlewares, ...middlewareList],
        target,
      );
    } else if (descriptor) {
      const existingMiddlewares =
        Reflect.getMetadata("route:middleware", target, propertyKey!) || [];
      Reflect.defineMetadata(
        "route:middleware",
        [...existingMiddlewares, ...middlewareList],
        target,
        propertyKey!,
      );
    }
  };
}
