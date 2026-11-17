import fs from "fs";
import path from "path";

/** This package's version, read from its package.json (one level above dist/ and src/). */
export const version: string = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
).version;
