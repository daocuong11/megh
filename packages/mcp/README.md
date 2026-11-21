# Megh MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI
assistants (Claude Code, Claude Desktop, Cursor, VS Code, ...) understand,
inspect and scaffold [Megh](https://github.com/meghjs/megh) applications.

It gives an assistant:

- **the Megh docs**, bundled with the server so they match its version, to
  search and read instead of guessing at the API;
- **a view of your project**: dependencies, source files by kind, routes,
  migration status, `megh doctor` checks and type errors;
- **the `megh` generators and scaffolds**, run the same way the CLI runs them;
- **migrations and seeders**, refused against a production project.

It wraps the `megh` CLI. It uses the `@meghjs/cli` installed in your project
when there is one, so the generated code matches your `@meghjs/core`, and
falls back to its own copy.

## Setup

Claude Code, from your project directory:

```sh
claude mcp add megh -- npx -y @meghjs/mcp
```

Any client that reads an `mcpServers` config (Claude Desktop, Cursor, ...):

```json
{
  "mcpServers": {
    "megh": {
      "command": "npx",
      "args": ["-y", "@meghjs/mcp", "/path/to/your/project"]
    }
  }
}
```

VS Code (`.vscode/mcp.json` in your project):

```json
{
  "servers": {
    "megh": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@meghjs/mcp", "${workspaceFolder}"]
    }
  }
}
```

To run a local build instead, build it from this repository
(`npm run build -w @meghjs/cli && npm run build -w @meghjs/mcp`) and use
`node /path/to/megh/packages/mcp/dist/bin.js` in place of `npx -y @meghjs/mcp`.

### Options

```
megh-mcp [project-dir] [--read-only]
```

| Option | Environment | Description |
|--------|-------------|-------------|
| `project-dir` | `MEGH_PROJECT_ROOT` | The project tools work on by default. Defaults to the directory the server starts in. Every tool also takes an optional `cwd`. |
| `--read-only` | `MEGH_MCP_READ_ONLY=1` | Leave out every tool that writes files or changes the database, and the `megh-add-resource` prompt. |
| | `MEGH_DOCS_DIR` | Serve docs from this folder instead of the bundled ones. |

## Tools

### Project (read-only)

| Tool | What it does |
|------|--------------|
| `megh_project_info` | Project root, `@meghjs/*` dependencies (declared and installed), scripts, `megh` settings, whether it runs in production |
| `megh_project_structure` | Source files grouped by kind (controllers, services, models, dtos, migrations, seeders, ...), with counts and the entry file |
| `megh_doctor` | The `megh doctor` checks as JSON: Node.js, `@meghjs/core`, `reflect-metadata`, decorator settings |
| `megh_list_routes` | `megh route:list --json`. `static: true` scans the decorators without running code |
| `megh_list_templates` | `megh template:list [domain] --json` |
| `megh_typecheck` | The project's `tsc --noEmit`, returning the errors |
| `megh_migrate_status` | `megh migrate:status --json` |

### Docs (read-only)

| Tool | What it does |
|------|--------------|
| `megh_search_docs` | Search the Megh docs; returns the best-matching pages with snippets |
| `megh_read_doc` | Read a page as markdown, e.g. `core-concept/controller`; with no page, list them all |

### Code generation

| Tool | What it does |
|------|--------------|
| `megh_make` | `megh make:<kind> <name>` for model, controller, service, resource, dto, config, middleware, mail, event, listener, queue, worker, task, migration, seeder, factory. Takes `force`, `table`, `create`, `template`, `fields`, `factory` |
| `megh_sync_model` | `megh sync:model`: update a model after an alter-table migration. `dryRun` shows the changes first |
| `megh_scaffold_domain` | `megh scaffold:domain`: the tables (and models or resources) of a domain's templates |
| `megh_scaffold_auth` | `megh scaffold:auth`: sign-up and sign-in with JWT, API keys or both, optionally with roles |
| `megh_scaffold_rbac` | `megh scaffold:rbac`: roles and permissions for an app that already has users |
| `megh_build` | `megh build`: compile to the output folder and copy assets |

The generators never prompt and leave existing files alone unless `force` is
set.

### Database

| Tool | What it does |
|------|--------------|
| `megh_migrate` | Run the pending migrations, optionally followed by the seeders |
| `megh_migrate_rollback` | Undo the last migration, or the last `step` (marked destructive) |
| `megh_db_seed` | Run the seeders, or one `seeder` |

These refuse to run when `NODE_ENV` is `production`, from the server's
environment or the project's `.env`. `migrate:reset` and `migrate:refresh` are
not exposed because they drop every table. Run those yourself.

## Resources

| URI | Contents |
|-----|----------|
| `megh://docs/{page}` | A docs page as markdown, e.g. `megh://docs/advanced/orm` (each page is listed) |
| `megh://project/info` | The server's project, as `megh_project_info` returns it |
| `megh://project/structure` | The server's project files, as `megh_project_structure` returns them |

## Prompts

| Prompt | What it does |
|--------|--------------|
| `megh-review-project` | Check the setup, routes, structure and type errors, and point out problems |
| `megh-explain` | Explain a Megh feature (`topic`) from the docs, with an example that fits the project |
| `megh-add-resource` | Add a table, model and CRUD API for `name` (with optional `fields`), migrate, and check it compiles. Not offered in read-only mode |

## Use it as a library

```ts
import { createServer } from "@meghjs/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createServer({ projectRoot: "/path/to/app", readOnly: true });
await server.connect(new StdioServerTransport());
```
