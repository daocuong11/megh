import "reflect-metadata";

/** Metadata key of `@Tool()`. `megh route:list` reads it by this description. */
export const TOOL_META_KEY = Symbol.for("megh:tool");

export interface ToolOptions {
  /**
   * What the tool does, written for the model: when to use it and what it
   * returns. This is the most important part of a tool.
   */
  description: string;
  /**
   * The tool's name. Defaults to the controller and method, in snake case:
   * `OrderController.find` → `order_find`. Letters, digits, `_` and `-`,
   * at most 64 characters.
   */
  name?: string;
  /**
   * The tool has side effects and needs a person's approval. `tools.call`
   * refuses to run it unless `confirmed: true` is passed. In development,
   * Megh warns about a `POST`, `PUT`, `PATCH` or `DELETE` tool with neither
   * `confirm: true` nor `confirm: false`.
   */
  confirm?: boolean;
  /** Tags for picking a set of tools: `app.tools({ tags: ['orders'] })`. */
  tags?: string[];
  /** Largest response, in characters, sent back to the model. Overrides `useTools({ maxOutput })`. */
  maxOutput?: number;
}

/**
 * Expose a controller route to LLMs as a tool. Its input schema is built
 * from the route's path parameters, `@Query()` and `@Body()` DTO, and a call
 * goes through the same pipeline as an HTTP request: middleware,
 * authentication, `@Authorized`, validation and rate limits.
 *
 *   @Get('/:id')
 *   @Tool({ description: 'Look up one order by its ID, with items and status.' })
 *   find(@Param('id') id: string) { ... }
 */
export function Tool(options: ToolOptions): MethodDecorator {
  if (!options || typeof options.description !== "string" || !options.description.trim()) {
    throw new Error("[Megh] @Tool needs a description, written for the model.");
  }
  if (options.name !== undefined) assertToolName(options.name);
  return (target, propertyKey) => {
    Reflect.defineMetadata(TOOL_META_KEY, { ...options }, target, propertyKey);
  };
}

export function getToolOptions(controller: Function, handler: string): ToolOptions | undefined {
  return Reflect.getMetadata(TOOL_META_KEY, controller.prototype, handler);
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function assertToolName(name: string): void {
  if (!NAME.test(name)) {
    throw new Error(
      `[Megh] Invalid tool name "${name}": use letters, digits, "_" and "-", at most 64 characters.`,
    );
  }
}

/** `OrderController` + `findOne` → `order_find_one`. */
export function defaultToolName(controller: Function, handler: string): string {
  const snake = (s: string) =>
    s
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
      .toLowerCase();
  const base = controller.name.replace(/Controller$/, "") || controller.name;
  return `${snake(base)}_${snake(handler)}`.slice(0, 64);
}
