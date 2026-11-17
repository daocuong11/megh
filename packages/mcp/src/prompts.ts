import { z } from "zod";
import type { ToolContext } from "./tools/context";

const user = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

/** Prompts that walk an assistant through common Megh tasks with the server's tools. */
export function registerPrompts({ server, readOnly }: ToolContext): void {
  server.registerPrompt(
    "megh-review-project",
    {
      title: "Review this Megh project",
      description: "Check the project's setup, routes and structure, and point out problems.",
    },
    () =>
      user(
        [
          "Review this Megh application.",
          "1. Call megh_project_info and megh_doctor. Report any failed or warning checks and how to fix them.",
          "2. Call megh_project_structure and megh_list_routes. Summarize the API: resources, routes and what each controller does.",
          "3. Call megh_typecheck and report any type errors.",
          "4. Look for problems: controllers without services, models without migrations, routes with no validation DTO.",
          "When you're unsure how Megh does something, check with megh_search_docs before suggesting a change.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "megh-explain",
    {
      title: "Explain a Megh feature",
      description: "Explain a Megh feature from the docs, with an example that fits this project.",
      argsSchema: { topic: z.string().describe("The feature, e.g. validation, queues, relations, authentication.") },
    },
    ({ topic }) =>
      user(
        `Explain how ${topic} works in Megh. Search the docs with megh_search_docs, read the most relevant pages with megh_read_doc, ` +
          "and answer from them, with a short code example. Use names from this project (see megh_project_structure) where it helps. " +
          "Say so if the docs don't cover something instead of guessing.",
      ),
  );

  if (readOnly) return;

  server.registerPrompt(
    "megh-add-resource",
    {
      title: "Add a REST resource",
      description: "Create a table, model and CRUD API for a new resource, then check it compiles.",
      argsSchema: {
        name: z.string().describe("Resource name, e.g. Product."),
        fields: z
          .string()
          .optional()
          .describe('Columns, e.g. "title,price:money,status:in(draft|live)". Omit to choose them from a template.'),
      },
    },
    ({ name, fields }) =>
      user(
        [
          `Add a REST resource called ${name} to this Megh application.`,
          fields
            ? `1. Call megh_make with kind "resource", name "${name}" and fields "${fields}".`
            : `1. Call megh_list_templates to find a template that fits ${name}; if one does, use it, otherwise pick sensible fields. Then call megh_make with kind "resource".`,
          "2. Call megh_migrate to create the table (skip this if it is refused, and say so).",
          "3. Call megh_list_routes with static true to confirm the new routes, and megh_typecheck to confirm it compiles.",
          "4. Summarize the files written and the routes added.",
        ].join("\n"),
      ),
  );
}
