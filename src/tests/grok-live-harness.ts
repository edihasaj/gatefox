import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeToolName } from "../providers/claude-tool-names.js";
import { normalizeResponsesTools } from "../protocol/request.js";
import { grokLive } from "../providers/grok-live.js";
import { GrokSubscription } from "../providers/grok.js";
import type { InferenceContext } from "../providers/provider.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { restoreReasoning } from "../protocol/reasoning-state.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { InferenceEvent, ResponsesInputItem, ResponsesRequest, ResponsesTool } from "../protocol/types.js";
import { grokLimits } from "../providers/grok-live-session.js";

export const tools = [{ type: "function" as const, name: "lookup", description: "Look something up", parameters: { type: "object", properties: { id: { type: "string" } } } }];
/** The name Grok sees for the `lookup` tool (after the `gateway__` server prefix). */
export const lookupName = claudeToolName(normalizeResponsesTools(tools as unknown as ResponsesTool[])[0]);
export const thread: InferenceContext = { threadId: "grok-thread-1" };
export const user = (text: string): ResponsesInputItem => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const kind = (event: InferenceEvent) => event.type === "tool" ? `tool:${event.call.function.name}` : event.type;
export async function until(check: () => boolean | Promise<boolean>, ms = 15000): Promise<boolean> {
  const started = Date.now();
  while (!(await check())) { if (Date.now() - started > ms) return false; await sleep(15); }
  return true;
}
export type Entry = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export const providerId = "grok-live-test";
export const adapter = (sessions: Record<string, unknown> | undefined = { mode: "live" }) => new GrokSubscription({ id: providerId, type: "grok-subscription", grokHome: homeOf.current, models: { alias: "grok-4.7" },
  modelMetadata: { alias: { reasoningEfforts: ["low", "high"] } }, ...(sessions ? { grokSessions: sessions } : {}) });
const homeOf: { current: string } = { current: "" };
export const live = (max = 4) => grokLive({ max, parkMinutes: 30, toolWaitMinutes: 25 });

/** One request as the server runs it, plus the output items Codex would replay next time. */
export async function turn(provider: GrokSubscription, input: ResponsesInputItem[], options: { context?: InferenceContext; extra?: Partial<ResponsesRequest>; controller?: AbortController; preserveSummaries?: boolean } = {}) {
  const request: ResponsesRequest = { model: "grok-4.7", input, tools, ...options.extra };
  const events: InferenceEvent[] = []; const writer = new ResponsesWriter("grok-4.7", () => {});
  const controller = options.controller ?? new AbortController();
  for await (const event of provider.infer(restoreReasoning(request, "scope", options.preserveSummaries ? { preserveSummaries: true } : undefined), controller.signal, options.context ?? thread)) { events.push(event); writer.accept(event); }
  return { events, output: writer.result().output as ResponsesInputItem[], text: events.flatMap(event => event.type === "text" ? [event.text] : []).join("") };
}
export const callIds = (output: ResponsesInputItem[]): string[] => output.flatMap(item => item.type === "function_call" ? [item.call_id] : []);
export const outputFor = (output: ResponsesInputItem[], result: string | ((callId: string) => string)): ResponsesInputItem[] =>
  output.flatMap(item => item.type === "function_call" ? [{ type: "function_call_output" as const, call_id: item.call_id, output: typeof result === "function" ? result(item.call_id) : result }] : []);

/** Installs the fake CLI as `grok` and points the temp folder at a private one, so every leftover is visible. */
export async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-test-grok-live-"));
  const bin = join(directory, "bin"); const scratch = join(directory, "tmp"); const logPath = join(directory, "log.jsonl"); const home = join(directory, "home");
  await mkdir(bin); await mkdir(scratch); await mkdir(home, { mode: 0o700 }); await writeFile(join(home, "auth.json"), "{}", { mode: 0o600 });
  homeOf.current = home;
  const fixture = fileURLToPath(new URL("./grok-acp-fixture.js", import.meta.url)); const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  await writeFile(join(bin, "grok"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`); await chmod(join(bin, "grok"), 0o700);
  const names = ["PATH", "TMPDIR", "GATEWAY_TEST_GROK_LOG", "GATEWAY_TEST_GROK_DIE_ON_START", "XAI_API_KEY"]; const previous = names.map(name => process.env[name]);
  process.env.PATH = bin + delimiter + process.env.PATH; process.env.TMPDIR = scratch; process.env.GATEWAY_TEST_GROK_LOG = logPath;
  delete process.env.GATEWAY_TEST_GROK_DIE_ON_START; process.env.XAI_API_KEY = "must-not-reach-grok";
  const limits = { ...grokLimits };
  configureTelemetry(directory, "test"); const since = Date.now();
  const log = async (): Promise<Entry[]> => (await readFile(logPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  return {
    directory, scratch, home, log,
    pids: async () => [...new Set((await log()).filter(entry => entry.op === "spawn").map(entry => entry.pid as number))],
    liveDirs: async () => (await readdir(scratch).catch(() => [] as string[])).filter(name => name.startsWith("gateway-grok-live-")),
    sessions: async () => { await flushTelemetry(); return (await readTelemetry(directory, since)).filter(entry => entry.event === "grok_session"); },
    restore: async () => {
      await live().stop();
      Object.assign(grokLimits, limits); delete grokLimits.parkMs; delete grokLimits.toolWaitMs;
      names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
      configureTelemetry(join(tmpdir(), "grok-live-late"), "test");
      await flushTelemetry(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
export type Harness = Awaited<ReturnType<typeof harness>>;
