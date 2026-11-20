/**
 * Find Megh syntax in a template and blank it out so an HTML parser sees
 * plain HTML.
 *
 * Every Megh construct ({{ }}, {!! !!}, {{-- --}}, @directive(args),
 * @js ... @endjs, @react ... @endreact) is replaced with spaces of the same
 * length, newlines kept, so offsets and line/column positions are unchanged.
 * The returned ranges say where Megh code was and what it is.
 */
export type MeghKind = 'echo' | 'raw' | 'comment' | 'directive' | 'block' | 'escape';

export type Range = {
  start: number;
  /** Exclusive. `text.length + 1` when the construct is not closed. */
  end: number;
  kind: MeghKind;
  /** Directive name, for `directive` and `block` (`js`, `react`). */
  name?: string;
  /** Where the code inside starts and ends: echo contents, directive args. */
  innerStart?: number;
  innerEnd?: number;
};

export function scanMegh(text: string): Range[] {
  const ranges: Range[] = [];
  let i = 0;
  const n = text.length;

  /** Index of `close` at or after `from`, or -1. */
  const find = (from: number, close: string) => text.indexOf(close, from);

  /** Index of the `)` matching the `(` at `open`, skipping JS strings; -1 if none. */
  const matchParen = (open: number) => {
    let depth = 0;
    for (let j = open; j < n; j++) {
      const c = text[j];
      if (c === '"' || c === "'" || c === '`') {
        j++;
        while (j < n && text[j] !== c) {
          if (text[j] === '\\') j++;
          j++;
        }
      } else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return j;
    }
    return -1;
  };

  const delimited = (kind: MeghKind, open: string, close: string) => {
    const at = find(i + open.length, close);
    ranges.push({
      kind,
      start: i,
      end: at === -1 ? n + 1 : at + close.length,
      innerStart: i + open.length,
      innerEnd: at === -1 ? n : at,
    });
    i = at === -1 ? n : at + close.length;
  };

  while (i < n) {
    const c = text[i];
    if (c === '{' && text.startsWith('{{--', i)) delimited('comment', '{{--', '--}}');
    else if (c === '{' && text.startsWith('{!!', i)) delimited('raw', '{!!', '!!}');
    else if (c === '{' && text.startsWith('{{', i)) delimited('echo', '{{', '}}');
    else if (c === '@' && !/[\w@.]/.test(text[i - 1] ?? '')) {
      if (text.startsWith('@{{', i) || text.startsWith('@@', i)) {
        const len = text[i + 1] === '@' ? 2 : 3;
        ranges.push({ kind: 'escape', start: i, end: i + len });
        i += len;
        continue;
      }
      const m = /^@([A-Za-z_]\w*)/.exec(text.slice(i, i + 64));
      if (!m) {
        i++;
        continue;
      }
      const name = m[1];
      let end = i + m[0].length;
      let innerStart: number | undefined;
      let innerEnd: number | undefined;
      // @js(const x = 1) is one line; @js ... @endjs and @react(...) ... @endreact are blocks.
      const inlineJs = name === 'js' && /^\s*\(/.test(text.slice(end, end + 64));
      if (name === 'react' || (name === 'js' && !inlineJs)) {
        const close = `@end${name}`;
        const at = find(end, close);
        innerStart = end;
        innerEnd = at === -1 ? n : at;
        end = at === -1 ? n + 1 : at + close.length;
        ranges.push({ kind: 'block', name, start: i, end, innerStart, innerEnd });
        i = Math.min(end, n);
        continue;
      }
      // @name(args), allowing spaces before "(" like the engine does.
      let k = end;
      while (text[k] === ' ' || text[k] === '\t') k++;
      if (text[k] === '(') {
        const close = matchParen(k);
        innerStart = k + 1;
        innerEnd = close === -1 ? n : close;
        end = close === -1 ? n + 1 : close + 1;
      }
      ranges.push({ kind: 'directive', name, start: i, end, innerStart, innerEnd });
      i = Math.min(end, n);
    } else i++;
  }
  return ranges;
}

export function maskMegh(text: string): { masked: string; ranges: Range[] } {
  const ranges = scanMegh(text);
  if (!ranges.length) return { masked: text, ranges };
  let masked = '';
  let last = 0;
  for (const r of ranges) {
    const end = Math.min(r.end, text.length);
    masked += text.slice(last, r.start) + text.slice(r.start, end).replace(/[^\n\r]/g, ' ');
    last = end;
  }
  return { masked: masked + text.slice(last), ranges };
}

/** The Megh range the cursor is inside (not at its edges), if any. */
export function meghAt(ranges: Range[], offset: number): Range | undefined {
  return ranges.find((r) => offset > r.start && offset < r.end);
}

/** True when `offset` is inside Megh code (not at its edges). */
export function inMegh(ranges: Range[], offset: number) {
  return meghAt(ranges, offset) !== undefined;
}
