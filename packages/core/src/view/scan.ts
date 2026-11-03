/**
 * Small scanning helpers shared by the lexer and the directives. Directive
 * arguments can hold parentheses and strings (`@if(fn(a, ")"))`), so a regex
 * is not enough: these skip strings and track nesting depth.
 */

const QUOTES = "\"'`";

/** Index of the closing quote of the string that starts at `start`. */
export function skipString(src: string, start: number): number {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] === quote) return i;
  }
  return src.length;
}

/** Index of the `)` matching the `(` at `open`, ignoring parens in strings. -1 if none. */
export function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (QUOTES.includes(c)) {
      i = skipString(src, i);
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Splits `a, fn(b, c), { d: 1 }` on top-level commas. */
export function splitArgs(str: string | null | undefined): string[] {
  if (str == null) return [];
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (QUOTES.includes(c)) {
      i = skipString(str, i);
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(str.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = str.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}
