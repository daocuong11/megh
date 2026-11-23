# Megh CLI

Scaffold and run [Megh](https://github.com/meghjs/megh) applications.

## Create an Application

```sh
npx @meghjs/cli new my_api
```

You are prompted for a package manager and for optional features (OpenAPI,
CORS, MeghORM). The generated project uses `@meghjs/core`'s
`Megh.createApplication()` and is ready to run:

```sh
cd my_api
npm run start:dev
```

## Commands

| Command | Alias | Options | Description |
|---------|-------|---------|-------------|
| `new <name>` | | `-m`, `-f`, `-y`, `--pm <npm\|yarn\|pnpm>`, `--features <list>`, `--skip-install`, `--skip-git` | Create a new application |
| `serve` | | `--entry <file>`, `--no-type-check`, `--debounce <ms>` | Dev server: SWC compile, run, reload on change |
| `build` | | `-p <tsconfig>` | Compile with `tsconfig.build.json` and copy assets |
| `start` | | `--entry <file>` | Run the compiled app with `NODE_ENV=production` |
| `doctor` | | | Check Node.js, `@meghjs/core`, `reflect-metadata` and decorator settings |
| `route:list` | `routes` | `--json`, `--static` | List the app's routes |
| `make:model` | `m:m` | `-f`, `--orm`, `--typeorm`, `--root <dir>`, `--template [ref]`, `--fields <list>`, `--factory` | Create a plain class, a Megh ORM model (`--orm`) or a TypeORM entity (`--typeorm`); with `--template` / `--fields`, also its migration |
| `make:resource` | `m:r` | `-f`, `-t <table>`, `--template [ref]`, `--fields <list>`, `--factory`, `--notest` | Create a model's DTOs, CRUD service and controller, with their tests |
| `sync:model` | `s:m`, `update:model` | `-t <table>`, `--dto`, `--dry-run`, `-y`, `--root <dir>` | Sync a model's columns with its migrations, keeping relations and methods |
| `make:controller` | `m:c` | `-f`, `-r`, `-m <model>`, `--typeorm`, `--root <dir>`, `--base-path` | Create a controller |
| `make:service` | `m:s` | `-f`, `-r`, `-m <model>`, `--typeorm`, `--root <dir>` | Create a service |
| `make:config` | `m:cnf` | `-f`, `--root <dir>` | Create an `@AppConfig` class |
| `make:middleware` | `m:mlwr` | `-f`, `--root <dir>` | Create a middleware |
| `make:dto` | `m:dto` | `-f`, `--root <dir>` | Create a DTO |
| `make:class` | `m:cls` | `-f`, `--root <dir>` | Create a plain class in `src/classes` |
| `make:test` | `m:t` | `-f`, `--type <kind>`, `--root <dir>` | Create a unit test (`<name>.spec.ts`) for an existing file |
| `make:mail` | `m:mail` | `-f`, `--root <dir>` | Create a Mailable in `src/mail` |
| `make:event` | `m:ev` | `-f`, `--root <dir>` | Create an event in `src/events` |
| `make:listener` | `m:lsn` | `-f`, `-e <event>`, `--root <dir>` | Create an event listener in `src/listeners`, typed to `--event` (created if missing) |
| `make:queue` | `m:q` | `-f`, `-q <name>`, `--root <dir>` | Create a queue with a job handler in `src/queues` |
| `make:worker` | `m:w` | `-f`, `-q <name>`, `--root <dir>` | Create a worker for a queue in `src/workers` |
| `make:task` | `m:task`, `make:scheduler` | `-f`, `--cron <expr>`, `--interval <ms>`, `--root <dir>` | Create a scheduled task in `src/tasks` |
| `make:seeder` | `m:sd` | `-f` | Create a seeder in `src/database/seeders` (`database` for the entry seeder) |
| `db:seed` | | `-s <name>`, `--force` | Run the seeders in one transaction (also `migrate --seed`) |
| `make:factory` | `m:f` | `-f` | Create a model factory in `src/database/factories`, with Faker values per column |
| `scaffold:domain [domain]` | `sc:domain` | `--only <list>`, `--resource`, `--factory`, `--migrations-only`, `--no-deps`, `-y` | Create a business domain's tables and models (or resources) |
| `scaffold:auth` | `sc:auth` | `--strategy <jwt\|api-key\|both>`, `--roles <none\|single\|multiple>`, `--permissions`, `-f`, `-y` | Add sign-up and sign-in, optionally with roles and permissions |
| `scaffold:rbac` | `sc:rbac` | `--roles <single\|multiple>`, `--permissions`, `-f`, `-y` | Add roles and permissions to an app's users |
| `template:list [domain]` | `templates` | `--json` | List the model templates |

`-f` / `--force` overwrites an existing file, after showing a diff, the files
that import it, and asking (`-y` skips the question). `-r` / `--resource` generates a
full REST skeleton. `--root <dir>` (also `-rt`) writes under `src/<dir>`
instead of the default folder. Names may be nested, e.g. `admin/User`: the module folder comes first, so
`make:model admin/User` writes `src/admin/models/user.model.ts`.
Every generator except `make:model` and the database ones also writes a
`<name>.spec.ts` unit test next to the file; `--notest` (or `-nt`) skips it.
`megh -v` prints the version, and `megh --info` (or `-i`) prints the logo with
the CLI, Node.js, OS and project package versions.
Run `megh <command> --help` for details.

Generated controllers must be registered in your app with
`app.useControllers([...])`.

### Controller

```sh
npx megh make:controller product
# shorthand
npx megh m:c product

# REST controller — also generates the matching service
npx megh m:c product -m product -r

# REST controller backed by a TypeORM repository
npx megh m:c product -m product -r --typeorm
```

With `-m`, the generated controller delegates to `src/services/<model>.service.ts`,
which is created alongside it.

### Model / Entity

```sh
# plain class
npx megh make:model product

# Megh ORM model, columns read from its migration
npx megh make:model product --orm

# TypeORM entity
npx megh m:m product --typeorm
```

### Service

```sh
# basic service
npx megh make:service product

# resource service backed by the Megh ORM model
npx megh make:service product -m product -r

# resource service backed by a TypeORM repository
npx megh make:service product -m product -r --typeorm
```

### Middleware

```sh
npx megh make:middleware auth
```

Generates a class extending `MeghMiddleware` with an `invoke(req, res)` method.

### Mail

```sh
npx megh make:mail OrderShipped
```

Generates `src/mail/order-shipped.mail.ts`, an `OrderShippedMail` class
extending `Mailable` with `envelope()`, `content()` and `attachments()`. Send it
with the injected `Mailer`: `mailer.to(user.email).send(new OrderShippedMail())`.
Mail must be turned on in `src/app.ts` with `app.useMail()`, and SMTP needs
`npm i nodemailer`.

### Events, queues and scheduled tasks

```sh
npx megh make:event UserCreated
npx megh make:listener SendWelcomeEmail --event UserCreated
npx megh make:queue OrderExport
npx megh make:worker Report --queue reports
npx megh make:task NightlyReport --cron "0 3 * * *"
```

Each one prints how to register the class in `src/app.ts`
(`EventRegistry.getInstance().register(...)`, `app.useWorker([...])` or
`app.useScheduler([...])`) when it isn't registered yet.

### Config

```sh
npx megh make:config jwt
```

Generates a class extending `MeghConfig`, registered via `@AppConfig`.

## Scaffold

Build tables, models and whole features from templates. A template becomes a
create-table migration; the model, DTOs, service and controller are generated
from it.

```sh
npx megh make:model Product --template ecommerce/product     # migration + model (+ categories, brands)
npx megh make:resource Ticket --fields "title,body,status:in(open|closed),user_id:cascade"
npx megh sc:domain ecommerce --resource                       # a whole domain as REST resources
npx megh sc:auth --strategy both --roles multiple --permissions
npx megh sc:rbac --roles single --permissions
npx megh templates ecommerce                                  # list a domain's templates
```

There are 11 domains (common, ecommerce, pos, medical, construction,
marketing, real-estate, hr, crm, education, logistics), and your own go in
`.megh/templates/<domain>.json`. See [Scaffold](https://meghjs.github.io/cli/scaffold/)
for the field spec, every template, and what `sc:auth` generates.

## Development Server

```sh
npx megh serve
```

Compiles `src/` with SWC into `dist/`, starts the entry point, and restarts on
change to sources, assets or `.env*` files. The entry file is taken from
`--entry`, `megh.entry` in `package.json`, `main`, then `dist/serve.js`,
`server.js`, `main.js` or `index.js`.

Type errors are reported by a parallel `tsc --noEmit --watch` (disable with
`--no-type-check`) and never block a reload. Syntax errors stop the app until
they are fixed, so stale code never keeps serving.

## Build and Run

```sh
npx megh build   # tsc with tsconfig.build.json, then copy non-TS assets
npx megh start   # node dist/serve.js with NODE_ENV=production
```

## Routes

```sh
npx megh route:list          # compile and read Megh's route metadata
npx megh route:list --static # scan decorators in the source, no dependencies
npx megh routes --json
```

The `AUTH` column shows how each route is protected: `authorized` (or
`authorized:<name>`) for `@Authorized`, `public` for `@Public()`, and `default`
for neither, which is protected only when the app sets
`useAuthorization(handler, { default })`.

## Doctor

```sh
npx megh doctor
```

Checks the Node.js version, that `@meghjs/core` matches the CLI's version,
that `reflect-metadata` is installed, and that `experimentalDecorators` and
`emitDecoratorMetadata` are enabled. Exits non-zero if a check fails.
