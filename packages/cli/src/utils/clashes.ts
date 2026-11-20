/**
 * A generated file can import a decorator from `@meghjs/core` with the same
 * name as one of its own classes: `make:config app` declares `AppConfig` and
 * imports the `@AppConfig` decorator; `make:resource post` imports the `Post`
 * model and the `@Post()` route decorator. The second name shadows the first,
 * and the file fails to load.
 *
 * For each such name used as a decorator, import it from `@meghjs/core` under
 * an alias (`AppConfig as MeghAppConfig`) and use the alias as the decorator
 * (`@MeghAppConfig`). Files without a clash are returned unchanged.
 */
export function resolveCoreNameClashes(source: string): string {
  const coreImport = /import\s*\{([^}]*)\}\s*from\s*(['"])@meghjs\/core\2/;
  const core = source.match(coreImport);
  if (!core) return source;

  // Names the file declares or imports from anywhere else.
  const local = new Set<string>();
  for (const m of source.matchAll(/^\s*(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
    local.add(m[1]);
  }
  for (const m of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g)) {
    if (m[3] === "@meghjs/core") continue;
    for (const spec of m[1].split(",")) {
      const name = spec.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop();
      if (name) local.add(name);
    }
  }

  const clashes = new Set<string>();
  const specifiers = core[1].split(",").map((spec) => {
    const trimmed = spec.trim();
    const name = trimmed.replace(/^type\s+/, "");
    if (!trimmed || /\sas\s/.test(name) || !local.has(name)) return trimmed;
    if (!new RegExp(`@${name}\\b`).test(source)) return trimmed;
    clashes.add(name);
    return `${trimmed} as Megh${name}`;
  });
  if (clashes.size === 0) return source;

  let out = source.replace(coreImport, (whole) => whole.replace(/\{[^}]*\}/, `{ ${specifiers.filter(Boolean).join(", ")} }`));
  for (const name of clashes) out = out.replace(new RegExp(`@${name}\\b`, "g"), `@Megh${name}`);
  return out;
}
