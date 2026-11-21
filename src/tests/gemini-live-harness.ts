import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeToolName } from "../providers/claude-tool-names.js";
import { normalizeResponsesTools } from "../protocol/request.js";
import { geminiLive } from "../providers/gemini-live.js";
import { GeminiSubscription } from "../providers/gemini.js";
import type { InferenceContext } from "../providers/provider.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { restoreReasoning } from "../protocol/reasoning-state.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { InferenceEvent, ResponsesInputItem, ResponsesRequest, ResponsesTool } from "../protocol/types.js";
import { geminiLimits } from "../providers/gemini-live-session.js";

export const tools = [{ type: "function" as const, name: "lookup", description: "Look something up", parameters: { type: "object", properties: { id: { type: "string" } } } }];
/** The name the gateway's MCP endpoint lists this caller tool under. */
export const lookupName = claudeToolName(normalizeResponsesTools(tools as unknown as ResponsesTool[])[0]);
/** A caller tool whose own name is one of the Gemini CLI's built-ins, which the guard must still treat as the caller's. */
export const builtinTools = [{ type: "function" as const, name: "grep_search", description: "Search the workspace", parameters: { type: "object", properties: { pattern: { type: "string" } } } }];
export const grepName = claudeToolName(normalizeResponsesTools(builtinTools as unknown as ResponsesTool[])[0]);
export const thread: InferenceContext = { threadId: "gemini-thread-1" };
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
export const providerId = "gemini-live-test";
const homeOf: { current: string } = { current: "" };
export const adapter = (sessions: Record<string, unknown> | undefined = { mode: "live" }) => new GeminiSubscription({ id: providerId, type: "gemini-subscription", geminiHome: homeOf.current, models: { alias: "gemini-ultra" },
  modelMetadata: { alias: { reasoningEfforts: ["low", "high"] } }, ...(sessions ? { geminiSessions: sessions } : {}) });
export const live = (max = 4) => geminiLive({ max, parkMinutes: 30, toolWaitMinutes: 25 });

/** One request as the server runs it, plus the output items Codex would replay next time. */
export async function turn(provider: GeminiSubscription, input: ResponsesInputItem[], options: { context?: InferenceContext; extra?: Partial<ResponsesRequest>; controller?: AbortController; preserveSummaries?: boolean } = {}) {
  const request: ResponsesRequest = { model: "gemini-ultra", input, tools, ...options.extra };
  const events: InferenceEvent[] = []; const writer = new ResponsesWriter("gemini-ultra", () => {});
  const controller = options.controller ?? new AbortController();
  for await (const event of provider.infer(restoreReasoning(request, "scope", options.preserveSummaries ? { preserveSummaries: true } : undefined), controller.signal, options.context ?? thread)) { events.push(event); writer.accept(event); }
  return { events, output: writer.result().output as ResponsesInputItem[], text: events.flatMap(event => event.type === "text" ? [event.text] : []).join("") };
}
export const callIds = (output: ResponsesInputItem[]): string[] => output.flatMap(item => item.type === "function_call" ? [item.call_id] : []);
export const outputFor = (output: ResponsesInputItem[], result: string | ((callId: string) => string)): ResponsesInputItem[] =>
  output.flatMap(item => item.type === "function_call" ? [{ type: "function_call_output" as const, call_id: item.call_id, output: typeof result === "string" ? result : result(item.call_id) } as ResponsesInputItem] : []);

/** Installs the fake CLI as `gemini` and points the temp folder at a private one, so every leftover is visible. */
export async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-test-gemini-live-"));
  const bin = join(directory, "bin"); const scratch = join(directory, "tmp"); const logPath = join(directory, "log.jsonl"); const home = join(directory, "home");
  await mkdir(bin); await mkdir(scratch); await mkdir(join(home, ".gemini"), { recursive: true, mode: 0o700 });
  // A real sign-in carries both tokens; the gateway refuses to spawn without them, so the fixture's home must look signed in.
  await writeFile(join(home, ".gemini/oauth_creds.json"), JSON.stringify({ access_token: "test-access", refresh_token: "test-refresh" }), { mode: 0o600 });
  homeOf.current = home;
  const fixture = fileURLToPath(new URL("./gemini-acp-fixture.js", import.meta.url)); const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  await writeFile(join(bin, "gemini"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`); await chmod(join(bin, "gemini"), 0o700);
  const names = ["PATH", "TMPDIR", "GATEWAY_TEST_GEMINI_LOG", "GATEWAY_TEST_GEMINI_DIE_ON_START", "GATEWAY_TEST_GEMINI_REFRESH", "GATEWAY_TEST_GEMINI_BROWSER", "GATEWAY_TEST_GEMINI_HANG", "GATEWAY_TEST_GEMINI_LOGIN",
    "GOOGLE_API_KEY", "GOOGLE_CLOUD_PROJECT", "VERTEX_PROJECT", "GEMINI_API_KEY", "CI", "SSH_CONNECTION", "BROWSER", "DEBIAN_FRONTEND"];
  const previous = names.map(name => process.env[name]);
  process.env.PATH = bin + delimiter + process.env.PATH; process.env.TMPDIR = scratch; process.env.GATEWAY_TEST_GEMINI_LOG = logPath;
  delete process.env.GATEWAY_TEST_GEMINI_DIE_ON_START; delete process.env.GATEWAY_TEST_GEMINI_REFRESH; delete process.env.GATEWAY_TEST_GEMINI_BROWSER; delete process.env.GATEWAY_TEST_GEMINI_HANG; delete process.env.GATEWAY_TEST_GEMINI_LOGIN;
  // Each of these makes the real CLI skip the browser and read a code from stdin, which for an ACP session is the protocol stream.
  process.env.CI = "true"; process.env.SSH_CONNECTION = "10.0.0.1 1 10.0.0.2 22"; process.env.BROWSER = "www-browser"; process.env.DEBIAN_FRONTEND = "noninteractive";
  // None of these may reach the CLI: a subscription spends the Google login, never an API key.
  process.env.GOOGLE_API_KEY = "must-not-reach-gemini"; process.env.GOOGLE_CLOUD_PROJECT = "must-not-reach-gemini";
  process.env.VERTEX_PROJECT = "must-not-reach-gemini"; process.env.GEMINI_API_KEY = "must-not-reach-gemini";
  const limits = { ...geminiLimits };
  configureTelemetry(directory, "test"); const since = Date.now();
  const log = async (): Promise<Entry[]> => (await readFile(logPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  return {
    directory, scratch, home, log,
    pids: async () => [...new Set((await log()).filter(entry => entry.op === "spawn").map(entry => entry.pid as number))],
    liveDirs: async () => (await readdir(scratch).catch(() => [] as string[])).filter(name => name.startsWith("gateway-gemini-live-") || name.startsWith("gateway-gemini-login-")),
    sessions: async () => { await flushTelemetry(); return (await readTelemetry(directory, since)).filter(entry => entry.event === "gemini_session"); },
    restore: async () => {
      await live().stop();
      Object.assign(geminiLimits, limits); delete geminiLimits.parkMs; delete geminiLimits.toolWaitMs;
      names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
      configureTelemetry(join(tmpdir(), "gemini-live-late"), "test");
      await flushTelemetry(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
export type Harness = Awaited<ReturnType<typeof harness>>;
