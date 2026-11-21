import { TemplateError } from "./errors";

/**
 * Where the browser loads each bare import from, like an import map. Megh
 * rewrites these specifiers in `@react` blocks, so the page needs no
 * `<script type="importmap">`. Add entries for other packages your
 * components import, or point React at self-hosted files.
 */
export type ReactImports = Record<string, string>;

const REACT_VERSION = "19.1.0";

export const defaultReactImports: Readonly<ReactImports> = {
  react: `https://esm.sh/react@${REACT_VERSION}`,
  "react/jsx-runtime": `https://esm.sh/react@${REACT_VERSION}/jsx-runtime`,
  "react-dom": `https://esm.sh/react-dom@${REACT_VERSION}?deps=react@${REACT_VERSION}`,
  "react-dom/client": `https://esm.sh/react-dom@${REACT_VERSION}/client?deps=react@${REACT_VERSION}`,
};

type Swc = typeof import("@swc/core");
let swc: Swc | undefined;

/** `@swc/core` is an optional peer: load it from the app first, then from Megh. */
function loadSwc(template: string, line: number): Swc {
  if (swc) return swc;
  try {
    swc = require(require.resolve("@swc/core", { paths: [process.cwd()] }));
  } catch {
    try {
      swc = require("@swc/core");
    } catch {
      throw new TemplateError(
        "@react needs @swc/core to compile JSX. Run: npm install @swc/core",
        { template, line },
      );
    }
  }
  return swc!;
}

/** Static `import ... from "x"`, `import "x"` and `export ... from "x"` statements. */
const STATIC_SPECIFIER =
  /^([ \t]*(?:import|export)\b[^;\n]*?\bfrom\s*|[ \t]*import\s*)(["'])([^"'\n]+)\2/gm;
/** Dynamic `import("x")`. */
const DYNAMIC_SPECIFIER = /(\bimport\(\s*)(["'])([^"'\n]+)\2/g;
const IMPORTS_REACT_BINDING =
  /\bimport\s+(?:React\b|\*\s+as\s+React\b|[^;]*\{[^}]*\bas\s+React\b)/;
const EXPORT_DEFAULT = /\bexport\s+default\s+/;
const DEFINES_APP = /\b(?:function|class|const|let|var)\s+App\b/;

export type CompiledReactIsland = {
  /** The module code: imports plus the block's compiled code. */
  head: string;
  /** The component to mount: `App` or the default export. */
  target: string;
};

/**
 * Compiles the body of an `@react` block into an ES module. The block must
 * define a component named `App` or `export default` one; it is mounted with
 * the block's props:
 *
 *   @react({ todos })
 *     function App({ todos }) { return <p>{todos.length}</p>; }
 *   @endreact
 */
export function compileReactIsland(
  body: string,
  {
    template,
    line,
    imports,
  }: { template: string; line: number; imports: ReactImports },
): CompiledReactIsland {
  const hasDefault = EXPORT_DEFAULT.test(body);
  if (!hasDefault && !DEFINES_APP.test(body)) {
    throw new TemplateError(
      "@react block must define a component named App or `export default` one",
      { template, line },
    );
  }

  let code: string;
  try {
    code = loadSwc(template, line).transformSync(body, {
      filename: `${template}.tsx`,
      swcrc: false,
      configFile: false,
      sourceMaps: false,
      isModule: true,
      jsc: {
        parser: { syntax: "typescript", tsx: true },
        target: "es2020",
        transform: { react: { runtime: "automatic" } },
      },
    }).code;
  } catch (err) {
    if (err instanceof TemplateError) throw err;
    throw new TemplateError(
      `Invalid code in @react block: ${(err as Error)?.message ?? err}`,
      { template, line, cause: err },
    );
  }

  // `export default X` is not reachable from the inline module itself, so bind it.
  const target = hasDefault ? "__meghDefault" : "App";
  if (hasDefault) code = code.replace(EXPORT_DEFAULT, "const __meghDefault = ");

  // Blocks may use `React.useState` without importing React.
  const prelude =
    (IMPORTS_REACT_BINDING.test(code)
      ? ""
      : "import * as React from \"react\";\n") +
    "import { createElement as __meghH } from \"react\";\n" +
    "import { createRoot as __meghCreateRoot } from \"react-dom/client\";\n";

  const head = rewriteImports(prelude + code, imports, template, line);
  return { head: escapeScript(head), target };
}

/**
 * Points bare specifiers at their URLs, like an import map would. Relative and
 * absolute URLs are left alone; an unknown bare specifier in a static import
 * is an error, since the browser could not load it.
 */
function rewriteImports(
  code: string,
  imports: ReactImports,
  template: string,
  line: number,
) {
  const isUrl = (spec: string) =>
    /^(?:[a-z][a-z\d+.-]*:|\/|\.\.?\/)/i.test(spec);
  return code
    .replace(
      STATIC_SPECIFIER,
      (match, lead: string, q: string, spec: string) => {
        if (imports[spec]) return `${lead}${q}${imports[spec]}${q}`;
        if (isUrl(spec)) return match;
        throw new TemplateError(
          `@react block imports "${spec}", which has no URL. Add it to useViews({ react: { imports } })`,
          { template, line },
        );
      },
    )
    .replace(
      DYNAMIC_SPECIFIER,
      (match, lead: string, q: string, spec: string) =>
        imports[spec] ? `${lead}${q}${imports[spec]}${q}` : match,
    );
}

/** Keeps `</script>` inside JS strings from closing the inline <script> tag. */
function escapeScript(code: string) {
  return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}
