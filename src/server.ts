import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { gatewayToken, validBearer, type GatewayConfig, type ProviderConfig } from "./config.js";
import { ClaudeSubscription } from "./providers/claude.js";
import { CopilotSubscription } from "./providers/copilot.js";
import { ResponsesAPI } from "./providers/responses-api.js";
import { AnthropicAPI } from "./providers/anthropic-api.js";
import { ChatCompletionsAPI } from "./providers/chat-completions-api.js";
import { ProviderError, type Provider } from "./providers/provider.js";
import { ResponsesWriter } from "./protocol/responses.js";
import { responsesToChatRequest } from "./protocol/request.js";
import type { ResponsesRequest } from "./protocol/types.js";
import { modelCatalog } from "./catalog.js";
import { reasoningScope, restoreReasoning, wrapReasoning } from "./protocol/reasoning-state.js";
import { classifyProviderFailure, providerFailureDiagnostic } from "./provider-failure.js";
import { Admission } from "./admission.js";

const send = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
const waitForDrain = (res: ServerResponse, signal: AbortSignal) => new Promise<void>(resolve => {
  const finished = () => { res.off("drain", finished); res.off("close", finished); signal.removeEventListener("abort", finished); resolve(); };
  res.once("drain", finished); res.once("close", finished); signal.addEventListener("abort", finished, { once: true });
  if (!res.writableNeedDrain || res.destroyed || signal.aborted) finished();
});
export function createProvider(config: ProviderConfig): Provider {
  return config.type === "claude-subscription" ? new ClaudeSubscription(config) : config.type === "copilot-subscription" ? new CopilotSubscription(config) : config.type === "anthropic-api" ? new AnthropicAPI(config) : config.type === "chat-completions-api" ? new ChatCompletionsAPI(config) : new ResponsesAPI(config);
}
async function body(req: IncomingMessage): Promise<ResponsesRequest> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 10 * 1024 * 1024) throw new ProviderError("request_too_large", "Request exceeds 10 MiB", 413); chunks.push(chunk); }
  let value: ResponsesRequest;
  try { value = JSON.parse(Buffer.concat(chunks).toString()) as ResponsesRequest; } catch { throw new ProviderError("invalid_json", "Request must be valid JSON", 400); }
  if (!value || typeof value !== "object" || typeof value.model !== "string" || (value.stream !== undefined && typeof value.stream !== "boolean")) throw new ProviderError("invalid_request", "model must be a string and stream must be a boolean", 400);
  return value;
}
export type GatewayServer = Server & { restartWhenIdle(callback: () => void): boolean };
export interface GatewayFailure {
  event: "request_failed"; requestId: string; providerId?: string; model?: string;
  durationMs: number; code: string; status: number; abortCause?: "timeout" | "cancelled";
}
export interface GatewayStartOptions { heartbeatMs?: number; onFailure?: (failure: GatewayFailure) => void }
export async function startGateway(config: GatewayConfig, factory = createProvider, reload?: () => Promise<GatewayConfig>, options: GatewayStartOptions = {}): Promise<GatewayServer> {
  const heartbeatMs = options.heartbeatMs ?? 15000;
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 1) throw new Error("Heartbeat interval must be positive");
  if (config.clientOnly) throw new Error("This is a remote client configuration; start its SSH tunnel instead of a local inference daemon");
  const token = await gatewayToken(config.stateDirectory);
  const buildRoutes = (current: GatewayConfig) => new Map(current.providers.flatMap(provider => {
    const adapter = factory(provider);
    return Object.entries(provider.models).map(([alias, model]) => [alias, { adapter, model, id: provider.id, reasoningScope: reasoningScope(provider) }] as const);
  }));
  let current = config; let routes = buildRoutes(config);
  const snapshot = async () => {
    const next = reload ? await reload() : current;
    if (next !== current) { const updated = buildRoutes(next); routes = updated; current = next; }
    return { config: current, routes };
  };
  const active = new Set<AbortController>();
  const admission = new Admission(config.maxConcurrent || 4);
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++; let released = false;
    const release = () => { if (!released) { released = true; requests--; } };
    res.once("finish", release); res.once("close", release);
    const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const requestId = randomUUID(); res.setHeader("X-Request-Id", requestId);
    if (req.method === "GET" && path === "/health") {
      try { await snapshot(); send(res, 200, { status: "ok", active: active.size, running: admission.running, queued: admission.queued, idleRestart: true, idleUpgrade: true }); }
      catch { send(res, 503, { status: "configuration_error", active: active.size, idleRestart: true }); }
      return;
    }
    if (req.headers.origin) { send(res, 403, { error: { code: "cross_origin", message: "Browser cross-origin requests are disabled" } }); return; }
    if (!validBearer(req.headers.authorization, token)) { send(res, 401, { error: { code: "authentication", message: "Gateway bearer token required" } }); return; }
    let state: Awaited<ReturnType<typeof snapshot>>;
    try { state = await snapshot(); }
    catch { send(res, 503, { error: { code: "configuration_error", message: "Gateway configuration is invalid; fix it before retrying" } }); return; }
    if (req.method === "GET" && path === "/v1/models") { send(res, 200, { object: "list", data: [...state.routes].map(([id, route]) => ({ id, object: "model", owned_by: route.id })) }); return; }
    if (req.method === "GET" && path === "/v1/model-catalog") { send(res, 200, modelCatalog(state.config)); return; }
    if (req.method !== "POST" || path !== "/v1/responses") { send(res, 404, { error: { code: "not_found", message: "Unknown endpoint" } }); return; }
    if (active.size >= (state.config.maxConcurrent || 4) + 32) { res.setHeader("Retry-After", "1"); send(res, 429, { error: { code: "busy", message: "Gateway waiting queue is full; retry shortly" } }); return; }
    const controller = new AbortController(); active.add(controller);
    let releaseAdmission: (() => void) | undefined;
    let writer: ResponsesWriter | undefined;
    let heartbeat: NodeJS.Timeout | undefined; let abortCause: "timeout" | "cancelled" | undefined;
    let providerId: string | undefined; let model: string | undefined;
    const startedAt = Date.now();
    const timeout = setTimeout(() => {
      abortCause ||= "timeout"; clearInterval(heartbeat); controller.abort();
      if (res.writableNeedDrain || (res.writableEnded && !res.writableFinished)) res.destroy();
    }, state.config.timeoutMs || 600000).unref();
    const clearDeadline = () => { clearTimeout(timeout); res.off("finish", clearDeadline); res.off("close", clearDeadline); };
    res.once("finish", clearDeadline); res.once("close", clearDeadline);
    const cancel = () => { if (!res.writableEnded) { abortCause ||= "cancelled"; clearInterval(heartbeat); controller.abort(); } };
    res.once("close", cancel);
    try {
      const request = await body(req);
      const route = state.routes.get(request.model);
      if (!route) throw new ProviderError("model_not_found", "Unknown model alias", 404);
      providerId = route.id; model = request.model;
      responsesToChatRequest(request); // Validate the supported protocol before invoking any provider.
      admission.setLimit(state.config.maxConcurrent || 4); admission.check();
      const streaming = request.stream === true;
      let lastEventAt = Date.now();
      writer = new ResponsesWriter(request.model, event => { if (streaming && !res.destroyed) { lastEventAt = Date.now(); res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); } });
      if (streaming) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
      writer.begin();
      if (streaming) heartbeat = setInterval(() => {
        if (!controller.signal.aborted && !res.destroyed && !res.writableNeedDrain && Date.now() - lastEventAt >= heartbeatMs) writer?.progress();
      }, heartbeatMs).unref();
      releaseAdmission = await admission.acquire(controller.signal);
      controller.signal.throwIfAborted();
      for await (const event of route.adapter.infer({ ...restoreReasoning(request, route.reasoningScope), model: route.model }, controller.signal)) {
        if (controller.signal.aborted || res.destroyed) break;
        writer.accept(event.type === "reasoning-state" ? { ...event, item: wrapReasoning(event.item, route.reasoningScope) } : event);
        if (writer.completed) clearInterval(heartbeat);
        if (streaming && res.writableNeedDrain) await waitForDrain(res, controller.signal);
        if (controller.signal.aborted || res.destroyed) break;
      }
      if (!writer.completed) throw new ProviderError(controller.signal.aborted ? "cancelled" : "incomplete", controller.signal.aborted ? "Request cancelled or timed out" : "Provider did not complete", 504);
      if (!res.destroyed) {
        if (controller.signal.aborted && res.writableNeedDrain) res.destroy();
        else if (!streaming) send(res, 200, writer.result());
        else res.end();
      }
    } catch (error) {
      clearInterval(heartbeat);
      const known = classifyProviderFailure(error, abortCause);
      const failure: GatewayFailure = { event: "request_failed", requestId, ...(providerId ? { providerId, model } : {}), durationMs: Date.now() - startedAt, code: known.code, status: known.status, ...(abortCause ? { abortCause } : {}) };
      try { if (options.onFailure) options.onFailure(failure); else console.error(JSON.stringify(providerFailureDiagnostic({ requestId, providerId, modelAlias: model, durationMs: failure.durationMs, failure: known, abortCause }))); } catch { /* Diagnostics never replace the request outcome. */ }
      if (!res.destroyed) {
        if (res.writableNeedDrain && controller.signal.aborted) res.destroy();
        else if (res.headersSent && writer) {
          writer.fail(known.code, known.message);
          if (res.writableNeedDrain) await waitForDrain(res, controller.signal);
          if (!res.destroyed) { if (controller.signal.aborted && res.writableNeedDrain) res.destroy(); else res.end(); }
        }
        else send(res, known.status, { error: { code: known.code, message: known.message } });
      }
    } finally { clearInterval(heartbeat); res.off("close", cancel); controller.abort(); releaseAdmission?.(); active.delete(controller); }
  });
  server.requestTimeout = 30000;
  const close = server.close.bind(server);
  server.close = callback => { for (const controller of active) controller.abort(); return close(callback); };
  const controlled = server as GatewayServer;
  controlled.restartWhenIdle = callback => {
    // Includes body uploads and catalog reads, not only provider inference.
    if (requests || active.size) return false;
    close(callback); return true;
  };
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  return controlled;
}
