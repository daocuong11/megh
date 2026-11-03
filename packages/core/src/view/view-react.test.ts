import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { afterAll, describe, expect, it } from "vitest";
import { TemplateError, ViewEngine, defaultReactImports } from "./index";

const engine = new ViewEngine({ root: "." });
const r = (src: string, data?: Record<string, unknown>) =>
  engine.renderString(src, data);

/** The inline module of the n-th island in `html`. */
const moduleOf = (html: string, n = 0) =>
  [...html.matchAll(/<script type="module">\n([\s\S]*?)<\/script>/g)][n][1];

describe("@react", () => {
  it("renders a mount point and a module that mounts App with the props", () => {
    const html = r(
      "<h1>{{ title }}</h1>\n@react({ todos })\n  function App({ todos }) {\n    return <p style={{ color: \"red\" }}>{todos.length}</p>;\n  }\n@endreact",
      { title: "Hi", todos: ["a", "b"] },
    );
    expect(html).toContain("<h1>Hi</h1>\n<div id=\"megh-react-0\"></div>");
    const mod = moduleOf(html);
    expect(mod).toContain(`from "${defaultReactImports["react-dom/client"]}"`);
    expect(mod).toContain(`from "${defaultReactImports["react/jsx-runtime"]}"`);
    // {{ }} inside JSX is a style object, not an echo.
    expect(mod).toMatch(/style: \{\s*color: "red"\s*\}/);
    expect(mod).toContain("const __meghProps = {\"todos\":[\"a\",\"b\"]};");
    expect(mod).toContain(
      "__meghCreateRoot(document.getElementById(\"megh-react-0\")).render(__meghH(App, __meghProps));",
    );
  });

  it("works without props, with TypeScript, and gives each island its own id", () => {
    const block =
      "@react\n  const App = ({ n = 1 }: { n?: number }) => <b>{n}</b>;\n@endreact";
    const html = r(`${block}\n${block}`);
    expect(html).toContain("<div id=\"megh-react-0\"></div>");
    expect(html).toContain("<div id=\"megh-react-1\"></div>");
    expect(moduleOf(html)).toContain("const __meghProps = {};");
    expect(moduleOf(html)).not.toContain(": number");
  });

  it("mounts the default export when there is one", () => {
    const mod = moduleOf(
      r(
        "@react\n  export default function Counter() { return <i />; }\n@endreact",
      ),
    );
    expect(mod).toContain("const __meghDefault = function Counter()");
    expect(mod).toContain("render(__meghH(__meghDefault, __meghProps))");
  });

  it("does not declare React twice when the block imports it", () => {
    const mod = moduleOf(
      r(
        "@react\n  import React from \"react\";\n  function App() { const [n] = React.useState(0); return <b>{n}</b>; }\n@endreact",
      ),
    );
    expect(mod.match(/import (\* as )?React\b/g)).toHaveLength(1);
  });

  it("keeps </script> in code and props from closing the tag", () => {
    const html = r(
      "@react({ s })\n  function App() { return <p>{\"</script>\"}</p>; }\n@endreact",
      { s: "</script><b>" },
    );
    const mod = moduleOf(html);
    expect(mod).not.toContain("</script>");
    expect(mod).toContain("\"<\\/script>\"");
    expect(mod).toContain("\"s\":\"\\u003c/script\\u003e\\u003cb\\u003e\"");
  });

  it("maps extra imports and leaves URLs alone", () => {
    const e = new ViewEngine({
      root: ".",
      react: { imports: { confetti: "https://cdn.example/confetti.js" } },
    });
    const mod = moduleOf(
      e.renderString(
        "@react\n  import confetti from \"confetti\";\n  import x from \"/static/x.js\";\n  const App = () => <p onClick={() => confetti(x)}>{\"sent from 'home'\"}</p>;\n@endreact",
      ),
    );
    expect(mod).toContain("from \"https://cdn.example/confetti.js\"");
    expect(mod).toContain("from \"/static/x.js\"");
    expect(mod).toContain("sent from 'home'");
  });

  it("reports errors with the template and line", () => {
    expect(() =>
      r(
        "x\n@react\n  import _ from \"lodash\";\n  const App = () => _.noop();\n@endreact",
      ),
    ).toThrow(/imports "lodash", which has no URL[\s\S]*\(inline:2\)/);
    expect(() => r("@react\n  const Thing = () => null;\n@endreact")).toThrow(
      /must define a component named App/,
    );
    expect(() => r("@react\n  const App = () => <p>;\n@endreact")).toThrow(
      TemplateError,
    );
    expect(() => r("@react\n  const App = () => null;")).toThrow(
      /missing @endreact/,
    );
    expect(() => r("@endreact")).toThrow(/@endreact without matching @react/);
  });

  describe("generated module", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "megh-react-"));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    // Fake react / react-dom that record what was mounted where.
    const write = (name: string, code: string) => {
      fs.writeFileSync(path.join(dir, name), code);
      return pathToFileURL(path.join(dir, name)).href;
    };
    const react = write(
      "react.mjs",
      "export const createElement = (type, props) => ({ type, props });\n" +
        "export const useState = (v) => [v, () => {}];",
    );
    const jsx = write(
      "jsx-runtime.mjs",
      "export const jsx = (type, props) => ({ type, props });\nexport const jsxs = jsx;",
    );
    const client = write(
      "client.mjs",
      "export const createRoot = (el) => ({ render: (tree) => globalThis.__mounted.push({ el, tree }) });",
    );

    it("runs in a module and mounts the component with its props", () => {
      const e = new ViewEngine({
        root: ".",
        react: {
          imports: {
            react,
            "react/jsx-runtime": jsx,
            "react-dom/client": client,
          },
        },
      });
      const html = e.renderString(
        "@react({ todos })\n  import { useState } from \"react\";\n  function App({ todos }) {\n    const [n] = useState(todos.length);\n    return <ul data-n={n}>{todos.map((t) => <li key={t}>{t}</li>)}</ul>;\n  }\n@endreact",
        { todos: ["a", "</script>"] },
      );
      const island = write("island.mjs", moduleOf(html));
      write(
        "entry.mjs",
        "globalThis.__mounted = [];\n" +
          "globalThis.document = { getElementById: (id) => ({ id }) };\n" +
          `await import(${JSON.stringify(island)});\n` +
          "const [{ el, tree }] = globalThis.__mounted;\n" +
          "const out = tree.type(tree.props);\n" +
          "console.log(JSON.stringify({ el, name: tree.type.name, props: tree.props, out }));",
      );

      const result = JSON.parse(
        execFileSync(process.execPath, [path.join(dir, "entry.mjs")], {
          encoding: "utf8",
        }),
      );
      expect(result.el).toEqual({ id: "megh-react-0" });
      expect(result.name).toBe("App");
      expect(result.props).toEqual({ todos: ["a", "</script>"] });
      expect(result.out.type).toBe("ul");
      expect(result.out.props["data-n"]).toBe(2);
      expect(
        result.out.props.children.map(
          (li: { props: { children: string } }) => li.props.children,
        ),
      ).toEqual(["a", "</script>"]);
    });
  });
});
