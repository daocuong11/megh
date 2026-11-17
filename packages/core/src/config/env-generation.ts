/**
 * Counts `Environment.reload()` calls, so caches built from the environment
 * (GetConfig) know when to rebuild. Internal: not exported from the package.
 */
let generation = 0;

export function envGeneration(): number {
  return generation;
}

export function bumpEnvGeneration(): void {
  generation++;
}
