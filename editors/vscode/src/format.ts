/**
 * Format a Megh template with VS Code's HTML formatter.
 *
 * Megh syntax is swapped for placeholders the HTML formatter understands,
 * the HTML is formatted, and the original text is put back:
 *
 * - A block directive on a line of its own (`@if(x)`, `@else`, `@endif`,
 *   `@foreach(...)`, `@section('content')`, ...) becomes a placeholder tag
 *   (`<megh-b3>` ... `</megh-b3>`), so the formatter indents the block body
 *   like an element's children, <script> and <style> inside it included.
 *   `@else` closes one tag and opens the next, so it lines up with `@if`.
 * - Everything else (`{{ }}`, inline directives, directives inside tags or
 *   <script>/<style>) becomes a word (`__m7xxxx__`) of the same length, so
 *   line wrapping sees the real line lengths. Multi-line constructs (`@js`
 *   blocks, `@react` bodies, long comments) keep their inner lines as written.
 *
 * Returns `null` (leave the document alone) when the template has an
 * unclosed construct or unbalanced blocks, or when the result would differ
 * from the input in anything but whitespace.
 */
import { getLanguageService, HTMLFormatConfiguration } from 'vscode-html-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { BLOCKS, BRANCHES, CLOSERS, opensBlock } from './directives';
import { Range, scanMegh } from './mask';

const service = getLanguageService();

export type FormatOptions = HTMLFormatConfiguration & { tabSize: number; insertSpaces: boolean };

/** Removed after formatting, with the line it is on if nothing else is there. */
const DROP = '\u0000';

export function formatTemplate(text: string, options: FormatOptions): string | null {
  const ranges = scanMegh(text);
  if (ranges.some((r) => r.end > text.length)) return null;
  const tagged = blockTags(text, ranges);
  if (!tagged) return null;

  // 1. placeholders
  const restore = new Map<string, string>();
  const swaps: Array<{ start: number; end: number; placeholder: string }> = [];
  ranges.forEach((r, id) => {
    const source = text.slice(r.start, r.end);
    const tag = tagged.get(id);
    if (tag) {
      for (const [k, v] of tag.restore) restore.set(k, v);
      swaps.push({ start: r.start, end: r.end, placeholder: tag.placeholder });
    } else {
      const ph = word(id, source);
      restore.set(ph, source);
      swaps.push({ start: r.start, end: r.end, placeholder: ph });
    }
  });
  // <x-slot:title> ... </x-slot> look like two different tags to the HTML
  // formatter; give each pair one placeholder tag name.
  for (const [open, close, id] of slotPairs(text, ranges)) {
    for (const [span, ph] of [[open, `<megh-s${id}>`], [close, `</megh-s${id}>`]] as const) {
      restore.set(ph, text.slice(span.start, span.end));
      swaps.push({ ...span, placeholder: ph });
    }
  }
  swaps.sort((a, b) => a.start - b.start);
  let placeheld = '';
  let last = 0;
  for (const s of swaps) {
    placeheld += text.slice(last, s.start) + s.placeholder;
    last = s.end;
  }
  placeheld += text.slice(last);

  // 2. HTML formatter
  const doc = TextDocument.create('file:///megh.html', 'html', 0, placeheld);
  const edits = service.format(doc, undefined, { templating: false, ...options });
  const formatted = TextDocument.applyEdits(doc, edits);

  // 3. restore
  let missing = restore.size;
  let restored = formatted.replace(/<\/?megh-[bs]\d+>|__m\d+x*__/g, (ph) => {
    const original = restore.get(ph);
    if (original === undefined) return ph;
    missing--;
    return original;
  });
  if (missing !== 0) return null;
  restored = restored
    .split('\n')
    .filter((line) => !(line.includes(DROP) && line.replace(DROP, '').trim() === ''))
    .join('\n')
    .split(DROP)
    .join('');
  if (/\n\s*$/.test(text) && !restored.endsWith('\n')) restored += '\n';

  if (squash(restored) !== squash(text)) return null;
  return restored;
}

const squash = (s: string) => s.replace(/\s+/g, '');

/** `__m7__`, padded with `x` to the length of `source` (its first line). */
function word(id: number, source: string) {
  const base = `__m${id}`;
  const len = source.includes('\n') ? 0 : source.length;
  return base + 'x'.repeat(Math.max(0, len - base.length - 2)) + '__';
}

type Tagged = { placeholder: string; restore: Array<[string, string]> };

/**
 * Placeholder tags for blocks whose opener, branches and closer each stand
 * on a line of their own (outside <script>/<style>). `null` if the blocks
 * are unbalanced.
 */
function blockTags(text: string, ranges: Range[]): Map<number, Tagged> | null {
  const raw = rawTextSpans(text);
  const alone = (r: Range) => {
    const lineStart = text.lastIndexOf('\n', r.start - 1) + 1;
    const lineEnd = text.indexOf('\n', r.end);
    return (
      text.slice(lineStart, r.start).trim() === '' &&
      text.slice(r.end, lineEnd === -1 ? text.length : lineEnd).trim() === '' &&
      !raw.some(([s, e]) => r.start > s && r.start < e)
    );
  };

  // Pair up blocks: each one is [opener, ...branches, closer] range ids.
  const blocks: number[][] = [];
  const stack: number[][] = [];
  for (let id = 0; id < ranges.length; id++) {
    const r = ranges[id];
    if (r.kind !== 'directive') continue;
    const name = r.name!;
    const args = r.innerStart !== undefined ? text.slice(r.innerStart, r.innerEnd) : undefined;
    if (opensBlock(name, args)) stack.push([id]);
    else if (name in BRANCHES) {
      const top = stack[stack.length - 1];
      if (!top || !BRANCHES[name].includes(ranges[top[0]].name!)) return null;
      top.push(id);
    } else if (CLOSERS.has(name)) {
      const top = stack.pop();
      if (!top || !BLOCKS[ranges[top[0]].name!].includes(name)) return null;
      top.push(id);
      blocks.push(top);
    }
  }
  if (stack.length) return null;

  const out = new Map<number, Tagged>();
  for (const ids of blocks) {
    if (!ids.every((id) => alone(ranges[id]))) continue;
    const source = (id: number) => text.slice(ranges[id].start, ranges[id].end);
    const tag = (id: number) => `megh-b${id}`;
    // Segments: opener..branch1, branch1..branch2, ..., lastBranch..closer.
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (i === 0) {
        out.set(id, { placeholder: `<${tag(id)}>`, restore: [[`<${tag(id)}>`, source(id)]] });
      } else if (i < ids.length - 1) {
        const prev = ids[i - 1];
        out.set(id, {
          placeholder: `</${tag(prev)}><${tag(id)}>`,
          restore: [[`</${tag(prev)}>`, DROP], [`<${tag(id)}>`, source(id)]],
        });
      } else {
        const prev = ids[i - 1];
        out.set(id, { placeholder: `</${tag(prev)}>`, restore: [[`</${tag(prev)}>`, source(id)]] });
      }
    }
  }
  return out;
}

type Span = { start: number; end: number };

/** Matching `<x-slot:name>` / `<x-slot name="...">` and `</x-slot>` tags, outside Megh code. */
function slotPairs(text: string, ranges: Range[]): Array<[Span, Span, number]> {
  const inMeghCode = (at: number) => ranges.some((r) => at >= r.start && at < r.end);
  const pairs: Array<[Span, Span, number]> = [];
  const open: Span[] = [];
  for (const m of text.matchAll(/<x-slot(?::[\w-]+|\s+name="[\w-]+")\s*>|<\/x-slot(?::[\w-]+)?\s*>/g)) {
    if (inMeghCode(m.index!)) continue;
    const span = { start: m.index!, end: m.index! + m[0].length };
    if (m[0][1] !== '/') open.push(span);
    else {
      const o = open.pop();
      if (o) pairs.push([o, span, pairs.length]);
    }
  }
  return pairs;
}

/** Offsets of <script>, <style>, <pre> and <textarea> bodies. */
function rawTextSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const m of text.matchAll(/<(script|style|pre|textarea)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const start = m.index! + m[0].indexOf('>') + 1;
    spans.push([start, start + m[2].length]);
  }
  return spans;
}
