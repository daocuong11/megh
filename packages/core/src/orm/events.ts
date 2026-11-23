/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 *
 * Model lifecycle events: `User.on("creating", (user) => { … })`.
 */

/**
 * Lifecycle events of a model instance. `-ing` events run before the write
 * (throw to stop it); `-ed` events run after.
 *
 * - `saving` / `saved`: every `save()`, insert or update
 * - `creating` / `created`: the insert, including `Model.create()`
 * - `updating` / `updated`: an update that changes columns
 * - `deleting` / `deleted`: `delete()` (soft or not) and `forceDelete()`
 * - `restoring` / `restored`: `restore()`
 *
 * Query-level writes (`User.where(…).update()`, `.delete()`) write many rows
 * at once and don't fire them.
 */
export type ModelEvent =
  | "saving"
  | "saved"
  | "creating"
  | "created"
  | "updating"
  | "updated"
  | "deleting"
  | "deleted"
  | "restoring"
  | "restored";

type Handler = (model: any) => unknown;

const registry = new WeakMap<Function, Map<ModelEvent, Set<Handler>>>();

/** Register `handler` for `event` on `cls` and its subclasses. Returns a function that removes it. */
export function addListener(
  cls: Function,
  event: ModelEvent,
  handler: Handler,
): () => void {
  let events = registry.get(cls);
  if (!events) registry.set(cls, (events = new Map()));
  let handlers = events.get(event);
  if (!handlers) events.set(event, (handlers = new Set()));
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** Run the handlers for `event`, base classes' first, one after another. */
export async function fire(instance: object, event: ModelEvent): Promise<void> {
  const chain: Function[] = [];
  for (
    let cls: any = instance.constructor;
    cls && cls !== Function.prototype;
    cls = Object.getPrototypeOf(cls)
  ) {
    chain.unshift(cls);
  }
  for (const cls of chain) {
    const handlers = registry.get(cls)?.get(event);
    if (!handlers) continue;
    for (const handler of [...handlers]) await handler(instance);
  }
}
