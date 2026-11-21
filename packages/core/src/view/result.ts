import type { FastifyReply } from "fastify";
import { getViewEngine } from "./engine";

/**
 * A rendered HTML page as a route result. Return it from a controller or a
 * `mapGet` handler:
 *
 *   return Results.View("pages.home", { user });
 *   return view("errors.404", {}, 404);
 */
export class ViewResult {
  readonly headers: Record<string, string> = {};

  constructor(
    public readonly name: string,
    public readonly data: Record<string, unknown> = {},
    public readonly statusCode: number = 200,
  ) {}

  /** Add a response header. Returns `this` for chaining. */
  header(name: string, value: string) {
    this.headers[name] = value;
    return this;
  }

  /** Render with the engine configured by `app.useViews()`. */
  render(): string {
    return getViewEngine().render(this.name, this.data);
  }
}

/** Shorthand for `Results.View(name, data, status)`. */
export function view(
  name: string,
  data?: Record<string, unknown>,
  statusCode?: number,
): ViewResult {
  return new ViewResult(name, data, statusCode);
}

/** @internal Render a ViewResult and send it as `text/html`. */
export function sendView(res: FastifyReply, result: ViewResult) {
  // Render first: if the template throws, nothing has been written yet and
  // Fastify's error handler can still answer.
  const html = result.render();
  for (const [k, v] of Object.entries(result.headers)) res.header(k, v);
  return res
    .code(result.statusCode)
    .type("text/html; charset=utf-8")
    .send(html);
}
