import fs from "fs";
import path from "path";
import { CliError } from "../errors";
import { log } from "../utils/log";
import { kebabCase, pascalCase, resolveName, snakeCase, type ResolvedName } from "../utils/names";
import { installedVersion, requireProjectRoot, writeFileSafe } from "../utils/project";
import { trackWrite } from "../utils/changes";
import { renderStub } from "../utils/stubs";
import { databasePaths } from "../commands/migrate";
import { readMigrationSchema } from "./migration-schema";
import { pluralRoute, pluralize, renderBlankOrmModel, renderOrmModel } from "./orm-model";
import { readModelSchema, renderResourceDto, type ResourceSchema } from "./resource";
import { syncModelSource, type ModelChanges } from "./sync-model";
import { renderFactory, type ForeignKey } from "./factory";

export type MakeBaseOptions = {
  /** Directory to start the project-root search from. Defaults to `process.cwd()`. */
  cwd?: string;
  force?: boolean;
  /** Folder under `src/` to write to instead of the default one. */
  root?: string;
};

export type MakeModelOptions = MakeBaseOptions & {
  /** Generate a TypeORM entity instead of a Megh ORM model. */
  orm?: boolean;
  /** Table name. Defaults to the plural snake_case model name, e.g. `blog_posts`. */
  table?: string;
};
export type MakeServiceOptions = MakeBaseOptions & { resource?: boolean; model?: string; orm?: boolean };
export type MakeControllerOptions = MakeServiceOptions & { basePath?: boolean };

const DEFAULT_DIRS = {
  model: "models",
  service: "services",
  controller: "controllers",
  config: "config",
  middleware: "middlewares",
  dto: "dtos",
  mail: "mail",
  event: "events",
  listener: "listeners",
  queue: "queues",
  worker: "workers",
  task: "tasks",
} as const;

type Kind = keyof typeof DEFAULT_DIRS;

function targetDir(projectRoot: string, kind: Kind, dirs: string[], root?: string): string {
  const folder = root ? root.split(/[\\/]+/).filter(Boolean) : [DEFAULT_DIRS[kind]];
  if (folder.some((p) => p === "..")) throw new CliError(`Invalid --root "${root}".`);
  // The module folder comes first: `users/user` -> src/users/models/user.model.ts.
  return path.join(projectRoot, "src", ...dirs, ...folder);
}

/**
 * Where an existing `kind` file for `n` lives. Before 0.6.2 a nested name put
 * the module folder inside the type folder (src/models/users/user.model.ts),
 * so that location is tried when the current one has no file.
 */
function existingFile(projectRoot: string, kind: Kind, n: ResolvedName, suffix: string): string {
  const file = path.join(targetDir(projectRoot, kind, n.dirs), `${n.fileBase}.${suffix}.ts`);
  if (fs.existsSync(file) || n.dirs.length === 0) return file;
  const legacy = path.join(projectRoot, "src", DEFAULT_DIRS[kind], ...n.dirs, `${n.fileBase}.${suffix}.ts`);
  return fs.existsSync(legacy) ? legacy : file;
}

/** Files `make:model` / `make:resource` / `make:factory` write for model `name`. */
export function generatedFiles(projectRoot: string, name: string) {
  const n = resolveName(name, "Model");
  return {
    model: existingFile(projectRoot, "model", n, "model"),
    dto: existingFile(projectRoot, "dto", n, "dto"),
    service: existingFile(projectRoot, "service", n, "service"),
    controller: existingFile(projectRoot, "controller", n, "controller"),
    factory: path.join(databasePaths(projectRoot).factories, ...n.dirs, `${n.fileBase}.factory.ts`),
  };
}

/** A relative module specifier from `fromFile` to `toFile` (without extension), always using `/`. */
function importPath(fromFile: string, toFile: string): string {
  let rel = path.relative(path.dirname(fromFile), toFile).replace(/\.ts$/, "").split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

function write(file: string, content: string, force: boolean | undefined, label: string, projectRoot: string) {
  writeFileSafe(file, content, force);
  log.success(`${label} created: ${path.relative(projectRoot, file).split(path.sep).join("/")}`);
  return file;
}

/**
 * Write a dependency of the requested file (the model behind a service, or the
 * service behind a controller). An existing file is always kept and reused.
 */
function ensureDependency(file: string, render: () => string, label: string, projectRoot: string) {
  const rel = path.relative(projectRoot, file).split(path.sep).join("/");
  if (fs.existsSync(file)) {
    log.info(`  ${label} exists, reusing: ${rel}`);
    return;
  }
  write(file, render(), false, label, projectRoot);
}

/**
 * Create a Megh ORM model (or, with `orm`, a TypeORM entity). The model's
 * columns come from the migration that creates its table, if there is one;
 * otherwise it gets placeholder columns.
 */
export function makeModel(name: string, opts: MakeModelOptions = {}): string {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  const n = resolveName(name, "Model");
  const file = path.join(targetDir(projectRoot, "model", n.dirs, opts.root), `${n.fileBase}.model.ts`);
  if (opts.orm) return write(file, renderEntityModel(n.base), opts.force, "Model", projectRoot);

  const { migrations } = databasePaths(projectRoot);
  const rel = (p: string) => path.relative(projectRoot, p).split(path.sep).join("/");
  const snake = snakeCase(n.base);
  const candidates = opts.table ? [opts.table] : [pluralize(snake), snake];
  const schema = readMigrationSchema(migrations);
  const table = candidates.map((t) => schema.get(t)).find((t) => t !== undefined);

  if (table) {
    write(file, renderOrmModel(n.base, table), opts.force, "Model", projectRoot);
    log.info(`  ${table.columns.length} columns of "${table.name}" read from ${rel(migrations)}`);
  } else {
    write(file, renderBlankOrmModel(n.base, candidates[0]), opts.force, "Model", projectRoot);
    log.info(
      `  No migration creates "${candidates[0]}", so the columns are placeholders. ` +
        `Create one with: megh make:migration create_${candidates[0]}_table`,
    );
  }
  return file;
}

export type SyncModelOptions = Pick<MakeBaseOptions, "cwd" | "root"> & {
  /** Table to read (default: the model's `@Table`, else the plural snake_case name). */
  table?: string;
  /** Also rewrite the model's DTO file from the updated columns. */
  dto?: boolean;
  /** Report the changes without writing anything. */
  dryRun?: boolean;
};

/**
 * `sync:model user`: sync an existing model's column fields with its table
 * as the migrations now leave it (after an alter-table migration, say). Only
 * the column declarations change; relations, methods and other code stay.
 */
export function syncModel(name: string, opts: SyncModelOptions = {}): ModelChanges {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  const n = resolveName(name, "Model");
  const file = opts.root
    ? path.join(targetDir(projectRoot, "model", n.dirs, opts.root), `${n.fileBase}.model.ts`)
    : existingFile(projectRoot, "model", n, "model");
  const rel = (p: string) => relPath(projectRoot, p);
  if (!fs.existsSync(file)) {
    throw new CliError(`There is no ${n.base} model (${rel(file)}). Create it: megh make:model ${name}`);
  }
  const source = fs.readFileSync(file, "utf8");
  if (/@Entity\s*\(/.test(source)) {
    throw new CliError(`${rel(file)} is a TypeORM entity; sync:model only syncs Megh ORM models.`);
  }
  if (!/@Table\s*\(/.test(source)) {
    throw new CliError(
      `${rel(file)} declares its columns without decorators (static table/casts), which sync:model ` +
        `can't edit safely. Regenerate it with: megh make:model ${name} --force (then re-add relations and methods).`,
    );
  }

  const { migrations } = databasePaths(projectRoot);
  const snake = snakeCase(n.base);
  const declared = source.match(/@Table\s*\(\s*["'`]([^"'`]+)["'`]/)?.[1];
  const candidates = opts.table ? [opts.table] : [declared, pluralize(snake), snake].filter((t): t is string => !!t);
  const tables = readMigrationSchema(migrations);
  const table = candidates.map((t) => tables.get(t)).find((t) => t !== undefined);
  if (!table) {
    throw new CliError(
      `No migration in ${rel(migrations)} creates the "${candidates[0]}" table, so there is nothing to sync. ` +
        `Pass the table with --table if it has another name.`,
    );
  }

  const result = syncModelSource(source, table);
  const { added, removed, updated, kept } = result.changes;
  const changed = result.source !== source;
  const prefix = opts.dryRun ? "Would sync" : "Model synced";
  if (!changed) {
    log.info(`${rel(file)} already matches the "${table.name}" table.`);
  } else {
    if (!opts.dryRun) {
      trackWrite(file);
      fs.writeFileSync(file, result.source, "utf8");
    }
    log.success(`${prefix}: ${rel(file)}`);
  }
  for (const c of added) log.info(`  + ${c}`);
  for (const c of removed) log.info(`  - ${c}`);
  for (const c of updated) log.info(`  ~ ${c}`);
  for (const c of kept) {
    log.warn(`  ${c} has hand-made changes, so it was kept as written; check it against the migration.`);
  }

  const dtoFile = existingFile(projectRoot, "dto", n, "dto");
  if (opts.dto) {
    const model: ResourceModel = { name: n, file, schema: readModelSchema(result.source, table), typeorm: false };
    if (opts.dryRun) log.info(`  Would rewrite ${rel(dtoFile)}`);
    else write(dtoFile, renderDtoFor(model), true, "DTO", projectRoot);
  } else if (changed && fs.existsSync(dtoFile)) {
    log.info(`  ${rel(dtoFile)} may be out of date: rerun with --dto to rewrite it.`);
  }
  return result.changes;
}

/** @deprecated Renamed to {@link syncModel}. */
export const updateModel = syncModel;
/** @deprecated Renamed to {@link SyncModelOptions}. */
export type UpdateModelOptions = SyncModelOptions;

function renderEntityModel(model: string) {
  return renderStub("models/entity-model.stub", { Model: model, table: snakeCase(model) });
}

/** The URL segment for a resource: `admin/BlogPost` → `admin/blog-posts`. */
function resourceRoute(dirs: string[], base: string): string {
  // Singularize first so already-plural names (`Users`) become `/users`, not `/userses`.
  return [...dirs, pluralRoute(snakeCase(base)).replace(/_/g, "-")].join("/");
}

const relPath = (projectRoot: string, file: string) => path.relative(projectRoot, file).split(path.sep).join("/");

/** The model behind a resource, existing or about to be generated. */
type ResourceModel = {
  name: ResolvedName;
  file: string;
  /** Source to write when the model does not exist yet. */
  create?: string;
  /** Read from the model; absent for a TypeORM placeholder entity. */
  schema?: ResourceSchema;
  typeorm: boolean;
};

/**
 * Find the model for a resource: an existing model file is read as is;
 * otherwise a Megh ORM model is built from the migration that creates its
 * table. With `orm`, a missing model becomes a TypeORM placeholder entity.
 * Throws when there is neither a model nor a migration.
 */
function resolveResourceModel(projectRoot: string, model: string, opts: { orm?: boolean; table?: string } = {}): ResourceModel {
  const name = resolveName(model, "Model");
  const file = existingFile(projectRoot, "model", name, "model");
  const exists = fs.existsSync(file);
  if (opts.orm && !exists) return { name, file, create: renderEntityModel(name.base), typeorm: true };

  const snake = snakeCase(name.base);
  const tables = readMigrationSchema(databasePaths(projectRoot).migrations);
  const lookup = (candidates: (string | undefined)[]) =>
    candidates.map((t) => (t ? tables.get(t) : undefined)).find((t) => t !== undefined);

  if (exists) {
    const source = fs.readFileSync(file, "utf8");
    const declared = readModelSchema(source).table;
    const schema = readModelSchema(source, lookup([opts.table, declared, pluralize(snake), snake]));
    return { name, file, schema, typeorm: opts.orm === true || schema.kind === "typeorm" };
  }

  const candidates = opts.table ? [opts.table] : [pluralize(snake), snake];
  const table = lookup(candidates);
  if (!table) {
    throw new CliError(
      `There is no ${name.base} model (${relPath(projectRoot, file)}) and no migration creates the ` +
        `"${candidates[0]}" table, so its columns are unknown. Create the table first:\n` +
        `  megh make:migration create_${candidates[0]}_table\n` +
        `or a model to fill in by hand: megh make:model ${name.base}`,
    );
  }
  const create = renderOrmModel(name.base, table);
  return { name, file, create, schema: readModelSchema(create, table), typeorm: false };
}

function renderResourceService(model: ResourceModel, serviceFile: string, serviceClass: string): string {
  const vars = {
    ClassName: serviceClass,
    Model: model.name.base,
    modelVar: model.name.varName,
    modelImport: importPath(serviceFile, model.file),
  };
  if (model.typeorm) return renderStub("services/orm-rest-service.stub", vars);
  return renderStub("services/model-service.stub", {
    ...vars,
    primaryKey: model.schema!.primaryKey,
    primaryKeyType: model.schema!.primaryKeyType,
  });
}

function renderResourceController(
  model: ResourceModel,
  controllerFile: string,
  className: string,
  route: string,
  serviceFile: string,
  dtoFile: string,
): string {
  const m = model.name;
  const vars = {
    ClassName: className,
    route,
    Model: m.base,
    modelVar: m.varName,
    ServiceClass: `${m.base}Service`,
    serviceVar: `${m.varName}Service`,
    serviceImport: importPath(controllerFile, serviceFile),
  };
  if (model.typeorm) return renderStub("controllers/resource-controller.stub", vars);
  const numeric = model.schema!.primaryKeyType === "number";
  return renderStub("controllers/model-controller.stub", {
    ...vars,
    modelImport: importPath(controllerFile, model.file),
    Plural: pascalCase(pluralize(snakeCase(m.base))),
    dtoImport: importPath(controllerFile, dtoFile),
    primaryKeyType: numeric ? "number" : "string",
    idArg: numeric ? "Number(id)" : "id",
  });
}

function renderDtoFor(model: ResourceModel): string {
  const plural = pascalCase(pluralize(snakeCase(model.name.base)));
  return renderResourceDto(model.name.base, plural, resourceRoute(model.name.dirs, model.name.base), model.schema!);
}

function warnMissing(projectRoot: string, model: ResourceModel) {
  if (model.typeorm && !installedVersion("@meghjs/data", projectRoot)) {
    log.warn("The generated service uses @meghjs/data. Install it: npm install @meghjs/data typeorm");
  }
}

function writeModelIfNew(projectRoot: string, model: ResourceModel) {
  if (model.create === undefined) {
    log.info(`  Model exists, reusing: ${relPath(projectRoot, model.file)}`);
    return;
  }
  write(model.file, model.create, false, "Model", projectRoot);
  const source = model.create.match(/table is created in (\S+?)\)/)?.[1];
  if (source) log.info(`  Columns read from ${source}`);
}

export function makeService(name: string, opts: MakeServiceOptions = {}): string {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  const n = resolveName(name, "Service");
  const file = path.join(targetDir(projectRoot, "service", n.dirs, opts.root), `${n.fileBase}.service.ts`);
  if (opts.resource && !opts.model) {
    throw new CliError("A resource service needs a model: pass -m <model> (or --model <model>).");
  }
  if (opts.model) {
    const model = resolveResourceModel(projectRoot, opts.model, { orm: opts.orm });
    write(file, renderResourceService(model, file, n.className), opts.force, "Service", projectRoot);
    writeModelIfNew(projectRoot, model);
    warnMissing(projectRoot, model);
    return file;
  }
  return write(file, renderStub("services/basic-service.stub", { ClassName: n.className }), opts.force, "Service", projectRoot);
}

export function makeController(name: string, opts: MakeControllerOptions = {}): string {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  const n = resolveName(name, "Controller");
  const file = path.join(targetDir(projectRoot, "controller", n.dirs, opts.root), `${n.fileBase}.controller.ts`);
  if (fs.existsSync(file) && !opts.force) {
    throw new CliError(`${file} already exists. Use -f or --force to overwrite it.`);
  }
  const route = resourceRoute(n.dirs, n.base);

  let content: string;
  if (opts.model) {
    const model = resolveResourceModel(projectRoot, opts.model, { orm: opts.orm });
    const m = model.name;
    const serviceFile = existingFile(projectRoot, "service", m, "service");
    const dtoFile = existingFile(projectRoot, "dto", m, "dto");
    content = renderResourceController(model, file, n.className, route, serviceFile, dtoFile);
    // Dependencies first, so a failure leaves no controller pointing at missing files.
    if (!model.typeorm) ensureDependency(dtoFile, () => renderDtoFor(model), "DTO", projectRoot);
    ensureDependency(serviceFile, () => renderResourceService(model, serviceFile, `${m.base}Service`), "Service", projectRoot);
    writeModelIfNew(projectRoot, model);
    warnMissing(projectRoot, model);
  } else {
    const stub = opts.resource ? "controllers/rest-controller.stub" : "controllers/basic-controller.stub";
    content = renderStub(stub, { ClassName: n.className, route });
  }
  if (opts.basePath) {
    content = content.replace(/@ApiController\s*\(([^)]*)\)/, "@ApiController");
  }
  write(file, content, opts.force, "Controller", projectRoot);
  log.info(`  Register it in your app: app.useControllers([..., ${n.className}])`);
  return file;
}

export type MakeResourceOptions = Pick<MakeBaseOptions, "cwd" | "force"> & {
  /** Table to read the columns from when the model does not exist yet. */
  table?: string;
};

/**
 * `make:resource user`: a REST resource for a model. The model is reused when
 * it exists, otherwise generated from the migration that creates its table;
 * then its DTOs, a service with the CRUD operations, and a controller exposing
 * them are written. Nothing is written if any of those files already exists
 * (unless `force`), or if the model's columns cannot be found.
 */
export function makeResource(name: string, opts: MakeResourceOptions = {}): string[] {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  const model = resolveResourceModel(projectRoot, name, { table: opts.table });
  const m = model.name;
  const files = {
    service: existingFile(projectRoot, "service", m, "service"),
    controller: existingFile(projectRoot, "controller", m, "controller"),
    dto: existingFile(projectRoot, "dto", m, "dto"),
  };
  if (!opts.force) {
    const taken = Object.values(files).filter((f) => fs.existsSync(f) && !(model.typeorm && f === files.dto));
    if (taken.length > 0) {
      throw new CliError(
        `Already exists: ${taken.map((f) => relPath(projectRoot, f)).join(", ")}. Use -f or --force to overwrite.`,
      );
    }
  }

  const controllerClass = `${m.base}Controller`;
  const route = resourceRoute(m.dirs, m.base);
  const written: string[] = [];
  writeModelIfNew(projectRoot, model);
  if (model.create !== undefined) written.push(model.file);
  if (model.typeorm) {
    log.info("  The model is a TypeORM entity: generating a repository service and an untyped controller (no DTOs).");
  } else {
    written.push(write(files.dto, renderDtoFor(model), opts.force, "DTO", projectRoot));
  }
  written.push(write(files.service, renderResourceService(model, files.service, `${m.base}Service`), opts.force, "Service", projectRoot));
  written.push(
    write(
      files.controller,
      renderResourceController(model, files.controller, controllerClass, route, files.service, files.dto),
      opts.force,
      "Controller",
      projectRoot,
    ),
  );
  warnMissing(projectRoot, model);
  log.info(`  Routes: GET|POST /${route}, GET|PUT|DELETE /${route}/:id`);
  log.info(`  Register it in your app: app.useControllers([..., ${controllerClass}])`);
  return written;
}

export function makeConfig(name: string, opts: MakeBaseOptions = {}): string {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  const n = resolveName(name, "Config");
  const file = path.join(targetDir(projectRoot, "config", n.dirs, opts.root), `${n.fileBase}.config.ts`);
  return write(file, renderStub("config/config.stub", { ClassName: n.className }), opts.force, "Config", projectRoot);
}

export function makeMiddleware(name: string, opts: MakeBaseOptions = {}): string {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  const n = resolveName(name, "Middleware");
  const file = path.join(targetDir(projectRoot, "middleware", n.dirs, opts.root), `${n.fileBase}.middleware.ts`);
  return write(file, renderStub("middlewares/middleware.stub", { ClassName: n.className }), opts.force, "Middleware", projectRoot);
}

/** A Mailable in src/mail/<name>.mail.ts: `make:mail Welcome` writes `WelcomeMail`. */
export function makeMail(name: string, opts: MakeBaseOptions = {}): string {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  const n = resolveName(name, "Mail");
  const file = path.join(targetDir(projectRoot, "mail", n.dirs, opts.root), `${n.fileBase}.mail.ts`);
  write(file, renderStub("mail/mail.stub", { ClassName: n.className, Title: titleOf(n.base) }), opts.force, "Mail", projectRoot);
  if (!usesMail(projectRoot)) {
    log.info("  Turn mail on in src/app.ts with app.useMail(), and set MEGH_MAIL_* in .env.");
  }
  return file;
}

/** Whether src/app.ts already calls useMail(). */
function usesMail(projectRoot: string) {
  return /\.useMail\(/.test(appSource(projectRoot));
}

/** The text of src/app.ts, or "" when there is none. */
function appSource(projectRoot: string): string {
  try {
    return fs.readFileSync(path.join(projectRoot, "src", "app.ts"), "utf8");
  } catch {
    return "";
  }
}

/** Whether src/app.ts already mentions `name` as a whole word. */
function appMentions(projectRoot: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(appSource(projectRoot));
}

/** "OrderShipped" -> "Order Shipped". */
function titleOf(base: string): string {
  return base.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

// ── Events ───────────────────────────────────────────────────────────────────

/** An event in src/events/<name>.event.ts: `make:event UserCreated` writes `UserCreatedEvent`. */
export function makeEvent(name: string, opts: MakeBaseOptions = {}): string {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  const n = resolveName(name, "Event");
  return write(eventFile(projectRoot, n, opts.root), renderEvent(n), opts.force, "Event", projectRoot);
}

function eventFile(projectRoot: string, n: ResolvedName, root?: string) {
  return path.join(targetDir(projectRoot, "event", n.dirs, root), `${n.fileBase}.event.ts`);
}

function renderEvent(n: ResolvedName) {
  return renderStub("events/event.stub", { ClassName: n.className, Base: n.base, Title: titleOf(n.base) });
}

export type MakeListenerOptions = MakeBaseOptions & {
  /** The event it listens to, e.g. `UserCreated`. Created in src/events/ if missing. */
  event?: string;
};

/**
 * A listener in src/listeners/<name>.listener.ts. With `event`, it is typed to
 * that event, which is created first if it doesn't exist.
 */
export function makeListener(name: string, opts: MakeListenerOptions = {}): string {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  const n = resolveName(name, "Listener");
  const file = path.join(targetDir(projectRoot, "listener", n.dirs, opts.root), `${n.fileBase}.listener.ts`);
  // Check before creating the event, so a refused listener leaves nothing behind.
  if (fs.existsSync(file) && !opts.force) {
    throw new CliError(`${file} already exists. Use -f or --force to overwrite it.`);
  }

  let eventClass = "MeghEvent";
  let imports = "import { AppService, MeghEvent, MeghEventListener } from '@meghjs/core';";
  if (opts.event) {
    const e = resolveName(opts.event, "Event");
    const evFile = eventFile(projectRoot, e);
    ensureDependency(evFile, () => renderEvent(e), "Event", projectRoot);
    eventClass = e.className;
    imports =
      "import { AppService, MeghEventListener } from '@meghjs/core';\n" +
      `import { ${e.className} } from '${importPath(file, evFile)}';`;
  }

  write(
    file,
    renderStub("listeners/listener.stub", { Imports: imports, ClassName: n.className, EventClass: eventClass }),
    opts.force,
    "Listener",
    projectRoot,
  );
  if (!appMentions(projectRoot, n.className)) {
    log.info(
      "  Register it once at startup, e.g. in src/app.ts:\n" +
        `    EventRegistry.getInstance().register(${eventClass}, MeghContainer.get(${n.className}));`,
    );
  }
  return file;
}

// ── Queue ────────────────────────────────────────────────────────────────────

export type MakeQueueOptions = MakeBaseOptions & {
  /** The queue's name in Redis. Defaults to the kebab-case name, e.g. `order-export`. */
  queue?: string;
};

/** A queue in src/queues/<name>.queue.ts: `make:queue OrderExport` writes `OrderExportQueue`. */
export function makeQueue(name: string, opts: MakeQueueOptions = {}): string {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  const n = resolveName(name, "Queue");
  const queueName = queueNameOf(opts.queue, n);
  const file = path.join(targetDir(projectRoot, "queue", n.dirs, opts.root), `${n.fileBase}.queue.ts`);
  write(
    file,
    renderStub("queues/queue.stub", {
      ClassName: n.className,
      Base: n.base,
      QueueName: queueName,
      varName: n.varName + "Queue",
      JobName: "process",
      JobMethod: "Process",
    }),
    opts.force,
    "Queue",
    projectRoot,
  );
  queueHints(projectRoot, n.className);
  return file;
}

export type MakeWorkerOptions = MakeBaseOptions & {
  /** The queue it consumes. Defaults to the kebab-case name, e.g. `report`. */
  queue?: string;
};

/** A worker in src/workers/<name>.worker.ts that consumes a queue filled elsewhere. */
export function makeWorker(name: string, opts: MakeWorkerOptions = {}): string {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  const n = resolveName(name, "Worker");
  const queueName = queueNameOf(opts.queue, n);
  const file = path.join(targetDir(projectRoot, "worker", n.dirs, opts.root), `${n.fileBase}.worker.ts`);
  write(
    file,
    renderStub("workers/worker.stub", { ClassName: n.className, Base: n.base, QueueName: queueName }),
    opts.force,
    "Worker",
    projectRoot,
  );
  queueHints(projectRoot, n.className);
  return file;
}

function queueNameOf(given: string | undefined, n: ResolvedName): string {
  const value = given ?? kebabCase(n.base);
  // BullMQ uses ":" as its key separator, and quotes would break the stub.
  if (!/^[A-Za-z0-9][\w.-]*$/.test(value)) {
    throw new CliError(`Invalid queue name "${value}": use letters, digits, ".", "_" and "-".`);
  }
  return value;
}

function queueHints(projectRoot: string, className: string) {
  if (!appMentions(projectRoot, className)) {
    log.info(`  Register it in src/app.ts so it starts: app.useWorker([${className}]).`);
  }
  if (!declaresDependency(projectRoot, "bullmq")) {
    log.info("  Queues run on Redis through BullMQ: npm i bullmq ioredis (or set MEGH_QUEUE_DRIVER=memory).");
  }
}

function declaresDependency(projectRoot: string, name: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
    return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
  } catch {
    return false;
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

export type MakeTaskOptions = MakeBaseOptions & {
  /** A cron expression (5 fields, or 6 with seconds first). Defaults to hourly. */
  cron?: string;
  /** Run every this many milliseconds instead of on a cron. */
  interval?: string | number;
};

/** A scheduled task in src/tasks/<name>.task.ts: `make:task CleanupTokens` writes `CleanupTokensTask`. */
export function makeTask(name: string, opts: MakeTaskOptions = {}): string {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  if (opts.cron !== undefined && opts.interval !== undefined) {
    throw new CliError("Pass --cron or --interval, not both.");
  }
  const n = resolveName(name, "Task");
  const file = path.join(targetDir(projectRoot, "task", n.dirs, opts.root), `${n.fileBase}.task.ts`);

  let vars: Record<string, string>;
  if (opts.interval !== undefined) {
    const ms = Number(opts.interval);
    if (!Number.isInteger(ms) || ms < 1) {
      throw new CliError(`Invalid --interval "${opts.interval}": use a whole number of milliseconds.`);
    }
    vars = { Decorator: "Interval", DecoratorCall: `@Interval(${ms})`, Schedule: `every ${ms} ms` };
  } else {
    const cron = (opts.cron ?? "0 * * * *").trim().replace(/\s+/g, " ");
    const fields = cron.split(" ").length;
    if ((fields !== 5 && fields !== 6) || /['"`\\]/.test(cron)) {
      throw new CliError(`Invalid --cron "${opts.cron}": use 5 fields (or 6 with seconds first), e.g. "0 3 * * *".`);
    }
    vars = {
      Decorator: "Cron",
      DecoratorCall: `@Cron('${cron}')`,
      Schedule: opts.cron === undefined ? "every hour, on the hour" : "min hour day month weekday",
    };
  }

  write(file, renderStub("tasks/task.stub", { ClassName: n.className, ...vars }), opts.force, "Task", projectRoot);

  const scansTasks = /useScheduler\(\s*\{\s*path/.test(appSource(projectRoot));
  if (!scansTasks && !appMentions(projectRoot, n.className)) {
    log.info(
      `  Register it in src/app.ts: app.useScheduler([${n.className}]),\n` +
        "  or scan the folder: app.useScheduler({ path: 'src/tasks' }).",
    );
  }
  return file;
}

export function makeDto(name: string, opts: MakeBaseOptions = {}): string {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  const n = resolveName(name, "Dto");
  const file = path.join(targetDir(projectRoot, "dto", n.dirs, opts.root), `${n.fileBase}.dto.ts`);
  return write(file, renderStub("dtos/dto.stub", { ClassName: n.className }), opts.force, "DTO", projectRoot);
}

export type MakeMigrationOptions = Pick<MakeBaseOptions, "cwd" | "force"> & {
  /** Create this table (overrides the name-based guess). */
  create?: string;
  /** Alter this table (overrides the name-based guess). */
  table?: string;
  /** Clock for the file name's timestamp (tests). */
  now?: Date;
};

/** `YYYYMMDDHHmmss` in local time: migrations run in file-name order. */
export function migrationTimestamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/**
 * Create `<migrations>/<timestamp>_<name>.ts`. `create_<table>_table` gives a
 * create-table migration, `add_x_to_<table>_table` (also from/in, and
 * remove/drop/alter/change/update) an alter-table one, anything else a blank one.
 */
export function makeMigration(name: string, opts: MakeMigrationOptions = {}): string {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  const snake = snakeCase(name);
  if (!snake) throw new CliError(`Invalid migration name "${name}".`);
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const { migrations } = databasePaths(projectRoot, pkg);

  const createTable =
    opts.create ?? (opts.table ? undefined : snake.match(/^create_(\w+?)_table$/)?.[1]);
  const alterTable =
    opts.table ??
    (opts.create ? undefined : snake.match(/^(?:add|remove|drop|alter|change|update)_\w+_(?:to|from|in|on)_(\w+?)_table$/)?.[1]);

  const content = createTable
    ? renderStub("migrations/create-table.stub", { table: createTable })
    : alterTable
      ? renderStub("migrations/alter-table.stub", { table: alterTable })
      : renderStub("migrations/migration.stub");

  const file = path.join(migrations, `${migrationTimestamp(opts.now)}_${snake}.ts`);
  return write(file, content, opts.force, "Migration", projectRoot);
}

export type MakeSeederOptions = Pick<MakeBaseOptions, "cwd" | "force">;

/**
 * Create `<seeders>/<name>.seeder.ts`. `make:seeder database` writes the
 * entry seeder that `db:seed` runs, calling the seeders that already exist.
 */
export function makeSeeder(name: string, opts: MakeSeederOptions = {}): string {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  if (/[\/]/.test(name)) throw new CliError(`Seeders live in one folder: use a plain name, not "${name}".`);
  // `UserSeeder`, `user_seeder` and `users` all name the file after the table.
  const snake = snakeCase(name.replace(/[-_]?seeder$/i, ""));
  if (!snake) throw new CliError(`Invalid seeder name "${name}".`);
  const { seeders } = databasePaths(projectRoot);
  const file = path.join(seeders, `${snake}.seeder.ts`);
  const rel = (p: string) => relPath(projectRoot, p);

  let content: string;
  if (snake === "database") {
    content = renderEntrySeeder(existingSeeders(seeders).filter((s) => s !== "database"));
  } else {
    content = renderStub("seeders/seeder.stub", { table: pluralRoute(snake) });
  }
  write(file, content, opts.force, "Seeder", projectRoot);

  if (snake !== "database") {
    const entry = path.join(seeders, "database.seeder.ts");
    if (fs.existsSync(entry)) {
      log.info(`  Run it from ${rel(entry)}: await call(${JSON.stringify(snake)});`);
    } else {
      log.info(
        "  megh db:seed runs every seeder in file-name order. To choose the order, " +
          "create the entry seeder: megh make:seeder database",
      );
    }
  }
  return file;
}

/** The `database` seeder, calling `others` in order. */
export function renderEntrySeeder(others: string[]): string {
  return renderStub("seeders/database-seeder.stub", {
    params: others.length ? "{ call }" : "",
    body: others.length
      ? `await call(${others.map((s) => JSON.stringify(s)).join(", ")});`
      : `// Add { call } to run()'s parameters, then: await call("roles", "users");`,
  });
}

/** Names of the seeders in `folder`, in file-name order. */
function existingSeeders(folder: string): string[] {
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((f) => /\.(c?js|mjs|c?ts|mts)$/.test(f) && !/\.d\.[cm]?ts$/.test(f))
    .sort()
    .map((f) => f.replace(/\.(c?js|mjs|c?ts|mts)$/, "").replace(/\.seeder$/, ""));
}

export type MakeFactoryOptions = Pick<MakeBaseOptions, "cwd" | "force">;

/**
 * `make:factory user`: `<factories>/user.factory.ts` exporting `UserFactory`,
 * with a Faker value for each of the model's columns. Foreign keys use the
 * related model's factory when it exists.
 */
export function makeFactory(name: string, opts: MakeFactoryOptions = {}): string {
  const projectRoot = requireProjectRoot(opts.cwd ?? process.cwd());
  const n = resolveName(name.replace(/[-_.]?factory$/i, ""), "Model");
  const modelFile = existingFile(projectRoot, "model", n, "model");
  if (!fs.existsSync(modelFile)) {
    throw new CliError(
      `There is no ${n.base} model (${relPath(projectRoot, modelFile)}) to build a factory for. ` +
        `Create it first: megh make:model ${n.base}`,
    );
  }
  const model = resolveResourceModel(projectRoot, [...n.dirs, n.base].join("/"));
  if (model.typeorm) throw new CliError(`${relPath(projectRoot, modelFile)} is a TypeORM entity; factories build Megh ORM models.`);

  const { factories } = databasePaths(projectRoot);
  const file = path.join(factories, ...n.dirs, `${n.fileBase}.factory.ts`);
  const fields = model.schema!.inputFields;
  const foreignKeys: ForeignKey[] = fields
    .filter((f) => /_id$/.test(f.name) && (f.ts === "number" || f.ts === "string"))
    .map((f) => {
      const related = resolveName(f.name.replace(/_id$/, ""), "Model");
      const factoryFile = path.join(factories, `${related.fileBase}.factory.ts`);
      const exists = fs.existsSync(factoryFile);
      return {
        column: f.name,
        model: snakeCase(related.base),
        ...(exists ? { factory: `${related.base}Factory`, factoryImport: importPath(file, factoryFile) } : {}),
      };
    });

  write(
    file,
    renderFactory({ model: n.base, modelImport: importPath(file, modelFile), fields, foreignKeys }),
    opts.force,
    "Factory",
    projectRoot,
  );
  log.info(`  Use it in a seeder or test: await ${n.base}Factory.createMany(10);`);
  if (!installedVersion("@faker-js/faker", projectRoot)) {
    log.warn("Factories use Faker for fake values. Install it: npm install -D @faker-js/faker");
  }
  return file;
}
