/**
 * Loading optional peer dependencies: packages Megh only needs when a feature
 * is used (`useCors()` needs `@fastify/cors`, `@Cron` needs `node-cron`, ...).
 */

export interface OptionalPeerOptions {
  /** Packages to name in the install hint. Defaults to the package itself. */
  install?: string[];
  /** Extra lines appended to the error message, e.g. a types package hint. */
  hint?: string;
  /** Build the error to throw. Defaults to a plain `Error`. */
  error?: (message: string) => Error;
}

/**
 * `require()` an optional peer. When it isn't installed, throw an error that
 * says which package to install. Errors thrown while the package itself loads
 * are passed on unchanged, so a broken install isn't reported as a missing one.
 */
export function requireOptional<T = any>(
  pkg: string,
  options: OptionalPeerOptions = {},
): T {
  try {
    return require(pkg);
  } catch (err) {
    if (!isMissing(err, pkg)) throw err;
    const install = (options.install ?? [pkg]).join(" ");
    const message =
      `[Megh] ${pkg} is not installed.\nRun: npm install ${install}` +
      (options.hint ? `\n${options.hint}` : "");
    throw options.error ? options.error(message) : new Error(message);
  }
}

/** True when `err` says `pkg` itself (not one of its imports) can't be found. */
function isMissing(err: unknown, pkg: string): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code !== "MODULE_NOT_FOUND" && e?.code !== "ERR_MODULE_NOT_FOUND") {
    return false;
  }
  // "Cannot find module 'x'" — only when x is the package we asked for.
  const message = String(e.message ?? "");
  return (
    message.includes(`'${pkg}'`) ||
    message.includes(`"${pkg}"`) ||
    message.includes(`'${pkg}/`) ||
    // Tests mock require; their errors may carry no module name.
    !/Cannot find (module|package)/.test(message)
  );
}
