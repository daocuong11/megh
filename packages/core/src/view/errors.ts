/** A template failed to compile or render. `template` and `line` say where. */
export class TemplateError extends Error {
  readonly template?: string;
  readonly line?: number;

  constructor(
    message: string,
    {
      template,
      line,
      cause,
    }: { template?: string; line?: number; cause?: unknown } = {},
  ) {
    const where = template ? ` (${template}${line ? `:${line}` : ""})` : "";
    super(message + where, cause !== undefined ? { cause } : undefined);
    this.name = "TemplateError";
    this.template = template;
    this.line = line;
  }
}
