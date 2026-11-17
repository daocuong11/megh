import fs from "fs";
import path from "path";
import { log } from "../utils/log";
import { writeFileSafe } from "../utils/project";
import { renderStub } from "../utils/stubs";
import type { ResourceField } from "./resource";

/**
 * Unit tests written next to the files the generators create:
 * `src/services/user.service.ts` gets `src/services/user.service.spec.ts`,
 * which the app's Vitest config (`src/**\/*.spec.ts`) picks up.
 */

/** `src/services/user.service.ts` → `src/services/user.service.spec.ts`. */
export function specFileFor(file: string): string {
  return file.replace(/\.ts$/, ".spec.ts");
}

/** The import a spec next to `file` uses for it: `./user.service`. */
export function siblingImport(file: string): string {
  return "./" + path.basename(file).replace(/\.ts$/, "");
}

/**
 * Write a spec. An existing spec is kept unless `force`: it may hold tests
 * written since, and the file it tests was only just (re)generated.
 */
export function writeSpec(file: string, content: string, force: boolean | undefined, projectRoot: string): string | undefined {
  const rel = path.relative(projectRoot, file).split(path.sep).join("/");
  if (fs.existsSync(file) && !force) {
    log.info(`  Test exists, keeping: ${rel}`);
    return undefined;
  }
  writeFileSafe(file, content, true);
  log.success(`Test created: ${rel}`);
  return file;
}

// ── Sample values ─────────────────────────────────────────────────────────────

/** A value of a column's type, as TypeScript source, or undefined when none fits. */
export function sampleValue(field: Pick<ResourceField, "name" | "ts">): string | undefined {
  const ts = field.ts.trim();
  const literal = ts.match(/^(['"])(.*?)\1/);
  if (literal) return `'${literal[2]}'`;
  if (ts === "string") {
    if (/(^|_)email$/.test(field.name)) return "'user@example.com'";
    if (/(^|_)(url|link|website)$/.test(field.name)) return "'https://example.com'";
    return `'${field.name.replace(/_/g, " ")}'`;
  }
  if (ts === "number") return "1";
  if (ts === "boolean") return "true";
  if (ts === "Date") return "new Date('2026-01-01T00:00:00.000Z')";
  if (ts === "Buffer") return "Buffer.from('')";
  if (/\[\]$|^Array</.test(ts)) return "[]";
  if (/^(Record<|\{|object$)/.test(ts)) return "{}";
  return undefined;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * An object literal of `[key, value source]` pairs, one per line, with the
 * closing brace at `indent`; `{}` when there are none.
 */
export function objectLiteral(entries: Array<[string, string]>, indent: string): string {
  if (entries.length === 0) return "{}";
  const lines = entries.map(([k, v]) => `${indent}  ${IDENTIFIER.test(k) ? k : `'${k}'`}: ${v},`);
  return `{\n${lines.join("\n")}\n${indent}}`;
}

/** Sample values for the columns a client sends. */
function sampleEntries(fields: ResourceField[]): Array<[string, string]> {
  return fields.flatMap((f) => {
    const v = sampleValue(f);
    return v === undefined ? [] : [[f.name, v] as [string, string]];
  });
}

/** `a user`, `an article`. */
const withArticle = (word: string) => (/^[aeiou]/i.test(word) ? 'an ' : 'a ') + word;

/** The id the tests use, typed like the primary key. */
const sampleId = (primaryKeyType: string) => (primaryKeyType === "number" ? "1" : "'1'");

// ── Resource specs ────────────────────────────────────────────────────────────

export type ModelServiceSpec = {
  ClassName: string;
  serviceFile: string;
  Model: string;
  modelVar: string;
  modelFile: string;
  primaryKey: string;
  primaryKeyType: string;
  fields: ResourceField[];
};

/** Tests for a Megh ORM resource service (`services/model-service.stub`). */
export function renderModelServiceSpec(s: ModelServiceSpec): string {
  const specFile = specFileFor(s.serviceFile);
  const entries = sampleEntries(s.fields);
  // Update one column, and send another as undefined to show it is skipped.
  const [first, second] = entries;
  const changes: Array<[string, string]> = first ? [first] : [];
  if (second) changes.push([second[0], "undefined"]);
  const updateTitle = !first
    ? "saves the changes"
    : second
      ? "changes the columns sent and skips undefined ones"
      : "changes the columns sent";
  return renderStub("tests/model-service.spec.stub", {
    ClassName: s.ClassName,
    import: siblingImport(s.serviceFile),
    Model: s.Model,
    modelVar: s.modelVar,
    aModel: withArticle(s.modelVar),
    modelImport: relativeImport(specFile, s.modelFile),
    primaryKey: s.primaryKey,
    id: sampleId(s.primaryKeyType),
    input: objectLiteral(entries, "      "),
    changes: objectLiteral(changes, "      "),
    sent: objectLiteral(first ? [first] : [], "      "),
    updateTitle,
  });
}

export type ModelControllerSpec = {
  ClassName: string;
  controllerFile: string;
  dtoFile: string;
  Model: string;
  Plural: string;
  modelVar: string;
  ServiceClass: string;
  serviceVar: string;
  route: string;
  primaryKey: string;
  /** The type of the `id` route parameter. */
  idType: string;
  fields: ResourceField[];
};

/** Tests for a Megh ORM resource controller (`controllers/model-controller.stub`). */
export function renderModelControllerSpec(s: ModelControllerSpec): string {
  const specFile = specFileFor(s.controllerFile);
  const entries = sampleEntries(s.fields);
  return renderStub("tests/model-controller.spec.stub", {
    ClassName: s.ClassName,
    import: siblingImport(s.controllerFile),
    dtoImport: relativeImport(specFile, s.dtoFile),
    Model: s.Model,
    Plural: s.Plural,
    plural: s.route.split("/").pop()!.replace(/-/g, " "),
    modelVar: s.modelVar,
    aModel: withArticle(s.modelVar),
    ServiceClass: s.ServiceClass,
    serviceVar: s.serviceVar,
    route: s.route,
    primaryKey: s.primaryKey,
    id: sampleId(s.idType),
    input: objectLiteral(entries, "    "),
    changes: objectLiteral(entries.slice(0, 1), "    "),
  });
}

export type TypeormServiceSpec = {
  ClassName: string;
  serviceFile: string;
  Model: string;
  modelVar: string;
  modelFile: string;
  fields: ResourceField[];
};

/** Tests for a TypeORM repository service (`services/orm-rest-service.stub`). */
export function renderTypeormServiceSpec(s: TypeormServiceSpec): string {
  return renderStub("tests/orm-rest-service.spec.stub", {
    ClassName: s.ClassName,
    import: siblingImport(s.serviceFile),
    Model: s.Model,
    modelVar: s.modelVar,
    aModel: withArticle(s.modelVar),
    modelImport: relativeImport(specFileFor(s.serviceFile), s.modelFile),
    input: objectLiteral(sampleEntries(s.fields), "    "),
  });
}

export type ResourceControllerSpec = {
  ClassName: string;
  controllerFile: string;
  Model: string;
  modelVar: string;
  ServiceClass: string;
  serviceVar: string;
  route: string;
  fields: ResourceField[];
};

/** Tests for a TypeORM resource controller (`controllers/resource-controller.stub`). */
export function renderResourceControllerSpec(s: ResourceControllerSpec): string {
  return renderStub("tests/resource-controller.spec.stub", {
    ClassName: s.ClassName,
    import: siblingImport(s.controllerFile),
    Model: s.Model,
    modelVar: s.modelVar,
    aModel: withArticle(s.modelVar),
    ServiceClass: s.ServiceClass,
    serviceVar: s.serviceVar,
    route: s.route,
    input: objectLiteral(sampleEntries(s.fields), "    "),
  });
}

// ── Other specs ───────────────────────────────────────────────────────────────

/** A spec from `stubs/tests/<stub>.spec.stub` for the class in `file`. */
export function renderSpec(stub: string, file: string, vars: Record<string, string>): string {
  return renderStub(`tests/${stub}.spec.stub`, { import: siblingImport(file), ...vars });
}

/** Tests for a listener; `event` is the event class it handles and where it lives. */
export function renderListenerSpec(ClassName: string, file: string, event?: { className: string; file: string }): string {
  if (event) {
    return renderSpec("listener", file, {
      ClassName,
      EventClass: event.className,
      Imports:
        "import { MeghTest } from '@meghjs/core';\n" +
        `import { ${event.className} } from '${relativeImport(specFileFor(file), event.file)}';`,
      EventDeclaration: "",
    });
  }
  return renderSpec("listener", file, {
    ClassName,
    EventClass: "TestEvent",
    Imports: "import { MeghEvent, MeghTest } from '@meghjs/core';",
    EventDeclaration:
      "\n/** A stand-in event. Once the listener has its own event, test with that instead. */\n" +
      "class TestEvent extends MeghEvent<{ id: number }> {}\n",
  });
}

/** `make:test` with nothing to test yet: a spec to start from. */
export function renderBlankSpec(title: string): string {
  return renderStub("tests/blank.spec.stub", { Title: title });
}

/** How `make:test` builds an instance of each kind of class. */
const DI_KINDS = new Set(["service", "middleware", "listener", "config", "task", "worker"]);

/**
 * `make:test` for a file it doesn't recognise as generated: create the
 * class (from the container, for injectable kinds) and check it exists, with
 * a todo for each public method. Exported functions get a todo each.
 */
export function renderGenericSpec(file: string, source: string, kind?: string): string {
  const imports = ["describe", "expect", "it"];
  const className = source.match(/export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/)?.[1];
  const abstract = className && new RegExp(`export\\s+(?:default\\s+)?abstract\\s+class\\s+${className}\\b`).test(source);
  const lines: string[] = [];
  const core: string[] = [];

  if (className && !abstract) {
    const methods = publicMethods(source, className);
    let create: string;
    if (kind === "controller") {
      core.push("MeghTest");
      create = `MeghTest.getController(${className})`;
    } else if (kind && DI_KINDS.has(kind)) {
      core.push("MeghTest");
      create = `MeghTest.getProvider(${className})`;
    } else if (kind === "event") {
      create = `new ${className}({} as never)`;
    } else {
      create = `new ${className}()`;
    }
    const instance = className[0].toLowerCase() + className.slice(1);
    lines.push(
      `describe('${className}', () => {`,
      `  const ${instance} = ${create};`,
      "",
      "  it('should be defined', () => {",
      `    expect(${instance}).toBeDefined();`,
      "  });",
      ...methods.map((m) => `\n  it.todo('${m}()');`),
      "});",
    );
    return header(imports, core, `import { ${className} } from '${siblingImport(file)}';`) + lines.join("\n") + "\n";
  }

  // Nothing to create: a todo for each exported function, or for the abstract class.
  const functions = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => `${m[1]}()`);
  const todos = className ? [`${className} (abstract: test a subclass of it)`] : functions;
  const title = className ?? path.basename(file).replace(/\.ts$/, "");
  if (todos.length === 0) return renderBlankSpec(title);
  lines.push(`describe('${title}', () => {`, todos.map((t) => `  it.todo('${t}');`).join("\n\n"), "});");
  return header(["describe", "it"], [], "") + lines.join("\n") + "\n";
}

function header(vitest: string[], core: string[], importLine: string): string {
  return (
    `import { ${vitest.join(", ")} } from 'vitest';\n` +
    (core.length ? `import { ${core.join(", ")} } from '@meghjs/core';\n` : "") +
    (importLine ? importLine + "\n" : "") +
    "\n"
  );
}

/** Names of the public instance methods declared in class `className`. */
function publicMethods(source: string, className: string): string[] {
  const start = source.search(new RegExp(`class\\s+${className}\\b`));
  if (start === -1) return [];
  const body = source.slice(start);
  const names = new Set<string>();
  const re = /^ {2}(?:public\s+)?(?:async\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/gm;
  const skip = new Set(["constructor", "if", "for", "while", "switch", "return", "catch", "function"]);
  for (const m of body.matchAll(re)) {
    if (!skip.has(m[1])) names.add(m[1]);
  }
  return [...names];
}

/** A relative module specifier from `fromFile` to `toFile` (without extension), always using `/`. */
export function relativeImport(fromFile: string, toFile: string): string {
  let rel = path.relative(path.dirname(fromFile), toFile).replace(/\.ts$/, "").split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}
