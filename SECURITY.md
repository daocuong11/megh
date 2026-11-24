# Security Policy

## Reporting a vulnerability

Please don't report security vulnerabilities in a public issue, pull request
or discussion.

Report them privately with GitHub's **Report a vulnerability** button on this
repository's [Security tab](https://github.com/meghjs/megh/security). If you
can't use it, contact the maintainer, [@xtareq](https://github.com/xtareq), on
GitHub.

Include as much as you can:

- the affected package (`@meghjs/core`, `@meghjs/cli`, `@meghjs/data`,
  `@meghjs/mcp`, ...) and version;
- what an attacker can do, and under which conditions;
- steps or a minimal app to reproduce it;
- a suggested fix, if you have one.

You'll get an answer in the report. Once a fix is released, the advisory is
published and you're credited unless you'd rather not be.

## Supported versions

Every package shares one version. Fixes are released as a patch of the latest
release, so upgrade to the newest version to get them. See the
[versioning policy](https://meghjs.github.io/reference/versioning).

## Scope

This covers the code in this repository and the packages published from it.
Vulnerabilities in dependencies such as Fastify should be reported to that
project; tell us too if Megh's use of it makes the problem worse.
