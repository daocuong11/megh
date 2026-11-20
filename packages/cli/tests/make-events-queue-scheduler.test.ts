import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import ts from "typescript";
import { runCli } from "../src/program";
import { makeEvent, makeListener, makeQueue, makeTask, makeWorker } from "../src/generators/make";

let tmp: string;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "megh-cli-async-"));
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "x" }));
  info = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const read = (...p: string[]) => fs.readFileSync(path.join(tmp, ...p), "utf8");
const exists = (...p: string[]) => fs.existsSync(path.join(tmp, ...p));
const logged = () => info.mock.calls.flat().join("\n");
const writeApp = (source: string) => {
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "app.ts"), source);
};

describe("make:event", () => {
  it("creates a typed event in src/events", () => {
    makeEvent("UserCreated", { cwd: tmp });
    const event = read("src", "events", "user-created.event.ts");
    expect(event).toContain("import { MeghEvent } from '@meghjs/core';");
    expect(event).toContain("export type UserCreatedPayload = {");
    expect(event).toContain("export class UserCreatedEvent extends MeghEvent<UserCreatedPayload> {}");
    expect(event).toContain('The "User Created" event.');
    expect(event).not.toMatch(/\{(ClassName|Base|Title)\}/);
    expect(() => makeEvent("UserCreated", { cwd: tmp })).toThrow(/already exists/);
  });

  it("strips an Event suffix and supports folders and --root", () => {
    makeEvent("billing/InvoicePaidEvent", { cwd: tmp });
    expect(read("src", "billing", "events", "invoice-paid.event.ts")).toContain("class InvoicePaidEvent ");
    makeEvent("OrderPlaced", { cwd: tmp, root: "modules/orders" });
    expect(exists("src", "modules", "orders", "order-placed.event.ts")).toBe(true);
  });
});

describe("make:listener", () => {
  it("types the listener to --event and creates the event when missing", () => {
    makeListener("admin/SendWelcomeEmail", { cwd: tmp, event: "UserCreated" });
    const listener = read("src", "admin", "listeners", "send-welcome-email.listener.ts");
    expect(listener).toContain("import { AppService, MeghEventListener } from '@meghjs/core';");
    expect(listener).toContain("import { UserCreatedEvent } from '../../events/user-created.event';");
    expect(listener).toContain("@AppService\nexport class SendWelcomeEmailListener extends MeghEventListener<UserCreatedEvent> {");
    expect(listener).toContain("async handler(event: UserCreatedEvent): Promise<void> {");
    expect(listener).not.toMatch(/\{(Imports|ClassName|EventClass)\}/);
    expect(exists("src", "events", "user-created.event.ts")).toBe(true);
    expect(logged()).toContain(
      "EventRegistry.getInstance().register(UserCreatedEvent, MeghContainer.get(SendWelcomeEmailListener));",
    );
  });

  it("reuses an existing event without touching it", () => {
    makeEvent("UserCreated", { cwd: tmp });
    fs.appendFileSync(path.join(tmp, "src", "events", "user-created.event.ts"), "// mine\n");
    makeListener("Audit", { cwd: tmp, event: "UserCreatedEvent" });
    expect(read("src", "events", "user-created.event.ts")).toContain("// mine");
    expect(logged()).toContain("Event exists, reusing");
  });

  it("falls back to MeghEvent without --event", () => {
    makeListener("LogEverything", { cwd: tmp });
    const listener = read("src", "listeners", "log-everything.listener.ts");
    expect(listener).toContain("import { AppService, MeghEvent, MeghEventListener } from '@meghjs/core';");
    expect(listener).toContain("extends MeghEventListener<MeghEvent>");
    expect(exists("src", "events")).toBe(false);
  });

  it("refuses an existing listener before creating its event", () => {
    makeListener("Audit", { cwd: tmp });
    expect(() => makeListener("Audit", { cwd: tmp, event: "OrderPlaced" })).toThrow(/already exists/);
    expect(exists("src", "events", "order-placed.event.ts")).toBe(false);
  });

  it("skips the registration hint once src/app.ts registers it", () => {
    writeApp("registry.register(UserCreatedEvent, MeghContainer.get(AuditListener));\n");
    makeListener("Audit", { cwd: tmp, event: "UserCreated" });
    expect(logged()).not.toContain("Register it once");
  });
});

describe("make:queue and make:worker", () => {
  it("creates a queue with a job handler, named after the class", () => {
    makeQueue("OrderExport", { cwd: tmp });
    const queue = read("src", "queues", "order-export.queue.ts");
    expect(queue).toContain("import { Job, JobHandler, MeghQueue, Queue } from '@meghjs/core';");
    expect(queue).toContain("name: 'order-export',");
    expect(queue).toContain("export class OrderExportQueue extends MeghQueue<OrderExportPayload> {");
    expect(queue).toContain("constructor() {\n    super();\n  }");
    expect(queue).toContain("@JobHandler('process')\n  async handleProcess(job: Job<OrderExportPayload>) {");
    expect(queue).toContain("await this.orderExportQueue.add('process', { id: 1 });");
    expect(queue).not.toMatch(/\{(ClassName|Base|QueueName|varName|JobName|JobMethod)\}/);
    expect(logged()).toContain("app.useWorker([OrderExportQueue])");
    expect(logged()).toContain("npm i bullmq ioredis");
  });

  it("creates a worker for a named queue", () => {
    makeWorker("ReportWorker", { cwd: tmp, queue: "reports.daily" });
    const worker = read("src", "workers", "report.worker.ts");
    expect(worker).toContain("import { Job, MeghWorker, MeghWorkerBase } from '@meghjs/core';");
    expect(worker).toContain("queue: 'reports.daily',");
    expect(worker).toContain("export class ReportWorker extends MeghWorkerBase<ReportPayload> {");
    expect(worker).toContain("async process(job: Job<ReportPayload>) {");
    expect(worker).toContain("onFailed(job: Job<ReportPayload> | undefined, error: Error) {");
    expect(worker).not.toMatch(/\{(ClassName|Base|QueueName)\}/);
  });

  it("rejects queue names that would break Redis keys or the file", () => {
    for (const bad of ["a:b", "it's", "-x", "a b"]) {
      expect(() => makeQueue("Bad", { cwd: tmp, queue: bad, force: true }), bad).toThrow(/Invalid queue name/);
      expect(() => makeWorker("Bad", { cwd: tmp, queue: bad, force: true }), bad).toThrow(/Invalid queue name/);
    }
  });

  it("drops the hints once the app registers it and bullmq is installed", () => {
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "x", dependencies: { bullmq: "^5.0.0" } }));
    writeApp("app.useWorker([MailerQueue]);\n");
    makeQueue("Mailer", { cwd: tmp });
    expect(logged()).not.toContain("app.useWorker");
    expect(logged()).not.toContain("npm i bullmq");
  });
});

describe("make:task", () => {
  it("creates an hourly @Cron task by default", () => {
    makeTask("CleanupTokens", { cwd: tmp });
    const task = read("src", "tasks", "cleanup-tokens.task.ts");
    expect(task).toContain("import { Cron, ScheduledTask } from '@meghjs/core';");
    expect(task).toContain("@ScheduledTask()\nexport class CleanupTokensTask {");
    expect(task).toContain("@Cron('0 * * * *') // every hour, on the hour");
    expect(task).not.toMatch(/\{(ClassName|Decorator|DecoratorCall|Schedule)\}/);
    expect(logged()).toContain("app.useScheduler([CleanupTokensTask])");
  });

  it("takes --cron or --interval", () => {
    makeTask("Nightly", { cwd: tmp, cron: "  0  3 * * * " });
    expect(read("src", "tasks", "nightly.task.ts")).toContain("@Cron('0 3 * * *')");
    makeTask("Poll", { cwd: tmp, interval: "30000" });
    const poll = read("src", "tasks", "poll.task.ts");
    expect(poll).toContain("import { Interval, ScheduledTask } from '@meghjs/core';");
    expect(poll).toContain("@Interval(30000) // every 30000 ms");
  });

  it("rejects bad schedules", () => {
    expect(() => makeTask("A", { cwd: tmp, cron: "* * *" })).toThrow(/Invalid --cron/);
    expect(() => makeTask("A", { cwd: tmp, cron: "0 3 * * * ' + x" })).toThrow(/Invalid --cron/);
    expect(() => makeTask("A", { cwd: tmp, interval: "0" })).toThrow(/Invalid --interval/);
    expect(() => makeTask("A", { cwd: tmp, interval: "1.5" })).toThrow(/Invalid --interval/);
    expect(() => makeTask("A", { cwd: tmp, cron: "0 * * * *", interval: 5 })).toThrow(/not both/);
    expect(exists("src", "tasks")).toBe(false);
  });

  it("skips the hint when the app scans a folder for tasks", () => {
    writeApp("app.useScheduler({ path: 'src/tasks' });\n");
    makeTask("Report", { cwd: tmp });
    expect(logged()).not.toContain("Register it");
  });
});

describe("command line", () => {
  it("runs every new command and alias", async () => {
    const run = (...args: string[]) => runCli(args, { cwd: tmp });
    expect(await run("make:event", "A")).toBe(0);
    expect(await run("m:ev", "B")).toBe(0);
    expect(await run("make:listener", "C", "--event", "A")).toBe(0);
    expect(await run("m:lsn", "D", "-e", "Z")).toBe(0);
    expect(await run("make:queue", "E", "-q", "emails")).toBe(0);
    expect(await run("m:q", "F")).toBe(0);
    expect(await run("make:worker", "G", "--queue", "emails")).toBe(0);
    expect(await run("m:w", "H")).toBe(0);
    expect(await run("make:task", "I", "--cron", "0 3 * * *")).toBe(0);
    expect(await run("m:task", "J", "--interval", "1000")).toBe(0);
    expect(await run("make:scheduler", "K")).toBe(0);
    expect(await run("make:task", "L", "-rt", "jobs")).toBe(0);

    expect(read("src", "listeners", "c.listener.ts")).toContain("MeghEventListener<AEvent>");
    expect(exists("src", "events", "z.event.ts")).toBe(true);
    expect(read("src", "queues", "e.queue.ts")).toContain("name: 'emails',");
    expect(read("src", "workers", "g.worker.ts")).toContain("queue: 'emails',");
    expect(read("src", "tasks", "j.task.ts")).toContain("@Interval(1000)");
    expect(exists("src", "tasks", "k.task.ts")).toBe(true);
    expect(exists("src", "jobs", "l.task.ts")).toBe(true);
  });
});

// The generated files must compile against the real @meghjs/core, with the
// compiler options `megh new` scaffolds.
describe("generated code", () => {
  it("type-checks against @meghjs/core", () => {
    makeEvent("UserCreated", { cwd: tmp });
    makeListener("SendWelcome", { cwd: tmp, event: "UserCreated" });
    makeListener("Audit", { cwd: tmp });
    makeQueue("OrderExport", { cwd: tmp });
    makeWorker("Report", { cwd: tmp, queue: "reports" });
    makeTask("Cleanup", { cwd: tmp });
    makeTask("Poll", { cwd: tmp, interval: 1000 });

    const files = [
      "events/user-created.event.ts",
      "listeners/send-welcome.listener.ts",
      "listeners/audit.listener.ts",
      "queues/order-export.queue.ts",
      "workers/report.worker.ts",
      "tasks/cleanup.task.ts",
      "tasks/poll.task.ts",
    ].map((f) => path.join(tmp, "src", f));

    const coreSrc = path.resolve(__dirname, "../../core/src/index.ts");
    const program = ts.createProgram(files, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
      skipLibCheck: true,
      strict: false,
      noEmit: true,
      baseUrl: tmp,
      paths: { "@meghjs/core": [coreSrc] },
    });
    const ours = new Set(files.map((f) => path.normalize(f)));
    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file && ours.has(path.normalize(d.file.fileName)))
      .map((d) => `${path.basename(d.file!.fileName)}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    expect(errors).toEqual([]);
  }, 60_000);
});
