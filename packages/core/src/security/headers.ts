/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 */
import type { FastifyInstance } from "fastify";

/** A CSP directive value: one source, a list, `true` for a bare directive, `false` to drop it. */
export type CspDirectiveValue = string | string[] | boolean;

export interface ContentSecurityPolicyOptions {
  /**
   * Directives merged over the defaults. Keys are camelCase or kebab-case
   * (`scriptSrc` or `script-src`). `false` removes a default directive.
   */
  directives?: Record<string, CspDirectiveValue>;
  /** Start from an empty policy instead of the defaults. Defaults to `true`. */
  useDefaults?: boolean;
  /** Send `Content-Security-Policy-Report-Only` instead, to try a policy out. */
  reportOnly?: boolean;
}

export interface StrictTransportSecurityOptions {
  /** Seconds browsers keep to HTTPS. Defaults to 31536000 (one year). */
  maxAge?: number;
  /** Apply to subdomains too. Defaults to `true`. */
  includeSubDomains?: boolean;
  /** Ask to be put on the browsers' preload list. Defaults to `false`. */
  preload?: boolean;
}

export type ReferrerPolicy =
  | "no-referrer"
  | "no-referrer-when-downgrade"
  | "origin"
  | "origin-when-cross-origin"
  | "same-origin"
  | "strict-origin"
  | "strict-origin-when-cross-origin"
  | "unsafe-url";

/**
 * Options for `app.useSecurityHeaders()`. Every header is on by default
 * except `Cross-Origin-Embedder-Policy`; pass `false` to leave one out.
 */
export interface SecurityHeadersOptions {
  /** `Content-Security-Policy`. Defaults to a strict same-origin policy. */
  contentSecurityPolicy?: boolean | ContentSecurityPolicyOptions;
  /** `Strict-Transport-Security`. Browsers ignore it over plain HTTP. */
  strictTransportSecurity?: boolean | StrictTransportSecurityOptions;
  /** `X-Frame-Options`. Defaults to `SAMEORIGIN`. */
  frameOptions?: false | "DENY" | "SAMEORIGIN";
  /** `Referrer-Policy`. Defaults to `no-referrer`. */
  referrerPolicy?: false | ReferrerPolicy | ReferrerPolicy[];
  /** `Cross-Origin-Opener-Policy`. Defaults to `same-origin`. */
  crossOriginOpenerPolicy?:
    false | "same-origin" | "same-origin-allow-popups" | "unsafe-none";
  /** `Cross-Origin-Resource-Policy`. Defaults to `same-origin`. */
  crossOriginResourcePolicy?:
    false | "same-origin" | "same-site" | "cross-origin";
  /** `Cross-Origin-Embedder-Policy`. Off by default: it blocks cross-origin images and scripts. */
  crossOriginEmbedderPolicy?:
    false | "require-corp" | "credentialless" | "unsafe-none";
  /**
   * Any other header to set, or a default to remove with `false`, e.g.
   * `{ 'Permissions-Policy': 'camera=()', 'X-DNS-Prefetch-Control': false }`.
   */
  headers?: Record<string, string | false>;
}

const DEFAULT_CSP_DIRECTIVES: Record<string, CspDirectiveValue> = {
  "default-src": "'self'",
  "base-uri": "'self'",
  "font-src": ["'self'", "https:", "data:"],
  "form-action": "'self'",
  "frame-ancestors": "'self'",
  "img-src": ["'self'", "data:"],
  "object-src": "'none'",
  "script-src": "'self'",
  "script-src-attr": "'none'",
  "style-src": ["'self'", "https:", "'unsafe-inline'"],
  "upgrade-insecure-requests": true,
};

/** Headers with no option of their own; turn one off through `headers`. */
const FIXED_HEADERS: Record<string, string> = {
  "Origin-Agent-Cluster": "?1",
  "X-Content-Type-Options": "nosniff",
  "X-DNS-Prefetch-Control": "off",
  "X-Download-Options": "noopen",
  "X-Permitted-Cross-Domain-Policies": "none",
  // The legacy XSS auditor caused more holes than it closed; turn it off.
  "X-XSS-Protection": "0",
};

/** Turn the options into the final header list, once at startup. */
export function buildSecurityHeaders(
  options: SecurityHeadersOptions = {},
): [string, string][] {
  const headers = new Map<string, [string, string]>();
  const set = (name: string, value: string) =>
    headers.set(name.toLowerCase(), [name, value]);

  const csp = options.contentSecurityPolicy ?? true;
  if (csp !== false) {
    const cspOptions = csp === true ? {} : csp;
    set(
      cspOptions.reportOnly
        ? "Content-Security-Policy-Report-Only"
        : "Content-Security-Policy",
      buildCsp(cspOptions),
    );
  }

  const hsts = options.strictTransportSecurity ?? true;
  if (hsts !== false) {
    const {
      maxAge = 31_536_000,
      includeSubDomains = true,
      preload = false,
    } = hsts === true ? {} : hsts;
    if (!Number.isInteger(maxAge) || maxAge < 0) {
      throw new TypeError(
        `[Megh] strictTransportSecurity.maxAge must be a whole number of seconds, got ${maxAge}.`,
      );
    }
    set(
      "Strict-Transport-Security",
      [
        `max-age=${maxAge}`,
        includeSubDomains && "includeSubDomains",
        preload && "preload",
      ]
        .filter(Boolean)
        .join("; "),
    );
  }

  const frame = options.frameOptions ?? "SAMEORIGIN";
  if (frame) set("X-Frame-Options", frame);

  const referrer = options.referrerPolicy ?? "no-referrer";
  if (referrer) {
    set(
      "Referrer-Policy",
      Array.isArray(referrer) ? referrer.join(",") : referrer,
    );
  }

  const coop = options.crossOriginOpenerPolicy ?? "same-origin";
  if (coop) set("Cross-Origin-Opener-Policy", coop);

  const corp = options.crossOriginResourcePolicy ?? "same-origin";
  if (corp) set("Cross-Origin-Resource-Policy", corp);

  const coep = options.crossOriginEmbedderPolicy ?? false;
  if (coep) set("Cross-Origin-Embedder-Policy", coep);

  for (const [name, value] of Object.entries(FIXED_HEADERS)) set(name, value);

  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === false) headers.delete(name.toLowerCase());
    else set(name, assertHeaderValue(name, value));
  }

  return [...headers.values()];
}

function buildCsp(options: ContentSecurityPolicyOptions): string {
  const directives = new Map<string, CspDirectiveValue>(
    options.useDefaults === false ? [] : Object.entries(DEFAULT_CSP_DIRECTIVES),
  );
  for (const [key, value] of Object.entries(options.directives ?? {})) {
    directives.set(kebabCase(key), value);
  }

  const parts: string[] = [];
  for (const [name, value] of directives) {
    if (value === false) continue;
    if (!/^[a-z-]+$/.test(name)) {
      throw new TypeError(`[Megh] Invalid CSP directive name "${name}".`);
    }
    if (value === true) {
      parts.push(name);
      continue;
    }
    const sources = Array.isArray(value) ? value : [value];
    for (const source of sources) {
      if (/[;,\r\n]/.test(source)) {
        throw new TypeError(
          `[Megh] CSP directive "${name}" has an invalid source "${source}".`,
        );
      }
    }
    parts.push(sources.length ? `${name} ${sources.join(" ")}` : name);
  }
  if (parts.length === 0) {
    throw new TypeError(
      "[Megh] contentSecurityPolicy has no directives. Pass contentSecurityPolicy: false to send none.",
    );
  }
  return parts.join("; ");
}

function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function assertHeaderValue(name: string, value: string): string {
  if (typeof value !== "string" || /[\r\n]/.test(value)) {
    throw new TypeError(`[Megh] Invalid value for security header "${name}".`);
  }
  return value;
}

const CSP_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
]);

/**
 * Set the security headers on every response, including errors and 404s.
 * A header the route sets itself wins.
 *
 * `cspExemptPrefix` returns a path (the API docs page) whose responses get
 * no CSP from here: Swagger UI sends its own, and Scalar needs inline script.
 * It is read on each request, since `useOpenApi()` may be called later.
 */
export function installSecurityHeaders(
  app: FastifyInstance,
  options?: SecurityHeadersOptions,
  cspExemptPrefix: () => string | undefined = () => undefined,
) {
  const headers = buildSecurityHeaders(options);
  const withoutCsp = headers.filter(
    ([name]) => !CSP_HEADERS.has(name.toLowerCase()),
  );
  app.addHook("onRequest", (request, reply, done) => {
    const prefix = cspExemptPrefix();
    const list = prefix && isUnder(request.url, prefix) ? withoutCsp : headers;
    for (const [name, value] of list) reply.header(name, value);
    done();
  });
}

function isUnder(url: string, prefix: string): boolean {
  const base = prefix.replace(/\/+$/, "");
  // A docs page at "/" must not take the CSP off the whole app.
  if (base === "" || !url.startsWith(base)) return false;
  const next = url.charAt(base.length);
  return next === "" || next === "/" || next === "?";
}
