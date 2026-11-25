import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { AdmissionRegistry } from "../admission-registry.js";
import { gatewayToken, validateConfig, type GatewayConfig } from "../config.js";
import { startGateway, type GatewayServer, type GatewayStartOptions } from "../server.js";

export type Mode = "ok" | "frozen" | "502" | "503" | "500" | "400" | "401" | "429" | "reset" | "head-reset" | "mid-reset" | "empty";
export interface Seen { session?: string; body: Record<string, unknown>; path: string }
/** A worker's front door: chat completions, the model list and its capacity, each of which can be made to fail. */
export class FakeSpark {
  mode: Mode = "ok"; slots: number | undefined = 10; seen: Seen[] = []; running = 0; peak = 0; frozen = 0; hold?: Promise<void>; port = 0;
  private server?: Server;
  constructor(readonly name: string) {}
  async start(): Promise<void> {
    const server = createServer((req, res) => { void this.answer(req, res).catch(() => res.destroy()); }); this.server = server;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.port, "127.0.0.1", () => resolve()); });
    this.port = (server.address() as { port: number }).port;
  }
  async stop(): Promise<void> { const server = this.server; this.server = undefined; if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  get chats(): Seen[] { return this.seen.filter(entry => entry.path === "/v1/chat/completions"); }
  private async answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== "Bearer fixture-key") { res.writeHead(401).end("{}"); return; }
    // A frozen machine: the connection is accepted and nothing ever comes back.
    if (this.mode === "frozen") { if (req.url === "/v1/chat/completions") this.frozen++; return; }
    const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/v1/models") { json(200, { object: "list", data: [{ id: "qwen3.8-flash-next", object: "model" }] }); return; }
    if (req.url === "/v1/capacity") {
      if (this.slots === undefined) { json(404, {}); return; }
      json(200, { object: "inference_capacity", version: 1, complete: true, observed_at: Date.now() / 1000, models: this.slots ? [{ id: "qwen3.8-flash-next", max_concurrent_requests: this.slots }] : [] }); return;
    }
    let text = ""; for await (const chunk of req) text += String(chunk);
    this.seen.push({ path: req.url!, session: req.headers["session-id"] as string | undefined, body: JSON.parse(text) as Record<string, unknown> });
    if (/^\d+$/.test(this.mode)) { json(Number(this.mode), { error: { message: "fixture", type: "fixture" } }); return; }
    if (this.mode === "reset") { res.destroy(); return; }
    this.running++; this.peak = Math.max(this.peak, this.running);
    try {
      res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders();
      if (this.mode === "head-reset") { await delay(20); res.destroy(); return; }
      if (this.hold) await this.hold;
      const chunk = (delta: object, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "qwen3.8-flash-next", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (this.mode !== "empty") chunk({ role: "assistant", content: `from ${this.name}` });
      if (this.mode === "mid-reset") { await delay(20); res.destroy(); return; }
      chunk({}, "stop");
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "qwen3.8-flash-next", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } finally { this.running--; }
  }
}

process.env.POOL_FIXTURE_KEY = "fixture-key";
const metadata = { contextWindow: 262144, contextWindowCap: 262144, inputModalities: ["text", "image"], reasoningEfforts: ["low", "medium", "xhigh"], multiAgentVersion: "v2" };
export function poolConfig(stateDirectory: string, ports: number[], patch: (providers: Record<string, unknown>[]) => void = () => {}): GatewayConfig {
  const one = (id: string, label: string, port: number): Record<string, unknown> => ({ id, label, type: "chat-completions-api", baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "POOL_FIXTURE_KEY",
    models: { [`${id}/qwen3.8-flash-next`]: "qwen3.8-flash-next" }, modelMetadata: { [`${id}/qwen3.8-flash-next`]: { ...metadata, displayName: "Qwen 3.8 Flash Next" } },
    sessionAffinity: true, capacityDiscovery: true, selfHosted: true, chatTemplateReasoningEffort: true });
  // The pool keeps the address of today's router, which nothing may dial once the pool is on: port 9 refuses.
  const providers = [{ ...one("qwen", "Qwen", 9), pool: ports.map((_, index) => `qwen-${index + 1}`) }, ...ports.map((port, index) => one(`qwen-${index + 1}`, `Qwen ${index + 1}`, port))];
  patch(providers);
  return validateConfig({ version: 1, port: 0, stateDirectory, providers });
}
export interface PoolHarness { root: string; sparks: FakeSpark[]; server: GatewayServer; admissions: AdmissionRegistry; base: string; headers: Record<string, string>; config: GatewayConfig; current: { config: GatewayConfig };
  ask: (thread: string | undefined, body?: Record<string, unknown>, headers?: Record<string, string>) => Promise<{ status: number; text: string; code?: string }>; close: () => Promise<void> }
export async function eventually(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (await check()) return; await delay(10); }
  assert.fail(message);
}
export async function openPool(options: { sparks?: FakeSpark[]; root?: string; patch?: (providers: Record<string, unknown>[]) => void; start?: GatewayStartOptions; capacity?: boolean } = {}): Promise<PoolHarness> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "provider-pool-"));
  const sparks = options.sparks ?? [new FakeSpark("one"), new FakeSpark("two")];
  if (!options.sparks) for (const spark of sparks) await spark.start();
  const config = poolConfig(root, sparks.map(spark => spark.port), options.patch); const current = { config };
  const admissions = new AdmissionRegistry();
  const server = await startGateway(config, undefined, async () => current.config, { admissionRegistry: admissions, onFailure() {}, upstreamCapacity: { intervalMs: 25 }, ...options.start });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${await gatewayToken(root)}`, "Content-Type": "application/json" };
  const ask: PoolHarness["ask"] = async (thread, body = {}, extra = {}) => {
    const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: { ...headers, ...(thread ? { "thread-id": thread } : {}), ...extra },
      body: JSON.stringify({ model: "qwen/qwen3.8-flash-next", input: "hello", ...body }) });
    const value = await response.json() as { output?: Array<{ content?: Array<{ text?: string }> }>; error?: { code?: string } };
    return { status: response.status, text: value.output?.flatMap(item => item.content ?? []).map(part => part.text ?? "").join("") ?? "", ...(value.error?.code ? { code: value.error.code } : {}) };
  };
  if (options.capacity !== false) await eventually(() => config.providers[0].pool!.every((id, index) => admissions.limit(id) === Math.min(64, sparks[index].slots ?? 4)), "capacity must be discovered");
  return { root, sparks, server, admissions, base, headers, config, current, ask, close: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const spark of sparks) await spark.stop();
    await rm(root, { recursive: true, force: true });
  } };
}
