import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IAttributeData, ITagData } from 'vscode-html-languageservice';

export const EXTENSION = '.megh.html';

/**
 * The views root for a template: the nearest folder above it that has a
 * `components/` folder. `<x-forms.input>` is `<root>/components/forms/input.megh.html`.
 */
export function findViewsRoot(file: string): string | undefined {
  let dir = path.dirname(file);
  for (;;) {
    if (isDir(path.join(dir, 'components'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** One `x-` tag per component file under `<root>/components`. */
export function scanComponents(root: string): ITagData[] {
  const base = path.join(root, 'components');
  const tags: ITagData[] = [];
  for (const file of walk(base)) {
    const rel = path.relative(base, file).split(path.sep).join('/');
    const name = rel.slice(0, -EXTENSION.length).replace(/\//g, '.');
    tags.push(componentTag(name, rel, fs.readFileSync(file, 'utf8')));
  }
  tags.push({
    name: 'x-slot',
    description: 'Named slot of the enclosing component: `<x-slot:title>` or `<x-slot name="title">`.',
    attributes: [{ name: 'name', description: 'Slot name; the component reads it as a variable.' }],
  });
  return tags;
}

export function componentTag(name: string, rel: string, source: string): ITagData {
  const props = componentProps(source);
  const list = props.length ? props.map((p) => '`' + toAttribute(p) + '`').join(', ') : 'none';
  return {
    name: `x-${name}`,
    description: {
      kind: 'markdown',
      value: `Megh component \`components/${rel}\`\n\nProps: ${list}. Use \`:prop="expr"\` for a JavaScript value.`,
    },
    attributes: componentAttributes(source),
  };
}

// Names a template reads that are not props.
const NOT_PROPS = new Set([
  'slot', 'loop', 'true', 'false', 'null', 'undefined', 'this', 'new', 'typeof', 'instanceof',
  'in', 'of', 'as', 'let', 'const', 'var', 'void', 'await', 'async', 'function', 'return',
  'if', 'else', 'Math', 'JSON', 'Date', 'Number', 'String', 'Boolean', 'Array', 'Object',
  'encodeURIComponent', 'decodeURIComponent', 'window', 'document', 'console',
]);

/** `maxCount` -> `max-count`, the attribute the compiler turns back into `maxCount`. */
export const toAttribute = (prop: string) => prop.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

/** Variables the component reads, as attributes (camelCase props → kebab-case). */
export function componentAttributes(source: string): IAttributeData[] {
  const attrs: IAttributeData[] = [];
  for (const name of componentProps(source)) {
    const attr = toAttribute(name);
    attrs.push({ name: attr, description: `Prop \`${name}\`, passed as a string.` });
    attrs.push({ name: `:${attr}`, description: `Prop \`${name}\`, from a JavaScript expression.` });
  }
  return attrs;
}

/** Names of the variables a component template reads (its props), sorted. */
export function componentProps(source: string): string[] {
  const exprs: string[] = [];
  for (const m of source.matchAll(/\{\{--[\s\S]*?--\}\}|\{!!([\s\S]*?)!!\}|\{\{([\s\S]*?)\}\}/g)) {
    if (m[1] ?? m[2]) exprs.push(m[1] ?? m[2]);
  }
  const loopVars = new Set<string>();
  for (const m of source.matchAll(/(?<![\w@.])@([A-Za-z_]\w*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    if (['extends', 'section', 'yield', 'include', 'push', 'stack', 'slot', 'component', 'method'].includes(m[1])) continue;
    for (const v of loopVariables(m[2])) loopVars.add(v);
    exprs.push(m[2].replace(/\bas\s+.*$/, ''));
  }

  const names = new Set<string>();
  for (const expr of exprs) {
    const code = expr.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
    for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)/g)) {
      const name = m[1];
      // An object key ({ key: 1 }) is not a variable; a ternary's `a : b` is.
      const before = code.slice(0, m.index).trimEnd().slice(-1);
      const after = code.slice(m.index! + name.length).trimStart()[0];
      if (after === ':' && (before === '{' || before === ',')) continue;
      if (!NOT_PROPS.has(name) && !loopVars.has(name) && !name.startsWith('__')) names.add(name);
    }
  }
  return [...names].sort();
}

/** `items as item` -> [item]; `obj as key => value` -> [key, value]. */
export function loopVariables(args: string): string[] {
  const m = /\bas\s+([A-Za-z_$][\w$]*)(?:\s*=>\s*([A-Za-z_$][\w$]*))?\s*$/.exec(args);
  if (!m) return [];
  return m[2] ? [m[1], m[2]] : [m[1]];
}

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.name.endsWith(EXTENSION)) yield full;
  }
}

function isDir(p: string) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
