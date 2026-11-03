import { tokenize } from "./lexer";
import { TemplateError } from "./errors";
import {
  builtinDirectives,
  type BlockFrame,
  type CompilerContext,
  type DirectiveHandler,
} from "./directives";
import type { RenderContext } from "./runtime";

/** A compiled template. `source` is the generated function body, for debugging. */
export type CompiledTemplate = ((
  data: Record<string, unknown>,
  runtime: RenderContext,
) => string) & { source: string };

export type CompileOptions = {
  /** Used in error messages, e.g. `pages.home`. */
  name?: string;
  directives?: ReadonlyMap<string, DirectiveHandler>;
};

/**
 * Compiles template source into a function `(data, runtime) => html`.
 * Like Blade, a template becomes code once and every later render is a
 * function call.
 */
export function compileTemplate(
  src: string,
  { name = "anonymous", directives = builtinDirectives }: CompileOptions = {},
): CompiledTemplate {
  const tokens = tokenize(compileComponentTags(src), {
    name,
    directives: directives as Map<string, unknown>,
  });
  const ctx = createCompilerContext(name);

  let code = "";
  for (const t of tokens) {
    code += `__line = ${t.line};\n`;
    switch (t.type) {
      case "text":
        code += `__out += ${JSON.stringify(t.value)};\n`;
        break;
      case "echo":
        code += `__out += __rt.escape(${t.value});\n`;
        break;
      case "raw":
        code += `__out += __rt.raw(${t.value});\n`;
        break;
      case "code":
        code += `${t.value}\n`;
        break;
      case "directive":
        code += `${directives.get(t.name)!(t.args, ctx, t)}\n`;
        break;
    }
  }

  const open = ctx.stack[ctx.stack.length - 1];
  if (open) {
    throw new TemplateError(`Unclosed @${open.tag}`, {
      template: name,
      line: open.line,
    });
  }

  // `with` makes data keys usable as bare variables ({{ user.name }}).
  // Bodies built by `new Function` are sloppy mode, so `with` is allowed.
  const source = `let __out = '', __line = 0, __parent = null;
const __buffers = [];
try {
  with (__data) {
${code}
  }
  return __parent ? __rt.render(__parent, __data) : __out;
} catch (err) {
  throw __rt.wrapError(err, ${JSON.stringify(name)}, __line);
}`;

  let fn: CompiledTemplate;
  try {
    fn = new Function("__data", "__rt", source) as CompiledTemplate;
  } catch (err) {
    throw new TemplateError(
      `Template compiled to invalid JavaScript: ${(err as Error).message}`,
      { template: name, cause: err },
    );
  }
  fn.source = source;
  return fn;
}

function createCompilerContext(name: string): CompilerContext {
  let uid = 0;
  const stack: BlockFrame[] = [];
  const ctx: CompilerContext = {
    stack,
    id: () => `__v${uid++}`,
    error: (msg, t) => new TemplateError(msg, { template: name, line: t.line }),
    expect(args, t) {
      if (!args) throw ctx.error(`@${t.name} expects arguments`, t);
      return args;
    },
    open(t, extra = {}) {
      const frame: BlockFrame = { tag: t.name, line: t.line, ...extra };
      stack.push(frame);
      return frame;
    },
    peek(tags, t) {
      const top = stack[stack.length - 1];
      if (!top || !tags.includes(top.tag)) {
        const openBlock = top
          ? ` (open block is @${top.tag} from line ${top.line})`
          : "";
        throw ctx.error(
          `@${t.name} without matching @${tags.join("/@")}${openBlock}`,
          t,
        );
      }
      return top;
    },
    close(tags, t) {
      ctx.peek(tags, t);
      return stack.pop()!;
    },
    find(tag) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) return stack[i];
      }
      return undefined;
    },
  };
  return ctx;
}

// ---------- <x-component> tag syntax ----------

const ATTR = /(:?)([A-Za-z_][\w-]*)(?:\s*=\s*"([^"]*)")?/g;

function toProps(attrs: string): string {
  const props: string[] = [];
  for (const [, bound, key, value] of attrs.matchAll(ATTR)) {
    // data-id -> dataId
    const prop = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    let expr: string;
    if (value === undefined)
      expr = "true"; // <x-input required>
    else if (bound)
      expr = `(${value})`; // :items="list" -> JS expression
    else expr = JSON.stringify(value); // type="error" -> string
    props.push(`${JSON.stringify(prop)}: ${expr}`);
  }
  return `{ ${props.join(", ")} }`;
}

/**
 * Rewrites `<x-alert type="error">...</x-alert>` into
 * `@component('alert', {...})...@endcomponent` before lexing.
 * Each directive is wrapped in empty comments (`{{----}}`), which compile to
 * nothing. The one in front keeps it recognisable when the tag is glued to a
 * word (`Hi<x-badge/>`), where "@" would otherwise look like part of an email
 * address. The one behind does the same for whatever follows (`<x-badge/>@endif`),
 * and stops text such as `</x-alert>(note)` being read as directive arguments.
 */
export function compileComponentTags(src: string): string {
  const d = (directive: string) => `{{----}}${directive}{{----}}`;
  return src
    .replace(
      /<x-slot(?::([\w-]+)|\s+name="([\w-]+)")\s*>/g,
      (_, a?: string, b?: string) => d(`@slot('${a ?? b}')`),
    )
    .replace(/<\/x-slot(?::[\w-]+)?\s*>/g, d("@endslot"))
    .replace(
      /<x-([\w.-]+)((?:\s+:?[\w-]+(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>/g,
      (_, name: string, attrs: string, selfClosing: string) =>
        d(`@component('${name}', ${toProps(attrs)})`) +
        (selfClosing ? d("@endcomponent") : ""),
    )
    .replace(/<\/x-[\w.-]+\s*>/g, d("@endcomponent"));
}
