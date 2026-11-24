import type { ParameterObject } from "../openapi/openapi";
import { generateClassSchema } from "../openapi/swagger-schema";

/** Key of the {@link RouteDescriptor} in a controller route's Fastify `config`. */
export const ROUTE_DESCRIPTOR_CONFIG_KEY = "meghRoute";

/**
 * What a plugin can learn about a controller route, read from Fastify's
 * `onRoute` hook with {@link getRouteDescriptor}. Inline routes
 * (`mapGet(...)`) have none.
 */
export interface RouteDescriptor {
  /** The controller class. */
  controller: Function;
  /** Name of the handler method on the controller. */
  handler: string;
  /** Path parameters, from the route's `:name` segments, in order. */
  params: { name: string; type: string }[];
  /** `@Query()` parameters, as OpenAPI parameter objects. */
  query: ParameterObject[];
  /**
   * JSON schema of the request body: the `@Body()` DTO, or a raw `body`
   * schema from `@OpenApi`. `undefined` when the route takes no body.
   * Built on the first call.
   */
  body(): Record<string, any> | undefined;
  /** Whether the route needs authorization (`@Authorized`, or a default). */
  authorized: boolean;
}

/** The descriptor of a route seen in an `onRoute` hook, if it's a controller route. */
export function getRouteDescriptor(route: {
  config?: unknown;
}): RouteDescriptor | undefined {
  return (route.config as any)?.[ROUTE_DESCRIPTOR_CONFIG_KEY];
}

const PRIMITIVES = new Set(["string", "number", "integer", "boolean"]);

/** @internal Used by the router. */
export function createRouteDescriptor(input: {
  controller: Function;
  handler: string;
  url: string;
  paramMeta: { key: string; dataType?: unknown }[];
  query: ParameterObject[];
  rawBody?: Record<string, any>;
  bodyClass?: Function;
  authorized: boolean;
}): RouteDescriptor {
  const types = new Map<string, string>();
  for (const p of input.paramMeta) {
    if (typeof p.dataType === "string" && PRIMITIVES.has(p.dataType))
      types.set(p.key, p.dataType);
  }
  const params = [...input.url.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({
    name: m[1],
    type: types.get(m[1]) ?? "string",
  }));

  let built = false;
  let body: Record<string, any> | undefined;
  return {
    controller: input.controller,
    handler: input.handler,
    params,
    query: input.query,
    authorized: input.authorized,
    body() {
      if (!built) {
        built = true;
        body = input.rawBody
          ? input.rawBody
          : input.bodyClass
            ? generateClassSchema(input.bodyClass, { inline: true })
            : undefined;
      }
      return body;
    },
  };
}
