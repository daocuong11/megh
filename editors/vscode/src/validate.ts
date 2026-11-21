/**
 * Problems in a Megh template, found without rendering it:
 * - Megh structure (errors, the engine would throw): unclosed `{{`, `{!!`,
 *   `{{--` or directive arguments; `@if` without `@endif`; `@endif` without
 *   `@if`; blocks closed in the wrong order; `@else` outside `@if`.
 * - HTML (warnings, browsers are forgiving): unclosed and stray tags,
 *   duplicate attributes, `<x-...>` tags with no component file.
 *
 * Tags opened in one `@if`/`@else` branch and closed after `@endif` are
 * understood: each branch starts from the tags open at `@if`.
 */
import { getLanguageService, TokenType } from 'vscode-html-languageservice';
import { BLOCKS, BRANCHES, CLOSERS, opensBlock } from './directives';
import { maskMegh, Range } from './mask';

export type Problem = {
  start: number;
  end: number;
  message: string;
  severity: 'error' | 'warning';
};

export type ValidateOptions = {
  /** Known component names (`alert`, `forms.input`); unset: do not check. */
  components?: Set<string>;
  html?: boolean;
};

const html = getLanguageService();

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
  'track', 'wbr', 'keygen', 'command',
]);
// End tag may be left out (HTML spec, "optional tags").
const OPTIONAL_END = new Set([
  'html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th',
  'thead', 'tbody', 'tfoot', 'colgroup', 'caption', 'rt', 'rp',
]);

type Tag = { name: string; start: number; end: number };
type Event =
  | { at: number; type: 'open'; tag: Tag }
  | { at: number; type: 'close'; tag: Tag }
  | { at: number; type: 'megh'; range: Range };

export function validate(text: string, options: ValidateOptions = {}): Problem[] {
  const problems: Problem[] = [];
  const { masked, ranges } = maskMegh(text);
  const line = (offset: number) => text.slice(0, offset).split('\n').length;

  // ---- unclosed Megh constructs ----
  for (const r of ranges) {
    if (r.end <= text.length) continue;
    const what =
      r.kind === 'echo' ? '`{{` is not closed with `}}`'
      : r.kind === 'raw' ? '`{!!` is not closed with `!!}`'
      : r.kind === 'comment' ? '`{{--` is not closed with `--}}`'
      : r.kind === 'block' ? `\`@${r.name}\` is not closed with \`@end${r.name}\``
      : `\`@${r.name}(\` is missing its closing \`)\``;
    const head = r.kind === 'directive' || r.kind === 'block' ? 1 + r.name!.length : r.kind === 'raw' ? 3 : r.kind === 'comment' ? 4 : 2;
    problems.push({ start: r.start, end: r.start + head, message: what, severity: 'error' });
  }

  // An unclosed construct swallows the rest of the file; block errors after it would be noise.
  const unclosed = problems.length > 0;

  // ---- events in document order ----
  const events: Event[] = [];
  if (!unclosed) for (const r of ranges) if (r.kind === 'directive') events.push({ at: r.start, type: 'megh', range: r });

  if (options.html !== false) {
    const scanner = html.createScanner(masked);
    let token = scanner.scan();
    let current: Tag | null = null;
    let closing: Tag | null = null;
    let attrs = new Set<string>();
    while (token !== TokenType.EOS) {
      switch (token) {
        case TokenType.StartTag:
          current = { name: tagName(scanner.getTokenText()), start: scanner.getTokenOffset(), end: scanner.getTokenEnd() };
          attrs = new Set();
          if (options.components && current.name.startsWith('x-') && !current.name.startsWith('x-slot')) {
            const name = current.name.slice(2);
            if (!options.components.has(name)) {
              problems.push({
                start: current.start,
                end: current.end,
                message: `No component file for <${current.name}>: expected components/${name.replace(/\./g, '/')}.megh.html`,
                severity: 'warning',
              });
            }
          }
          break;
        case TokenType.AttributeName: {
          const name = scanner.getTokenText().toLowerCase();
          if (current && attrs.has(name)) {
            problems.push({
              start: scanner.getTokenOffset(),
              end: scanner.getTokenEnd(),
              message: `Duplicate attribute "${name}" on <${current.name}>`,
              severity: 'warning',
            });
          }
          attrs.add(name);
          break;
        }
        case TokenType.StartTagClose:
          if (current && !VOID.has(current.name)) events.push({ at: current.start, type: 'open', tag: current });
          current = null;
          break;
        case TokenType.StartTagSelfClose:
          current = null;
          break;
        case TokenType.EndTag:
          closing = { name: tagName(scanner.getTokenText()), start: scanner.getTokenOffset() - 2, end: scanner.getTokenEnd() };
          break;
        case TokenType.EndTagClose:
          if (closing) events.push({ at: closing.start, type: 'close', tag: closing });
          closing = null;
          break;
      }
      token = scanner.scan();
    }
  }
  events.sort((a, b) => a.at - b.at);

  // ---- walk: Megh blocks and HTML tags ----
  type Frame = { range: Range; snapshot: Tag[]; firstBranch?: Tag[] };
  const blocks: Frame[] = [];
  let tags: Tag[] = [];
  const unclosedTag = (t: Tag) =>
    problems.push({ start: t.start, end: t.end, message: `<${t.name}> is not closed`, severity: 'warning' });

  for (const ev of events) {
    if (ev.type === 'open') {
      tags.push(ev.tag);
    } else if (ev.type === 'close') {
      if (VOID.has(ev.tag.name)) continue;
      const at = findLast(tags, ev.tag.name);
      if (at === -1) {
        problems.push({
          start: ev.tag.start,
          end: ev.tag.end + 1,
          message: `</${ev.tag.name}> has no matching <${ev.tag.name}>`,
          severity: 'warning',
        });
        continue;
      }
      for (const t of tags.slice(at + 1)) if (!OPTIONAL_END.has(t.name)) unclosedTag(t);
      tags = tags.slice(0, at);
    } else {
      const r = ev.range;
      const name = r.name!;
      const args = r.innerStart !== undefined ? text.slice(r.innerStart, Math.min(r.innerEnd!, text.length)) : undefined;
      const head = { start: r.start, end: r.start + 1 + name.length };
      if (opensBlock(name, args)) {
        blocks.push({ range: r, snapshot: [...tags] });
      } else if (name in BRANCHES) {
        const top = blocks[blocks.length - 1];
        if (!top || !BRANCHES[name].includes(top.range.name!)) {
          problems.push({ ...head, message: `@${name} outside ${BRANCHES[name].map((b) => '@' + b).join(', ').replace(/, ([^,]*)$/, ' or $1')}`, severity: 'error' });
          continue;
        }
        if (!top.firstBranch) top.firstBranch = tags;
        tags = [...top.snapshot];
      } else if (CLOSERS.has(name)) {
        const opener = Object.keys(BLOCKS).filter((b) => BLOCKS[b].includes(name));
        const top = blocks[blocks.length - 1];
        if (!top) {
          problems.push({ ...head, message: `@${name} without ${opener.map((b) => '@' + b).join(' or ')}`, severity: 'error' });
          continue;
        }
        if (!BLOCKS[top.range.name!].includes(name)) {
          const at = findLastIndex(blocks, (b) => BLOCKS[b.range.name!].includes(name));
          problems.push({
            ...head,
            message: `@${name} found, but @${top.range.name} (line ${line(top.range.start)}) is still open: close it with @${BLOCKS[top.range.name!][0]} first`,
            severity: 'error',
          });
          if (at === -1) continue;
          blocks.splice(at + 1);
        }
        const frame = blocks.pop()!;
        if (frame.firstBranch) tags = frame.firstBranch;
      }
    }
  }

  for (const b of blocks) {
    problems.push({
      start: b.range.start,
      end: b.range.start + 1 + b.range.name!.length,
      message: `@${b.range.name} is not closed with @${BLOCKS[b.range.name!][0]}`,
      severity: 'error',
    });
  }
  for (const t of tags) if (!OPTIONAL_END.has(t.name)) unclosedTag(t);

  return problems.sort((a, b) => a.start - b.start);
}

/** `<x-slot:title>` is closed by `</x-slot>`. */
const tagName = (raw: string) => {
  const name = raw.toLowerCase();
  return name.startsWith('x-slot') ? 'x-slot' : name;
};

function findLast(tags: Tag[], name: string) {
  for (let i = tags.length - 1; i >= 0; i--) if (tags[i].name === name) return i;
  return -1;
}

function findLastIndex<T>(list: T[], fn: (t: T) => boolean) {
  for (let i = list.length - 1; i >= 0; i--) if (fn(list[i])) return i;
  return -1;
}
