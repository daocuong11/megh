// Run by `lerna version` (root "version" lifecycle) after it bumps the
// packages. Sets the version shown in the docs navbar to the new release, so
// it never stays on the previous one. The docs are mirrored to their own repo
// without lerna.json, so the version is written into the config, not read.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const config = path.join(root, "docs", ".vitepress", "config.mts");
const { version } = JSON.parse(
  fs.readFileSync(path.join(root, "packages", "core", "package.json"), "utf8"),
);

const source = fs.readFileSync(config, "utf8");
// The navbar's version menu: `text: 'v1.2.3',` followed by its `items`.
const pattern = /(text: ')v\d+\.\d+\.\d+[^']*(',\s*\n\s*items:)/;
if (!pattern.test(source)) {
  console.error(`sync-docs-version: no version menu found in ${config}`);
  process.exit(1);
}
const updated = source.replace(pattern, `$1v${version}$2`);
if (updated !== source) {
  fs.writeFileSync(config, updated);
  execFileSync("git", ["add", config], { cwd: root });
  console.log(`docs: navbar version set to v${version}`);
}
