# Benchmarks

HTTP throughput of Megh against raw Fastify, Express, and NestJS on both of its
adapters. Every server exposes the same three routes:

| Scenario       | Route                       | What it measures                                    |
| -------------- | --------------------------- | --------------------------------------------------- |
| JSON           | `GET /hello`                | Routing plus JSON serialization: framework overhead |
| Params         | `GET /users/42?fields=name` | Path and query parameter extraction                 |
| Validated body | `POST /users`               | Body parsing plus validation of a 3-field DTO       |

## Run it

```bash
cd benchmarks
npm run setup   # build and pack ../packages/core, install everything
npm run bench   # compile the servers, run all scenarios
```

`setup` packs the local `@meghjs/core` and installs the tarball instead of
linking it, so the benchmark runs the same package users get from npm and
shares single copies of its dependencies with the other servers. Re-run `setup`
after changing core.

Options (environment variables):

| Variable      | Default  |                                                                   |
| ------------- | -------- | ----------------------------------------------------------------- |
| `ONLY`        | all five | Comma-separated: `fastify,megh,nest-fastify,express,nest-express` |
| `DURATION`    | `10`     | Seconds per timed run                                             |
| `RUNS`        | `3`      | Timed runs per scenario; the median is reported                   |
| `CONNECTIONS` | `100`    | Concurrent autocannon connections                                 |
| `PORT`        | `3999`   | Port the servers listen on                                        |

Results print to the console and are written to `results.json`.

## Method

- One server at a time, each in its own Node process with
  `NODE_ENV=production` and request logging off.
- Before loading a server, `run.js` checks it does the same work as the others.
  It must accept a valid body, reject an invalid body and an unknown property
  with 400, and return `id` and `fields` as strings. A server that fails is
  reported and skipped.
- Each scenario gets a 3 s warm-up, then `RUNS` timed runs of `DURATION`
  seconds with [autocannon](https://github.com/mcollina/autocannon). The median
  req/s and p99 latency are reported.
- Validation: Megh uses its built-in validator, with the decorators imported
  from `@meghjs/core` (`src/dto.megh.ts`). NestJS and Express use
  class-validator with `whitelist` + `forbidNonWhitelisted` (`src/dto.ts`).
  Fastify uses its native JSON schema (ajv) with `additionalProperties: false`
  and `removeAdditional` off. All of them reject unknown properties with 400
  instead of stripping them.

Versions are pinned in `package.json`: Fastify 5.12.8, Express 5.3.0,
NestJS 12.4.2, class-validator 0.15.1, autocannon 9.0.0.

## Results

2026-11-19, Megh 0.6.5 (`main`), Node 24.14.0, Windows 11, Intel i5-11320H
(4 cores / 8 threads), 100 connections, 3 × 10 s, median req/s:

| Server           |       JSON |     Params | Validated body |
| ---------------- | ---------: | ---------: | -------------: |
| Fastify (raw)    |     18,075 |     18,907 |         14,510 |
| **Megh**         | **16,703** | **15,879** |     **11,725** |
| NestJS + Fastify |     15,934 |     14,160 |          8,102 |
| Express          |     11,674 |     10,533 |          7,035 |
| NestJS + Express |     10,425 |      8,916 |          6,059 |

p99 latency for Megh: 11 ms, 13 ms and 15 ms (Fastify: 10, 9 and 13 ms). No
errors or non-2xx responses in any run.

### Reading the numbers

- On simple routes Megh keeps 84–92% of raw Fastify's throughput and is ahead
  of NestJS on Fastify by 5–12%.
- With a validated body, Megh now keeps 81% of Fastify's compiled JSON-schema
  validation and is about 45% ahead of NestJS on Fastify. In the 0.5.4 run,
  when Megh still used class-validator, it was level with NestJS at about 55%
  of Fastify. The gain comes from Megh's built-in validator.
- Express-based servers trail on every route.

This run was slower across the board than the 0.5.4 run (raw Fastify dropped
about 12%), so compare the ratios between servers, not absolute req/s across
runs.

Laptop numbers are noisy: background load and thermal throttling can easily
move results by 2×. Compare servers within one run, not across runs. Before
quoting numbers publicly, re-run on a quiet Linux machine.
