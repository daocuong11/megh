import { z } from "zod";
import { parseJsonOutput, type CliResult } from "./megh";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Longest text a tool returns; longer output keeps its start and end. */
const MAX_TEXT = 40_000;

export function truncate(s: string, max = MAX_TEXT): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n\n... ${s.length - max} characters omitted ...\n\n${s.slice(-half)}`;
}

export const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: truncate(typeof value === "string" ? value : JSON.stringify(value, null, 2)) }],
  ...(isError ? { isError } : {}),
});

/** A CLI run as a tool result: its output, flagged as an error when it exited non-zero. */
export const fromCli = (r: CliResult): ToolResult =>
  text([r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n\n") || "(no output)", r.exitCode !== 0);

/** A `--json` CLI run as a tool result holding the parsed JSON. */
export const jsonFromCli = (r: CliResult): ToolResult => {
  if (r.exitCode !== 0) return fromCli(r);
  try {
    return text(parseJsonOutput(r.stdout));
  } catch {
    return fromCli(r);
  }
};

/** Report thrown errors to the client as a tool error instead of failing the request. */
export const safe =
  <A>(handler: (args: A) => Promise<ToolResult> | ToolResult) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return await handler(args);
    } catch (err) {
      return text(err instanceof Error ? err.message : String(err), true);
    }
  };

export const cwdArg = z
  .string()
  .optional()
  .describe("Project directory (absolute, or relative to the server's project). Defaults to the server's project.");
