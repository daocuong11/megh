/**
 * Completion and hover inside Megh code: {{ }}, {!! !!}, directive
 * arguments, @js blocks. HTML completion and hover live in complete.ts.
 */
import { loopVariables } from './components';
import { DIRECTIVES, LOOP_PROPS } from './directives';
import type { Range } from './mask';
import type { ProjectIndex, VariableSource } from './project';

export type CodeItem = {
  label: string;
  kind: 'variable' | 'property' | 'view' | 'section';
  detail?: string;
  documentation?: string;
  /** Text from `start` to the cursor is replaced. */
  start: number;
};

export type CodeHover = { markdown: string; start: number; end: number };

/** Where the data for the current template comes from. */
export type CodeContext = { index?: ProjectIndex; view?: string };

const NAME_ARG_DIRECTIVES: Record<string, 'view' | 'component' | 'section'> = {
  include: 'view',
  extends: 'view',
  component: 'component',
  section: 'section',
  yield: 'section',
};

/**
 * Items for a cursor inside Megh code, or `null` when nothing applies
 * (inside a comment, a string, or after `as` in @foreach).
 */
export function completeCode(
  text: string,
  offset: number,
  range: Range,
  ranges: Range[],
  ctx: CodeContext,
): CodeItem[] | null {
  if (range.kind === 'comment' || range.kind === 'escape') return null;
  if (range.innerStart === undefined || offset < range.innerStart) return null;
  const before = text.slice(range.innerStart, offset);

  // @include('|'), @extends('|'), @component('|'), @section('|'), @yield('|')
  const what = range.kind === 'directive' ? NAME_ARG_DIRECTIVES[range.name!] : undefined;
  const nameArg = /^\s*(['"`])([\w./-]*)$/.exec(before);
  if (nameArg) {
    if (!what || !ctx.index) return null;
    const start = offset - nameArg[2].length;
    const names =
      what === 'view'
        ? ctx.index.viewNames().filter((v) => !v.startsWith('components.'))
        : what === 'component'
          ? ctx.index.componentNames()
          : ctx.index.sectionNames();
    return names.map((label) => ({ label, kind: what === 'section' ? 'section' : 'view', start }));
  }
  if (inString(before)) return null;
  if (range.kind === 'directive' && range.name === 'foreach' && /\bas\s+[\w$]*$/.test(before)) return null;

  // name.prop| -> members
  const member = /([A-Za-z_$][\w$]*)\??\.([\w$]*)$/.exec(before);
  if (member) {
    const [, root, partial] = member;
    const start = offset - partial.length;
    if (root === 'loop') {
      return Object.entries(LOOP_PROPS).map(([label, documentation]) => ({
        label,
        kind: 'property',
        detail: 'loop',
        documentation,
        start,
      }));
    }
    return (ctx.index?.membersOf(root) ?? []).map((label) => ({
      label,
      kind: 'property',
      detail: `used as ${root}.${label} in templates`,
      start,
    }));
  }

  // name| -> variables in scope
  const word = /(?<![\w$.])([A-Za-z_$][\w$]*)?$/.exec(before);
  if (!word) return null;
  const start = offset - (word[1]?.length ?? 0);
  return [...scopeAt(text, offset, ranges, ctx)].map(([label, s]) => ({
    label,
    kind: 'variable',
    detail: s.detail,
    start,
  }));
}

/** Variables visible at `offset`: view data plus @foreach/@for/@js locals. */
export function scopeAt(
  text: string,
  offset: number,
  ranges: Range[],
  ctx: CodeContext,
): Map<string, VariableSource> {
  const out = new Map<string, VariableSource>();
  const loops: Array<Array<[string, VariableSource]>> = [];
  const locals: Array<[string, VariableSource]> = [];
  for (const r of ranges) {
    if (r.start >= offset) break;
    const args = r.innerStart !== undefined ? text.slice(r.innerStart, Math.min(r.innerEnd!, text.length)) : '';
    if (r.kind === 'directive' && r.name === 'foreach') {
      // Inside the @foreach(...) itself, its variables are not defined yet.
      if (offset < r.end) continue;
      const vars: Array<[string, VariableSource]> = loopVariables(args).map((v) => [
        v,
        { detail: `@foreach(${args.trim()})` },
      ]);
      vars.push(['loop', { detail: 'loop info of the current @foreach' }]);
      loops.push(vars);
    } else if (r.kind === 'directive' && r.name === 'for') {
      if (offset < r.end) continue;
      const m = /^\s*(?:let|var|const)\s+([A-Za-z_$][\w$]*)/.exec(args);
      loops.push(m ? [[m[1], { detail: `@for(${args.trim()})` }]] : []);
    } else if (r.kind === 'directive' && (r.name === 'endforeach' || r.name === 'endfor')) {
      loops.pop();
    } else if ((r.kind === 'directive' || r.kind === 'block') && r.name === 'js') {
      const end = Math.min(r.innerEnd ?? r.end, offset);
      const code = text.slice(r.innerStart ?? r.start, end);
      for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
        locals.push([m[1], { detail: '@js variable' }]);
      }
    }
  }
  for (const frame of [...loops].reverse()) for (const [k, s] of frame) if (!out.has(k)) out.set(k, s);
  for (const [k, s] of locals) if (!out.has(k)) out.set(k, s);
  if (ctx.index && ctx.view) {
    for (const [k, s] of ctx.index.variablesFor(ctx.view)) if (!out.has(k)) out.set(k, s);
  }
  return out;
}

/** Hover for a directive name or a variable in Megh code. */
export function hoverCode(
  text: string,
  offset: number,
  range: Range,
  ranges: Range[],
  ctx: CodeContext,
): CodeHover | null {
  // @name
  if ((range.kind === 'directive' || range.kind === 'block') && range.name) {
    const nameEnd = range.start + 1 + range.name.length;
    if (offset >= range.start && offset <= nameEnd) {
      const d = DIRECTIVES[range.name];
      const markdown = d
        ? `\`\`\`megh\n${d.syntax}\n\`\`\`\n${d.doc}`
        : `\`@${range.name}\`: a custom directive, registered with \`engine.directive()\`.`;
      return { markdown, start: range.start, end: nameEnd };
    }
  }
  if (range.kind === 'comment' || range.kind === 'escape' || range.innerStart === undefined) return null;
  if (offset < range.innerStart || offset > (range.innerEnd ?? range.end)) return null;

  // The identifier (and the one before a dot) under the cursor.
  let s = offset;
  let e = offset;
  while (s > range.innerStart && /[\w$]/.test(text[s - 1])) s--;
  while (e < text.length && /[\w$]/.test(text[e])) e++;
  if (s === e || /\d/.test(text[s])) return null;
  const name = text.slice(s, e);
  if (inString(text.slice(range.innerStart, s))) return null;

  const dot = text[s - 1] === '.' ? /([A-Za-z_$][\w$]*)\??\.$/.exec(text.slice(range.innerStart, s)) : null;
  if (dot) {
    if (dot[1] === 'loop' && LOOP_PROPS[name]) {
      return { markdown: `\`loop.${name}\`: ${LOOP_PROPS[name]}`, start: s, end: e };
    }
    return null;
  }
  const v = scopeAt(text, s, ranges, ctx).get(name);
  if (!v) return null;
  const doc = name === 'loop' ? '\n\nProperties: ' + Object.keys(LOOP_PROPS).map((k) => `\`${k}\``).join(', ') : '';
  return { markdown: `\`${name}\`: ${v.detail}${doc}`, start: s, end: e };
}

/** True if `code` ends inside an unclosed string literal. */
function inString(code: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
  }
  return quote !== null;
}
