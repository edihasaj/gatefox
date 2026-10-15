import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import type { GatewayConfig } from "../config.js";

/** Shared setup for the speed tests; request shapes copy what the installed desktop sends. */
export type ObjectValue = Record<string, unknown>;
export const gateway = "subscription_gateway";

// The codex row advertises Fast and names it its default; the claude row has no Fast.
export async function fixture(saved?: ObjectValue) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-speed-"));
  if (saved) await writeFile(join(directory, "desktop-preferences.json"), JSON.stringify(saved));
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: directory, providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { "claude/model": "model" }, modelMetadata: { "claude/model": { reasoningEfforts: ["low", "high"] } } },
    { id: "codex", type: "codex-subscription", label: "Codex", credentialFile: "unused", models: { "codex/model": "model" },
      modelMetadata: { "codex/model": { reasoningEfforts: ["low", "medium", "high", "xhigh"], defaultReasoningEffort: "high",
        serviceTiers: [{ id: "priority", name: "Fast", description: "Priority routing" }], defaultServiceTier: "priority" } } },
  ] };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const threads = new Map<string, { modelProvider: string; model: string }>(); let counter = 0;
  const native = { config: { model: "native" } as ObjectValue };
  const nativeRow = (model: string) => ({ id: model, model, displayName: model, hidden: false, defaultServiceTier: "priority", serviceTiers: [{ id: "priority", name: "Fast", description: "" }] });
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params: structuredClone(params) });
    const thread = typeof params.threadId === "string" ? threads.get(params.threadId) : undefined;
    switch (method) {
      case "model/list": return { data: [nativeRow("native"), nativeRow("native-two")], nextCursor: null };
      case "thread/start": {
        const id = `chat-${++counter}`; const started = { modelProvider: String(params.modelProvider || "openai"), model: String(params.model || "native") };
        threads.set(id, started); return { thread: { id }, ...started, serviceTier: params.serviceTier ?? null };
      }
      case "thread/resume": case "thread/fork": return { thread: { id: params.threadId }, modelProvider: params.modelProvider ?? thread?.modelProvider, model: params.model ?? thread?.model, serviceTier: params.serviceTier ?? null };
      case "thread/read":
        if (!thread) throw Object.assign(new Error(`thread not loaded: ${params.threadId}`), { code: -32600 });
        return { thread: { id: params.threadId, ...thread } };
      case "thread/settings/update": return { status: "applied" };
      case "turn/start": return { turn: { id: `turn-${++counter}` } };
      case "config/read": return { config: structuredClone(native.config) };
      default: return { status: "ok" };
    }
  };
  const connect = async () => { const router = new AppServerRouter(config, backend, undefined, undefined, join(directory, "native-home")); await router.initialize(); return router; };
  const last = (method: string) => calls.filter(call => call.method === method).at(-1)!.params;
  const file = async () => JSON.parse(await readFile(join(directory, "desktop-preferences.json"), "utf8")) as ObjectValue;
  return { directory, config, backend, calls, native, connect, last, file, router: await connect() };
}
export type F = Awaited<ReturnType<typeof fixture>>;
export type R = AppServerRouter;

export const object = (value: unknown) => value as ObjectValue;
export const pick = (r: R, threadId: string, serviceTier: string | null) => r.request("thread/settings/update", { threadId, serviceTier });
export const batch = (r: R, ...edits: Array<[string, string | null]>) => r.request("config/batchWrite", { edits: edits.map(([keyPath, value]) => ({ keyPath, value, mergeStrategy: "upsert" })), filePath: null, expectedVersion: null, reloadUserConfig: true });
export const defaultWrite = (r: R, value: string | null) => batch(r, ["service_tier", value]);
export const modelWrite = (r: R, model: string, effort: string) => batch(r, ["model", model], ["model_reasoning_effort", effort]);
export const start = (r: R, model: string, serviceTier: string | null, effort?: string) => r.request("thread/start", { cwd: "/tmp/project", model, modelProvider: null, serviceTier,
  config: effort === undefined ? {} : { model_reasoning_effort: effort }, personality: null, ephemeral: null, baseInstructions: null, threadSource: "user", experimentalRawEvents: false, dynamicTools: null });
export const turn = (r: R, threadId: string, serviceTier: string | null, effort: string) => r.request("turn/start", { threadId, turnTrigger: "composer", model: null, serviceTier, effort, summary: "none",
  input: [{ type: "text", text: "hi", text_elements: [] }], collaborationMode: null });
export const id = (result: ObjectValue) => String(object(result.thread).id);
export const refused = (error: unknown) => (error as { code?: number }).code === -32002 && /Fast stays with the chat/.test((error as Error).message);
export const savedTier = async (f: F) => ({ file: (await f.file()).service_tier, read: object((await f.router.request("config/read", {})).config).service_tier });
export const settled = (threadId: string, model: string, serviceTier: string | null) => ({ method: "thread/settings/updated", emittedAtMs: Date.now(),
  params: { threadId, threadSettings: { model, modelProvider: gateway, serviceTier } } });
