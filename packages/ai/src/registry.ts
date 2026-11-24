import type { RouteDescriptor } from "@meghjs/core";
import type { ToolOptions } from "./tool";

/** JSON Schema object, as sent to a model. */
export type JsonSchema = Record<string, any>;

/** A route exposed as a tool. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON schema of the tool's arguments: path parameters, query and body together. */
  inputSchema: JsonSchema;
  /** HTTP method of the route. */
  method: string;
  /** Route URL, with `:param` placeholders. */
  url: string;
  /** Needs a person's approval before it runs. */
  confirm: boolean;
  /** `GET` route: reading only. */
  readOnly: boolean;
  tags: string[];
  /** Whether the route needs authorization. */
  authorized: boolean;
  /** Controller class name and handler, for logs and listings. */
  controller: string;
  handler: string;
  /** @internal How the arguments map onto the request. */
  layout: ArgumentLayout;
  /** @internal */
  maxOutput?: number;
}

/** @internal */
export interface ArgumentLayout {
  path: string[];
  query: string[];
  /** `flat`: body fields are top-level arguments; `nested`: under `body`. */
  body: "none" | "flat" | "nested";
  bodyKeys: string[];
}

/** Pick tools by tag (any of) or name. With neither, every tool. */
export interface ToolFilter {
  tags?: string[];
  names?: string[];
}

/** @internal Build the tool's input schema and how its arguments map onto a request. */
export function buildInput(route: RouteDescriptor): { schema: JsonSchema; layout: ArgumentLayout } {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const layout: ArgumentLayout = { path: [], query: [], body: "none", bodyKeys: [] };

  for (const p of route.params) {
    properties[p.name] = { type: p.type };
    required.push(p.name);
    layout.path.push(p.name);
  }
  for (const q of route.query) {
    if (q.name in properties) continue;
    const schema: JsonSchema = { ...(q.schema ?? { type: "string" }) };
    if (q.description !== undefined) schema.description = q.description;
    properties[q.name] = schema;
    if (q.required) required.push(q.name);
    layout.query.push(q.name);
  }

  const body = route.body();
  if (body) {
    const bodyProps: Record<string, JsonSchema> | undefined =
      body.type === "object" || body.properties ? body.properties : undefined;
    const collides = bodyProps && Object.keys(bodyProps).some((k) => k in properties);
    if (bodyProps && !collides) {
      // Flat: the model sees one object, e.g. { id, reason, amount }.
      for (const [k, v] of Object.entries(bodyProps)) properties[k] = v;
      for (const k of body.required ?? []) if (k in bodyProps) required.push(k);
      layout.body = "flat";
      layout.bodyKeys = Object.keys(bodyProps);
    } else {
      properties.body = body;
      required.push("body");
      layout.body = "nested";
    }
  }

  // Unknown arguments are refused by tools.call, so say so up front.
  const schema: JsonSchema = { type: "object", properties, additionalProperties: false };
  if (required.length) schema.required = [...new Set(required)];
  return { schema, layout };
}

export function matches(tool: ToolDefinition, filter?: ToolFilter): boolean {
  if (!filter) return true;
  if (filter.names && !filter.names.includes(tool.name)) return false;
  if (filter.tags && !filter.tags.some((t) => tool.tags.includes(t))) return false;
  return true;
}

/** @internal */
export function toDefinition(
  route: RouteDescriptor,
  options: ToolOptions,
  name: string,
  method: string,
  url: string,
): ToolDefinition {
  const { schema, layout } = buildInput(route);
  return {
    name,
    description: options.description.trim(),
    inputSchema: schema,
    method,
    url,
    confirm: options.confirm === true,
    readOnly: method === "GET",
    tags: [...(options.tags ?? [])],
    authorized: route.authorized,
    controller: route.controller.name,
    handler: route.handler,
    layout,
    maxOutput: options.maxOutput,
  };
}
