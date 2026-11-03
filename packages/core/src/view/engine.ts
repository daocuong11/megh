import fs from "fs";
import path from "path";
import { compileTemplate, type CompiledTemplate } from "./compiler";
import { builtinDirectives, type DirectiveHandler } from "./directives";
import {
  RenderContext,
  stripPlaceholders,
  type TemplateRenderer,
} from "./runtime";
import { TemplateError } from "./errors";

export type ViewEngineOptions = {
  /** Folder holding the views. Defaults to `<cwd>/views`. */
  root?: string;
  /** File extension. Defaults to `.megh.html`. */
  extension?: string;
  /**
   * `true` compiles each file once. `false` recompiles a file when it changes,
   * so edits show up without a restart. Defaults to `false` only when
   * `NODE_ENV` is `"development"`.
   */
  cache?: boolean;
  /** Guards against a view including itself forever. Defaults to 100. */
  maxDepth?: number;
};

type ViewData = Record<string, unknown>;

/**
 * A Blade-style template engine. Templates compile to JavaScript functions
 * once and are cached, so a render is a function call.
 *
 *   const views = new ViewEngine({ root: "views" });
 *   views.render("pages.home", { user });   // views/pages/home.megh.html
 */
export class ViewEngine implements TemplateRenderer {
  readonly root: string;
  readonly extension: string;
  readonly cache: boolean;
  readonly maxDepth: number;
  private readonly directives = new Map<string, DirectiveHandler>(
    builtinDirectives,
  );
  private readonly compiled = new Map<
    string,
    { fn: CompiledTemplate; mtimeMs: number }
  >();
  private readonly shared: ViewData = {};

  constructor({
    root = path.join(process.cwd(), "views"),
    extension = ".megh.html",
    cache = process.env.NODE_ENV !== "development",
    maxDepth = 100,
  }: ViewEngineOptions = {}) {
    this.root = path.resolve(root);
    this.extension = extension;
    this.cache = cache;
    this.maxDepth = maxDepth;
  }

  /**
   * Register a custom directive. The handler returns JavaScript source:
   *
   *   views.directive("money", (args) => `__out += __rt.escape(fmt(${args}));`);
   */
  directive(name: string, handler: DirectiveHandler) {
    this.directives.set(name, handler);
    this.compiled.clear();
    return this;
  }

  /**
   * Data available in every view (app name, helpers...). The engine is shared
   * across requests, so never put per-request values such as the current
   * user here: pass them to `render` instead.
   */
  share(key: string, value: unknown) {
    this.shared[key] = value;
    return this;
  }

  /** `layouts.app` -> `<root>/layouts/app.megh.html`, refusing paths that escape the root. */
  resolve(name: string) {
    const file = path.resolve(
      this.root,
      name.replace(/\./g, "/") + this.extension,
    );
    if (!file.startsWith(this.root + path.sep)) {
      throw new TemplateError(`Invalid view name "${name}"`);
    }
    return file;
  }

  /** Does `<root>/<name>` exist? */
  exists(name: string) {
    try {
      return fs.statSync(this.resolve(name)).isFile();
    } catch {
      return false;
    }
  }

  private getCompiled(name: string): CompiledTemplate {
    const file = this.resolve(name);
    const cached = this.compiled.get(file);
    if (cached && this.cache) return cached.fn;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new TemplateError(`View "${name}" not found at ${file}`);
    }
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.fn;

    const fn = compileTemplate(fs.readFileSync(file, "utf8"), {
      name,
      directives: this.directives,
    });
    this.compiled.set(file, { fn, mtimeMs: stat.mtimeMs });
    return fn;
  }

  /** @internal Called by the runtime for layouts, includes and components. */
  renderTemplate(name: string, data: ViewData, ctx: RenderContext): string {
    if (++ctx.depth > this.maxDepth) {
      throw new TemplateError(
        `View nesting deeper than ${this.maxDepth} (recursive @include?)`,
        { template: name },
      );
    }
    try {
      return this.getCompiled(name)(data, ctx);
    } finally {
      ctx.depth--;
    }
  }

  /** Render a view file to an HTML string. */
  render(name: string, data: ViewData = {}): string {
    const ctx = new RenderContext(this);
    return stripPlaceholders(
      this.renderTemplate(name, { ...this.shared, ...data }, ctx),
    );
  }

  /** Render a template held in a string (tests, emails kept in code). Not cached. */
  renderString(src: string, data: ViewData = {}, name = "inline"): string {
    const ctx = new RenderContext(this);
    const fn = compileTemplate(src, {
      name,
      directives: this.directives,
    });
    return stripPlaceholders(fn({ ...this.shared, ...data }, ctx));
  }
}

let defaultEngine: ViewEngine | undefined;

/**
 * The engine `Results.View` renders with. It is the one passed to
 * `app.useViews()`, or one reading `<cwd>/views` if that was never called.
 */
export function getViewEngine(): ViewEngine {
  if (!defaultEngine) defaultEngine = new ViewEngine();
  return defaultEngine;
}

/** Replace the engine `Results.View` renders with. `app.useViews()` calls this. */
export function setViewEngine(engine: ViewEngine | undefined) {
  defaultEngine = engine;
}
