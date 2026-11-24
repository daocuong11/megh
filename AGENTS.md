# Megh monorepo

Source of Megh, a TypeScript web framework on Fastify: `@meghjs/core`, the
`megh` CLI, `@meghjs/data`, the `@meghjs/mcp` server, and the docs site.
[CONTRIBUTING.md](CONTRIBUTING.md) is the full process; this file is what an
agent needs on top of it.

## Layout

| Path | What | Tests |
|---|---|---|
| `packages/core` | The framework | `src/**/*.test.ts`, beside the code |
| `packages/cli` | `megh` commands and generators; templates in `stubs/` | `tests/` |
| `packages/data` | TypeORM / Knex plugin | `src/**/*.test.ts` |
| `packages/mcp` | MCP server for coding agents; wraps the CLI | `tests/` |
| `docs/` | VitePress site, pages in `docs/content`. Not a workspace: own lockfile | `npm run docs:build` |

Every package in `packages/` is published to npm unless it is `"private": true`.
All share one version (Lerna fixed mode).

## Commands

Run from the root. Install a dependency with `npm install <dep> -w @meghjs/<pkg>`,
never from inside a package.

```sh
npm run setup        # npm ci at the root and in docs/
npm run build        # every package
npm run typecheck
npm run lint         # warnings are expected; errors fail CI
npm test
npm run docs:build   # fails on dead links
```

One package: `cd packages/core && npx vitest run src/http`, or
`npx lerna run test --scope @meghjs/cli`.

## Traps

- **Packages use each other's built `dist/`.** After changing `core`, run
  `npm run build -w @meghjs/core` before testing `cli`, `data` or `mcp`, or
  they test the old code. `mcp` runs the built CLI: build `cli` too.
- **Decorators need metadata.** Tests run through SWC (`unplugin-swc`) because
  esbuild can't emit `design:paramtypes`. Keep `experimentalDecorators` and
  `emitDecoratorMetadata` on.
- **Plugins, not core.** Optional integrations (databases, providers) are
  plugins (`definePlugin`, `"megh": { "plugin": ... }` in `package.json`). Core
  takes no third-party provider code, and keeps its own DI container and
  validator.
- **Line endings are mixed** (some files CRLF). Edit with exact replacements,
  keep each file's line endings, and don't let shell quoting put control
  characters into regexes.
- **CI fails if the build changes tracked files** (`git diff --exit-code`).
- **`.internal/` is private and gitignored.** Never commit it or quote it in docs.

## Changes

- Branch from `main` for every PR. Don't stack PRs on other unmerged branches.
- [Conventional Commits](https://www.conventionalcommits.org) (`feat(core):`,
  `fix(cli):`, `docs:`): Lerna picks the next version and writes the
  changelogs from them.
- The pre-commit hook formats, lints and runs related tests. Don't use
  `--no-verify`.
- A change to public behaviour updates `docs/content` in the same PR, and adds
  a line to `docs/content/getting-started/upgrading-next.md` if apps may need to
  act on it.
- Generator output is part of the API: when a stub in `packages/cli/stubs`
  changes, update the tests that check the generated files.
- Never commit to `meghjs/meghjs.github.io` directly. The docs are pushed
  there with `npm run mirror`, after release.
