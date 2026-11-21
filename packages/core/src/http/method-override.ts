import type { IncomingMessage } from "http";
import type { FastifyInstance } from "fastify";

/** HTTP methods a form may ask for with `_method`. */
export const OVERRIDABLE_METHODS = ["PUT", "PATCH", "DELETE"] as const;

const URLENCODED = "application/x-www-form-urlencoded";
const MULTIPART = "multipart/form-data";
const STRATEGY = "meghMethodOverride";
/** How far into a multipart body to look for `_method` before giving up. */
const MULTIPART_PEEK_LIMIT = 64 * 1024;
/** Hidden fields the view helpers add, removed from the parsed form. */
export const FORM_ONLY_FIELDS = ["_method", "_token"] as const;

type RawRequest = IncomingMessage & {
  /** The method the client sent, when `_method` replaced it. */
  originalMethod?: string;
};

/** Parse a urlencoded body; a repeated field (`tags=a&tags=b`) becomes an array. */
export function parseForm(body: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  for (const [key, value] of new URLSearchParams(body)) {
    const prev = out[key];
    out[key] =
      prev === undefined
        ? value
        : Array.isArray(prev)
          ? [...prev, value]
          : [prev, value];
  }
  return out;
}

/**
 * Decides from the body read so far: the `_method` value once found, `null`
 * once it is certain there is none (or too late to look), `undefined` to
 * keep reading.
 */
type Scan = (seen: string, complete: boolean) => string | null | undefined;

const scanUrlencoded: Scan = (seen, complete) => {
  // `_method=VALUE` is final as soon as an `&` follows it.
  const early = /(?:^|&)_method=([^&]*)&/.exec(seen);
  if (early) return new URLSearchParams("v=" + early[1]).get("v");
  return complete
    ? (new URLSearchParams(seen).get("_method") ?? null)
    : undefined;
};

function multipartScanner(contentType: string): Scan | null {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!match) return null;
  const delimiter = "--" + (match[1] ?? match[2]);
  return (seen, complete) => {
    // Walk the parts that have fully arrived, in order.
    let at = seen.indexOf(delimiter);
    while (at !== -1) {
      const headStart = at + delimiter.length;
      if (seen.startsWith("--", headStart)) return null; // closing delimiter
      const headEnd = seen.indexOf("\r\n\r\n", headStart);
      if (headEnd === -1) break;
      const head = seen.slice(headStart, headEnd);
      // A file part: stop rather than read the upload into memory.
      // `_method` has to come before file inputs.
      if (/filename\*?=/i.test(head)) return null;
      const next = seen.indexOf("\r\n" + delimiter, headEnd + 4);
      if (next === -1) break;
      if (/;\s*name="_method"/i.test(head)) {
        return Buffer.from(seen.slice(headEnd + 4, next), "latin1").toString(
          "utf8",
        );
      }
      at = next + 2;
    }
    return complete || seen.length > MULTIPART_PEEK_LIMIT ? null : undefined;
  };
}

/**
 * Let HTML forms reach PUT, PATCH and DELETE routes. A form can only send
 * GET or POST, so it POSTs with a hidden `_method` field (what `@method()`
 * renders) and the request is routed as that method. Works for urlencoded
 * and multipart (file upload) forms.
 *
 * Fastify picks the route before the body is read, so the start of the body
 * is read first, inside an async route constraint (the one hook that runs
 * before the route lookup), and pushed back onto the request with
 * `unshift()`. Body parsers, `@fastify/multipart` included, then read the
 * whole body as if it had never been touched.
 *
 * - urlencoded: read until `_method` is found or the body ends.
 * - multipart: read only the text fields before the first file, at most
 *   64 KB. Put `@method()` before any file input.
 *
 * Only POSTs with a `Content-Length` within `bodyLimit` are looked at;
 * everything else goes straight to the router.
 */
export function installMethodOverride(app: FastifyInstance) {
  const bodyLimit = app.initialConfig.bodyLimit ?? 1024 * 1024;

  app.addConstraintStrategy({
    name: STRATEGY,
    // Marks the strategy as in use, so it runs for every request even though
    // no route declares it. It always derives `undefined`, so it never
    // filters a route out.
    mustMatchWhenDerived: true,
    storage() {
      const store = new Map<string, unknown>();
      return {
        get: (key: string) => (store.get(key) ?? null) as any,
        set: (key: string, value: unknown) => void store.set(key, value),
      };
    },
    deriveConstraint(req: RawRequest, _ctx: unknown, done: any) {
      if (req.method !== "POST") return done(null, undefined);
      const length = Number(req.headers["content-length"]);
      // A multipart body may be larger than bodyLimit (files have their own
      // limit); only the first 64 KB of it is read here anyway.
      const type = String(req.headers["content-type"] ?? "");
      const lower = type.toLowerCase();
      const isUrlencoded = lower.startsWith(URLENCODED);
      const scan = isUrlencoded
        ? scanUrlencoded
        : lower.startsWith(MULTIPART)
          ? multipartScanner(type)
          : null;
      if (
        !scan ||
        !Number.isFinite(length) ||
        length <= 0 ||
        (isUrlencoded && length > bodyLimit)
      ) {
        return done(null, undefined);
      }

      const chunks: Buffer[] = [];
      let received = 0;
      let finished = false;
      const finish = (wanted: string | null, err: Error | null = null) => {
        if (finished) return;
        finished = true;
        req.removeListener("readable", onReadable);
        req.removeListener("error", onError);
        // Synchronously, before the stream can emit 'end', so the parsers
        // downstream read these bytes again from the start.
        if (chunks.length && !req.readableEnded)
          req.unshift(Buffer.concat(chunks));
        const method = wanted?.trim().toUpperCase();
        if (
          method &&
          (OVERRIDABLE_METHODS as readonly string[]).includes(method)
        ) {
          req.originalMethod = req.method;
          req.method = method;
        }
        done(err, undefined);
      };
      const onError = (err: Error) => finish(null, err);
      const onReadable = () => {
        let chunk: Buffer | null;
        while ((chunk = req.read()) !== null) {
          chunks.push(chunk);
          received += chunk.length;
          // latin1 keeps one char per byte, so multipart stays byte-exact.
          const seen = Buffer.concat(chunks).toString(
            isUrlencoded ? "utf8" : "latin1",
          );
          const result = scan(seen, received >= length);
          if (result !== undefined) return finish(result);
        }
      };
      req.on("error", onError);
      req.on("readable", onReadable);
    },
  } as any);

  // The routes need the form fields too; add a parser unless one exists.
  // `_method` (routing) and `_token` (what `@csrf` renders) are dropped, so a
  // DTO does not have to declare them: validation rejects unknown fields.
  if (!app.hasContentTypeParser(URLENCODED)) {
    app.addContentTypeParser(
      URLENCODED,
      { parseAs: "string" },
      (_req, body, done) => {
        const fields = parseForm(body as string);
        for (const key of FORM_ONLY_FIELDS) delete fields[key];
        done(null, fields);
      },
    );
  }
}
