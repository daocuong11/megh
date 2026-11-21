// Copy the Megh docs (docs/content/**/*.md in the monorepo) into dist/docs, so
// the published server can search and serve the docs of its own version.
const fs = require("fs");
const path = require("path");

const from = path.resolve(__dirname, "..", "..", "..", "docs", "content");
const to = path.resolve(__dirname, "..", "dist", "docs");

if (!fs.existsSync(from)) {
  console.warn(`copy-docs: ${from} not found; building without docs.`);
  process.exit(0);
}
let count = 0;
for (const entry of fs.readdirSync(from, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
  const src = path.join(entry.parentPath ?? entry.path, entry.name);
  const dest = path.join(to, path.relative(from, src));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  count++;
}
console.log(`copy-docs: ${count} pages copied to dist/docs`);
