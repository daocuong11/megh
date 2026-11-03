import { matchParen } from "./scan";
import { TemplateError } from "./errors";

export type Token =
  | { type: "text" | "echo" | "raw" | "code"; value: string; line: number }
  | { type: "directive"; name: string; args: string | null; line: number }
  | { type: "react"; value: string; args: string | null; line: number };

export type DirectiveToken = Extract<Token, { type: "directive" }>;

/**
 * Turns template source into a flat list of tokens:
 *   text       plain HTML
 *   echo       {{ expr }}   (escaped)
 *   raw        {!! expr !!} (not escaped)
 *   code       @js ... @endjs
 *   react      @react(props) ... @endreact (JSX, compiled separately)
 *   directive  @name or @name(args)
 * Every token carries the `line` it starts on, for error messages.
 *
 * A directive is only recognised when its name is registered (so `@media`
 * in CSS stays text) and when it is not glued to a word (so
 * `support@example.com` stays text). Blade has the same rule.
 */
export function tokenize(
  src: string,
  { name, directives }: { name: string; directives: Map<string, unknown> },
): Token[] {
  const tokens: Token[] = [];
  let text = "";
  let textLine = 1;
  let line = 1;
  let i = 0;

  const fail = (msg: string): never => {
    throw new TemplateError(msg, { template: name, line });
  };
  const pushText = () => {
    if (text) tokens.push({ type: "text", value: text, line: textLine });
    text = "";
  };
  // Move the cursor to `to`, counting newlines on the way.
  const advance = (to: number) => {
    for (let k = i; k < to; k++) if (src[k] === "\n") line++;
    i = to;
  };
  const find = (needle: string, from: number, what: string) => {
    const at = src.indexOf(needle, from);
    if (at === -1) fail(`Unclosed ${what}`);
    return at;
  };

  while (i < src.length) {
    if (!text) textLine = line;

    // Escapes: @{{ stays a literal "{{" (for Vue/Alpine), @@ is a literal "@".
    if (src.startsWith("@{{", i)) {
      text += "{{";
      advance(i + 3);
      continue;
    }
    if (src.startsWith("@@", i)) {
      text += "@";
      advance(i + 2);
      continue;
    }

    if (src.startsWith("{{--", i)) {
      const end = find("--}}", i + 4, "comment {{--");
      pushText();
      advance(end + 4);
      continue;
    }

    if (src.startsWith("{!!", i)) {
      const end = find("!!}", i + 3, "raw echo {!!");
      pushText();
      tokens.push({ type: "raw", value: src.slice(i + 3, end).trim(), line });
      advance(end + 3);
      continue;
    }

    if (src.startsWith("{{", i)) {
      const end = find("}}", i + 2, "echo {{");
      pushText();
      tokens.push({ type: "echo", value: src.slice(i + 2, end).trim(), line });
      advance(end + 2);
      continue;
    }

    if (
      src[i] === "@" &&
      /[A-Za-z]/.test(src[i + 1] ?? "") &&
      !/[\w.]/.test(src[i - 1] ?? "")
    ) {
      const dName = /^[A-Za-z]\w*/.exec(src.slice(i + 1, i + 65))![0];
      if (directives.has(dName)) {
        let end = i + 1 + dName.length;
        let args: string | null = null;
        let k = end;
        while (src[k] === " " || src[k] === "\t") k++;
        if (src[k] === "(") {
          const close = matchParen(src, k);
          if (close === -1) fail(`Unclosed ( after @${dName}`);
          args = src.slice(k + 1, close).trim();
          end = close + 1;
        }

        pushText();
        if (dName === "js" && args === null) {
          // Block form: everything up to @endjs is raw JavaScript.
          const stop = find("@endjs", end, "@js block (missing @endjs)");
          tokens.push({ type: "code", value: src.slice(end, stop), line });
          advance(stop + "@endjs".length);
        } else if (dName === "react") {
          // The body is JSX, where `{{ }}` is a style object, not an echo: capture it raw.
          const stop = find(
            "@endreact",
            end,
            "@react block (missing @endreact)",
          );
          tokens.push({
            type: "react",
            value: src.slice(end, stop),
            args,
            line,
          });
          advance(stop + "@endreact".length);
        } else {
          tokens.push({ type: "directive", name: dName, args, line });
          advance(end);
        }
        continue;
      }
    }

    text += src[i];
    advance(i + 1);
  }

  pushText();
  return tokens;
}
