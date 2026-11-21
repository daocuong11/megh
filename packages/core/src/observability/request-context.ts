/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 */
import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "http";

interface RequestStore {
  /** Unset when request IDs are off (`requestId: false`). */
  requestId?: string;
  user?: unknown;
  values: Map<unknown, unknown>;
}

const storage = new AsyncLocalStorage<RequestStore>();

/**
 * A typed key for {@link requestContext}. Two keys with the same name are
 * still different keys, so libraries can't clash.
 *
 *   export const TENANT = createContextKey<string>("tenant");
 */
export interface ContextKey<T> {
  readonly name: string;
  /** Carries `T` for type inference only; never set. */
  readonly __type?: T;
}

/** Create a typed {@link ContextKey}. */
export function createContextKey<T>(name: string): ContextKey<T> {
  return Object.freeze({ name }) as ContextKey<T>;
}

type Key<T> = ContextKey<T> | string;

const keyName = (key: Key<unknown>) =>
  typeof key === "string" ? key : key.name;

function activeStore(what: string): RequestStore {
  const store = storage.getStore();
  if (!store) {
    throw new Error(
      `[Megh] requestContext.${what} was called outside a request. Inside a worker, script or test, wrap the code in requestContext.run().`,
    );
  }
  return store;
}

/** What {@link requestContext.run} starts a context with. */
export interface RequestContextInit {
  requestId?: string;
  user?: unknown;
  values?: Iterable<readonly [Key<unknown>, unknown]>;
}

/**
 * Values for the request being handled, readable anywhere in its async call
 * chain (services, repositories, event listeners) without passing them
 * through every call. Each request has its own values.
 *
 *   // in an authenticator or middleware
 *   requestContext.set(TENANT, req.headers["x-tenant"]);
 *
 *   // in a service
 *   const tenant = requestContext.get(TENANT); // string | undefined
 *
 * Outside a request, `get` returns `undefined` and `set` throws. Work started
 * inside a request (awaited calls, timers, in-memory queued events) keeps its
 * context. BullMQ jobs run in another process, so pass what they need in the
 * job data.
 */
export const requestContext = {
  /** `true` inside a request (or `run()`). */
  get active(): boolean {
    return storage.getStore() !== undefined;
  },

  /** The request ID, as {@link getRequestId}. */
  get requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },

  /**
   * The user `useAuthentication()` resolved for this request, or
   * `undefined` before authentication, for anonymous requests and outside
   * a request. Use {@link requestContext.getUser} for a typed value.
   */
  get user(): unknown {
    return storage.getStore()?.user;
  },

  /** The authenticated user, typed. See {@link requestContext.user}. */
  getUser<TUser>(): TUser | undefined {
    return storage.getStore()?.user as TUser | undefined;
  },

  /** A value set for this request, or `undefined`. */
  get<T>(key: Key<T>): T | undefined {
    return storage.getStore()?.values.get(key) as T | undefined;
  },

  /** A value set for this request; throws when it isn't set. */
  getOrThrow<T>(key: Key<T>): T {
    const values = activeStore("getOrThrow()").values;
    if (!values.has(key)) {
      throw new Error(
        `[Megh] requestContext has no value for "${keyName(key)}" in this request.`,
      );
    }
    return values.get(key) as T;
  },

  /** Whether a value is set for this request. */
  has(key: Key<unknown>): boolean {
    return storage.getStore()?.values.has(key) ?? false;
  },

  /** Set a value for the rest of this request. Throws outside a request. */
  set<T>(key: Key<T>, value: T): void {
    activeStore("set()").values.set(key, value);
  },

  /** Remove a value for the rest of this request. */
  delete(key: Key<unknown>): boolean {
    return storage.getStore()?.values.delete(key) ?? false;
  },

  /**
   * Run `fn` in a fresh context: for workers, scripts and tests that call
   * code reading the request context.
   */
  run<R>(fn: () => R, init: RequestContextInit = {}): R {
    return storage.run(
      {
        requestId: init.requestId,
        user: init.user,
        values: new Map(init.values ?? []),
      },
      fn,
    );
  },
};

/**
 * @internal Record the authenticated user on the request and in the request
 * context, so services can read it with `requestContext.user`.
 */
export function setRequestUser(request: object, user: unknown): void {
  (request as { user?: unknown }).user = user;
  const store = storage.getStore();
  if (store) store.user = user;
}

/** The default header that carries the request ID in and out. */
export const DEFAULT_REQUEST_ID_HEADER = "x-request-id";

/** Accept a client-sent ID only if it is short and log-safe. */
const SAFE_ID = /^[\w.:-]{1,128}$/;

/**
 * The ID of the request being handled, or `undefined` outside a request.
 * Works anywhere in the request's async call chain: services, repositories,
 * event listeners.
 *
 *   logger.info({ requestId: getRequestId() }, "charging card");
 */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Options for request IDs: `false` turns them off. */
export type RequestIdOptions =
  | false
  | {
      /** Header read from the request and set on the response. Defaults to `x-request-id`. */
      header?: string;
      /** Make an ID when the request has none. Defaults to `crypto.randomUUID`. */
      generate?: () => string;
    };

/**
 * A Fastify `genReqId` that reuses a safe incoming header (so an ID set by a
 * proxy or the calling service carries through) or generates a new one.
 */
export function createRequestIdGenerator(
  header: string = DEFAULT_REQUEST_ID_HEADER,
  generate: () => string = randomUUID,
): (req: IncomingMessage) => string {
  const name = header.toLowerCase();
  return (req) => {
    const incoming = req.headers[name];
    const value = Array.isArray(incoming) ? incoming[0] : incoming;
    return value && SAFE_ID.test(value) ? value : generate();
  };
}

/**
 * Give each request its own {@link requestContext}. With a `header`, also
 * echo the request ID on the response and make it available through
 * {@link getRequestId}; `null` when request IDs are off.
 */
export function installRequestContext(
  app: FastifyInstance,
  header: string | null = DEFAULT_REQUEST_ID_HEADER,
) {
  // A callback hook with `run(…, done)`: everything Fastify does after
  // `done()` (the remaining hooks, the handler) runs inside the store.
  app.addHook("onRequest", (request, reply, done) => {
    if (header === null) {
      storage.run({ values: new Map() }, done);
      return;
    }
    reply.header(header, request.id);
    storage.run({ requestId: String(request.id), values: new Map() }, done);
  });
}
