import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotSubscription } from "../providers/copilot.js";
import { claudeToolName } from "../providers/claude-tool-names.js";
import { normalizeResponsesTools } from "../protocol/request.js";
import { copilotLive } from "../providers/copilot-live.js";
import type { InferenceContext } from "../providers/provider.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { restoreReasoning } from "../protocol/reasoning-state.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { InferenceEvent, ResponsesInputItem, ResponsesRequest, ResponsesTool } from "../protocol/types.js";

export const tools = [{ type: "function" as const, name: "lookup", description: "Look something up", parameters: { type: "object", properties: { id: { type: "string" } } } }];
/** The name the CLI sees for the `lookup` tool. */
export const lookupName = claudeToolName(normalizeResponsesTools(tools as unknown as ResponsesTool[])[0]);
export const png = "data:image/png;base64,iVBORw0KGgo=";
export const thread: InferenceContext = { threadId: "thread-1" };
export const user = (text: string): ResponsesInputItem => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const kind = (event: InferenceEvent) => event.type === "tool" ? `tool:${event.call.function.name}` : event.type;
export async function until(check: () => boolean | Promise<boolean>, ms = 4000): Promise<boolean> {
  const started = Date.now();
  while (!(await check())) { if (Date.now() - started > ms) return false; await sleep(15); }
  return true;
}

export type Entry = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export const providerId = "copilot-live-test";
export const adapter = (sessions: Record<string, unknown> | undefined = { mode: "live" }) => new CopilotSubscription({ id: providerId, type: "copilot-subscription", models: { alias: "fixture" }, ...(sessions ? { copilotSessions: sessions } : {}) });
/** A provider with no `copilotSessions` at all, which runs on the default mode. */
export const defaultAdapter = () => adapter(undefined);
export const live = (max = 4) => copilotLive({ max, parkMinutes: 30, toolWaitMinutes: 25 });

/** One request as the server runs it, plus the output items Codex would replay next time. */
export async function turn(provider: CopilotSubscription, input: ResponsesInputItem[], options: { context?: InferenceContext; extra?: Partial<ResponsesRequest>; controller?: AbortController } = {}) {
  const request: ResponsesRequest = { model: "fixture", input, tools, ...options.extra };
  const events: InferenceEvent[] = []; const writer = new ResponsesWriter("fixture", () => {});
  const controller = options.controller ?? new AbortController();
  for await (const event of provider.infer(restoreReasoning(request, "scope"), controller.signal, options.context ?? thread)) { events.push(event); writer.accept(event); }
  return { events, output: writer.result().output as ResponsesInputItem[], text: events.flatMap(event => event.type === "text" ? [event.text] : []).join("") };
}
export const callIds = (output: ResponsesInputItem[]): string[] => output.flatMap(item => item.type === "function_call" ? [item.call_id] : []);
export const outputFor = (output: ResponsesInputItem[], result: string | ((callId: string) => string)): ResponsesInputItem[] =>
  output.flatMap(item => item.type === "function_call" ? [{ type: "function_call_output" as const, call_id: item.call_id, output: typeof result === "function" ? result(item.call_id) : result }] : []);

/** Installs the scripted CLI as `copilot` and points the temp folder at a private one, so every leftover is visible. */
export async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-test-copilot-harness-"));
  const bin = join(directory, "bin"); const scratch = join(directory, "tmp"); const logPath = join(directory, "log.jsonl"); await mkdir(bin); await mkdir(scratch);
  const fixture = fileURLToPath(new URL("./copilot-live-fixture.js", import.meta.url)); const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  await writeFile(join(bin, "copilot"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)}\n`); await chmod(join(bin, "copilot"), 0o700);
  const names = ["PATH", "TMPDIR", "GATEWAY_COPILOT_LIVE_LOG", "GATEWAY_COPILOT_LIVE_DIE", "GATEWAY_COPILOT_LIVE_STALL", "GATEWAY_COPILOT_LIVE_CHILD", "GATEWAY_COPILOT_LIVE_SLOW_SWITCH"]; const previous = names.map(name => process.env[name]);
  process.env.PATH = bin + delimiter + process.env.PATH; process.env.TMPDIR = scratch; process.env.GATEWAY_COPILOT_LIVE_LOG = logPath; delete process.env.GATEWAY_COPILOT_LIVE_DIE; delete process.env.GATEWAY_COPILOT_LIVE_STALL; delete process.env.GATEWAY_COPILOT_LIVE_CHILD; delete process.env.GATEWAY_COPILOT_LIVE_SLOW_SWITCH;
  configureTelemetry(directory, "test"); const since = Date.now();
  const log = async (): Promise<Entry[]> => (await readFile(logPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  return {
    directory, scratch, log, die: join(directory, "die"), stall: join(directory, "stall"),
    liveDirs: async () => (await readdir(scratch)).filter(name => name.startsWith("gateway-copilot-")),
    pids: async () => [...new Set((await log()).map(entry => entry.pid as number))],
    sessions: async () => { await flushTelemetry(); return (await readTelemetry(directory, since)).filter(entry => entry.event === "copilot_session"); },
    restore: async () => {
      await live().stop();
      names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
      // Telemetry appends are asynchronous; let them land before the folder goes.
      await flushTelemetry(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
export type Harness = Awaited<ReturnType<typeof harness>>;
