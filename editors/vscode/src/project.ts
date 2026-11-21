import * as path from 'node:path';
import { componentProps, EXTENSION } from './components';
import { scanMegh } from './mask';

export type SourceFile = { path: string; text: string };

/** Where a view variable comes from, for completion details and hovers. */
export type VariableSource = { detail: string; file?: string; line?: number };

/**
 * What a views folder and the app code around it say about template data:
 * which variables each view receives, which views exist, and which
 * properties templates read from each variable.
 *
 * - `view('todos.show', { todo, errors })`, `Results.View(...)` and
 *   `render(...)` calls in the app code give each view its variables.
 * - `.share('appName', ...)` gives every page, layout and include a variable.
 * - A layout or partial gets the variables of the views that extend or
 *   include it. A component gets only its props and slots, as at runtime.
 */
export class ProjectIndex {
  /** view name -> variable -> source */
  private viewData = new Map<string, Map<string, VariableSource>>();
  private shared = new Map<string, VariableSource>();
  /** view name -> views that @extends or @include it */
  private users = new Map<string, Set<string>>();
  /** variable name -> properties read from it in templates */
  private members = new Map<string, Set<string>>();
  private views = new Set<string>();
  private sections = new Set<string>();
  readonly templates = new Map<string, string>();

  constructor(
    readonly root: string,
    templates: SourceFile[],
    code: SourceFile[] = [],
  ) {
    for (const t of templates) {
      const name = this.viewName(t.path);
      if (!name) continue;
      this.views.add(name);
      this.templates.set(name, t.text);
      this.indexTemplate(name, t.text);
    }
    for (const c of code) this.indexCode(c);
  }

  /** `<root>/todos/show.megh.html` -> `todos.show`. */
  viewName(file: string): string | undefined {
    const rel = path.relative(this.root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !rel.endsWith(EXTENSION)) return undefined;
    return rel.slice(0, -EXTENSION.length).split(path.sep).join('.');
  }

  viewNames() {
    return [...this.views].sort();
  }

  componentNames() {
    return this.viewNames()
      .filter((v) => v.startsWith('components.'))
      .map((v) => v.slice('components.'.length));
  }

  sectionNames() {
    return [...this.sections].sort();
  }

  /** Variables a view can read, with where each comes from. */
  variablesFor(view: string): Map<string, VariableSource> {
    const out = new Map<string, VariableSource>();
    if (view.startsWith('components.')) {
      const source = this.templates.get(view) ?? '';
      for (const p of componentProps(source)) out.set(p, { detail: 'component prop' });
      out.set('slot', { detail: 'component body (default slot)' });
      return out;
    }
    const seen = new Set<string>();
    const visit = (v: string) => {
      if (seen.has(v)) return;
      seen.add(v);
      for (const [k, s] of this.viewData.get(v) ?? []) if (!out.has(k)) out.set(k, s);
      for (const user of this.users.get(v) ?? []) visit(user);
    };
    visit(view);
    for (const [k, s] of this.shared) if (!out.has(k)) out.set(k, s);
    return out;
  }

  /** Properties templates read from `name` (`todo.title` -> title). */
  membersOf(name: string): string[] {
    return [...(this.members.get(name) ?? [])].sort();
  }

  private indexTemplate(name: string, text: string) {
    for (const r of scanMegh(text)) {
      const inner =
        r.innerStart !== undefined ? text.slice(r.innerStart, Math.min(r.innerEnd!, text.length)) : '';
      if (r.kind === 'directive' && (r.name === 'extends' || r.name === 'include')) {
        const target = /^\s*(['"`])([\w./-]+)\1/.exec(inner)?.[2];
        if (target) {
          const set = this.users.get(target) ?? new Set();
          set.add(name);
          this.users.set(target, set);
        }
      }
      if (r.kind === 'directive' && ['section', 'yield'].includes(r.name!)) {
        const section = /^\s*(['"`])([\w.-]+)\1/.exec(inner)?.[2];
        if (section) this.sections.add(section);
      }
      if (r.kind === 'echo' || r.kind === 'raw' || (r.kind === 'directive' && inner)) {
        const code = inner.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
        for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\??\.([A-Za-z_$][\w$]*)/g)) {
          const set = this.members.get(m[1]) ?? new Set();
          set.add(m[2]);
          this.members.set(m[1], set);
        }
      }
    }
  }

  private indexCode(file: SourceFile) {
    const text = file.text;
    const rel = path.basename(file.path);
    const lineAt = (offset: number) => text.slice(0, offset).split('\n').length;

    const call = /\b(?:view|View|render)\s*\(\s*(['"`])([\w./-]+)\1\s*,\s*\{/g;
    for (const m of text.matchAll(call)) {
      const view = m[2].replace(/\//g, '.');
      const open = m.index! + m[0].length - 1;
      const keys = objectKeys(text, open);
      const data = this.viewData.get(view) ?? new Map<string, VariableSource>();
      const line = lineAt(m.index!);
      for (const k of keys) {
        if (!data.has(k)) data.set(k, { detail: `view data, ${rel}:${line}`, file: file.path, line });
      }
      this.viewData.set(view, data);
    }
    for (const m of text.matchAll(/\.share\(\s*(['"`])([A-Za-z_$][\w$]*)\1/g)) {
      const line = lineAt(m.index!);
      this.shared.set(m[2], { detail: `shared, ${rel}:${line}`, file: file.path, line });
    }
  }
}

/** Top-level keys of the object literal whose `{` is at `open`. */
export function objectKeys(text: string, open: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectKey = true;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i++;
        i++;
      }
      if (depth === 1 && expectKey && /^\s*:/.test(text.slice(i + 1))) {
        keys.push(text.slice(start + 1, i));
        expectKey = false;
      }
      continue;
    }
    if ('{[('.includes(c)) {
      depth++;
      continue;
    }
    if ('}])'.includes(c)) {
      if (--depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;
    if (c === ',') {
      expectKey = true;
      continue;
    }
    if (expectKey && /[A-Za-z_$]/.test(c)) {
      const m = /^([A-Za-z_$][\w$]*)\s*(:|,|\}|\()?/.exec(text.slice(i));
      if (m && m[2] !== '(' && !/^\.\.\./.test(text.slice(i - 3, i))) keys.push(m[1]);
      expectKey = false;
      i += (m?.[1].length ?? 1) - 1;
    } else if (expectKey && c === '.') {
      // ...spread: skip.
      expectKey = false;
    }
  }
  return keys;
}
