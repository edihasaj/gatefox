import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { gatewayToken, validBearer, type GatewayConfig, type ProviderConfig } from "./config.js";
import { ClaudeSubscription } from "./providers/claude.js";
import { CopilotSubscription, retireUnconfiguredCopilotScopes } from "./providers/copilot.js";
import { sweepCopilotDirectories } from "./providers/copilot-directories.js";
import { ResponsesAPI } from "./providers/responses-api.js";
import { AnthropicAPI } from "./providers/anthropic-api.js";
import { ChatCompletionsAPI } from "./providers/chat-completions-api.js";
import { ProviderError, inferenceContext, maxTurnStateLength, type InferenceContext, type Provider } from "./providers/provider.js";
import { ResponsesWriter } from "./protocol/responses.js";
import { responsesToChatRequest } from "./protocol/request.js";
import { stripOpenAIInternal } from "./protocol/openai-internal.js";
import type { InferenceEvent, ResponsesRequest, Usage, UsageAccounting } from "./protocol/types.js";
import { modelCatalog } from "./catalog.js";
import { reasoningScope, restoreReasoning, wrapReasoning } from "./protocol/reasoning-state.js";
import { classifyProviderFailure, providerFailureDiagnostic, streamFailureCode, translationFailureFields, unsupportedCompactionFailure } from "./provider-failure.js";
import { Admission } from "./admission.js";
import { ProviderUsageStore } from "./provider-usage.js";
import { ObservedContextWindows } from "./model-refresh.js";
import { telemetry } from "./telemetry.js";
import { flushRecords, recordUsage, usageLedgerMarks, type LedgerStatus } from "./usage-ledger.js";
import { releaseState } from "./self-update.js";
import { reportException } from "./error-report.js";
import type { ClaudeLimit } from "./providers/claude-usage.js";
import { runShutdownHooks, runtimeBusy, shutdownDrainMs } from "./runtime-activity.js";
import { autoReviewModels, isAutoReviewModel } from "./auto-review.js";
import { hasPlanLogin } from "./auth/chatgpt.js";

const send = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
/** What this release guarantees on the wire; `/health` advertises it so operators can tell an old daemon from a new one. */
export const gatewayFeatures = ["responses-ws-426", "openai-internal-strip", "native-identity-v1"];
const isUpgrade = (value: string | undefined): boolean => value !== undefined && !/^(no-op|none|unset)$/i.test(value);
const upgradeStatusText = (status: number): string => status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : status === 426 ? "Upgrade Required" : "Bad Request";
/** Refuses an upgrade on its raw socket: this API speaks no upgrade protocol. The 426 carries no body. */
function refuseUpgrade(socket: Duplex, status: number, error?: { code: string; message: string }): void {
  socket.on("error", () => { /* A client that resets before reading the refusal is expected. */ });
  const payload = error ? JSON.stringify({ error }) : "";
  const head = `HTTP/1.1 ${status} ${upgradeStatusText(status)}\r\nConnection: close\r\n` +
    (error ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n` : "Content-Length: 0\r\n");
  socket.end(`${head}\r\n${payload}`);
}
const waitForDrain = (res: ServerResponse, signal: AbortSignal) => new Promise<void>(resolve => {
  const finished = () => { res.off("drain", finished); res.off("close", finished); signal.removeEventListener("abort", finished); resolve(); };
  res.once("drain", finished); res.once("close", finished); signal.addEventListener("abort", finished, { once: true });
  if (!res.writableNeedDrain || res.destroyed || signal.aborted) finished();
});
/** After a request stops early, how long its provider may take to hand over usage it already received. */
const usageDrainMs = 3000;
/**
 * Reads a stopped provider on, for its usage only, until it ends or `usageDrainMs` passes: a model call that was billed
 * before the caller left still reaches the ledger and telemetry. A provider still running after that is closed.
 */
async function drainUsage(source: AsyncIterator<InferenceEvent>, take: (event: InferenceEvent) => void): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), usageDrainMs); });
  try {
    for (;;) {
      const step = await Promise.race([source.next(), expired]);
      if (!step) { void Promise.resolve(source.return?.()).catch(() => undefined); return; }
      if (step.done) return;
      take(step.value);
    }
  } catch { /* A stopped provider ends by throwing; the usage it reported is already taken. */ }
  finally { clearTimeout(timer); }
}
/** The one subscription alias that serves a bare vendor model name, if unambiguous. */
export function nativeModelAlias(config: GatewayConfig, model: string): string | undefined {
  const vendor = /^claude-/.test(model) ? "claude-subscription" : /^(gpt-|o\d|codex-)/.test(model) ? "codex-subscription" : undefined;
  if (!vendor) return;
  const matches = config.providers.filter(provider => provider.type === vendor).flatMap(provider => Object.entries(provider.models).filter(([, upstream]) => upstream === model).map(([alias]) => alias));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The Codex subscription provider that serves a reviewer slug when no alias names it: the only one the
 * gateway has. With none or several, which account's data the review would use is not decided, so no
 * provider serves it (fail closed).
 */
export function autoReviewProvider(config: GatewayConfig, slug: string): ProviderConfig | undefined {
  if (!isAutoReviewModel(slug)) return;
  const codex = config.providers.filter(provider => provider.type === "codex-subscription");
  return codex.length === 1 ? codex[0] : undefined;
}
/** Where a reviewer slug goes: an alias for it keeps its precedence, as for any bare model name, and otherwise the one Codex subscription. */
export function autoReviewTarget(config: GatewayConfig, slug: string): ProviderConfig | undefined {
  if (!isAutoReviewModel(slug)) return;
  const alias = config.providers.some(provider => Object.hasOwn(provider.models, slug)) ? slug : nativeModelAlias(config, slug);
  return (alias ? config.providers.find(provider => Object.hasOwn(provider.models, alias)) : undefined) ?? autoReviewProvider(config, slug);
}
/** The reviewer slugs this gateway can serve to a Codex login right now; any failure advertises nothing. */
async function advertisedReviewers(config: GatewayConfig): Promise<string[]> {
  try {
    const served: string[] = [];
    for (const slug of autoReviewModels) {
      const target = autoReviewTarget(config, slug);
      // An alias spelled exactly like the slug takes the request, so it must really name the reviewer model; one that
      // points at another model would run the reviews on that model while the catalog claimed the native reviewer.
      const named = config.providers.find(provider => Object.hasOwn(provider.models, slug));
      if (named && named.models[slug] !== slug) continue;
      if (target?.type === "codex-subscription" && target.credentialFile && await hasPlanLogin(target.credentialFile)) served.push(slug);
    }
    return served;
  } catch { return []; }
}

export function createProvider(config: ProviderConfig, onUsage?: (limit: ClaudeLimit) => Promise<void>, onContextWindow?: (model: string, contextWindow: number) => void): Provider {
  return config.type === "claude-subscription" ? new ClaudeSubscription(config, onUsage, onContextWindow) : config.type === "copilot-subscription" ? new CopilotSubscription(config) : config.type === "anthropic-api" ? new AnthropicAPI(config) : config.type === "chat-completions-api" ? new ChatCompletionsAPI(config) : new ResponsesAPI(config);
}
/**
 * Whole-request cap. Native Codex sends long chats with inline screenshots to its upstream with no
 * client-side byte limit, and upstreams accept tens of megabytes, so this stays above them and lets
 * the upstream decide. It only bounds gateway memory.
 */
export const maxRequestBytes = 64 * 1024 * 1024;
/**
 * Names the missing alias so a chat left on a removed provider says what to do. Only
 * alias characters are echoed, and the length is capped.
 */
export function unknownModelMessage(model: string): string {
  const shown = model.replace(/[^A-Za-z0-9._/:@-]/g, "").slice(0, 80);
  return `Model "${shown}" is not offered by this gateway; it may have been turned off. Choose another model for this chat.`;
}
async function body(req: IncomingMessage): Promise<ResponsesRequest> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxRequestBytes) throw new ProviderError("request_too_large", "Request exceeds 64 MiB", 413); chunks.push(chunk); }
  let value: ResponsesRequest;
  try { value = JSON.parse(Buffer.concat(chunks).toString()) as ResponsesRequest; } catch { throw new ProviderError("invalid_json", "Request must be valid JSON", 400); }
  if (!value || typeof value !== "object" || typeof value.model !== "string" || (value.stream !== undefined && typeof value.stream !== "boolean")) throw new ProviderError("invalid_request", "model must be a string and stream must be a boolean", 400);
  return value;
}
const sendUpgradeRefusal = (res: ServerResponse): void => { res.writeHead(426, { Connection: "close", "Content-Length": "0" }); res.end(); };
export type GatewayServer = Server & { restartWhenIdle(callback: () => void): boolean; isIdle(): boolean;
  /** Writes the ledger row and the failure record of every request still running, with the usage it has reported so far; returns how many it wrote. */
  recordPending(): number };
type AbortCause = "timeout" | "cancelled" | "shutdown";
export interface GatewayFailure {
  event: "request_failed"; requestId: string; providerId?: string; model?: string;
  durationMs: number; code: string; status: number; abortCause?: AbortCause;
}
export interface GatewayStartOptions {
  heartbeatMs?: number; onFailure?: (failure: GatewayFailure) => void;
  /** The temp folder whose Copilot parent the startup sweep reads; the OS temp folder by default. Tests pass a private one. */
  copilotTempBase?: string;
}
/**
 * One generation of request handling; a server can switch generations without closing its socket.
 * Members added after 0.3 are optional, so a generation adopted by an in-place upgrade still fits.
 */
export interface GatewayHandler {
  readonly handle: (req: IncomingMessage, res: ServerResponse) => void; isIdle(): boolean;
  /** Refuses an HTTP upgrade (a WebSocket handshake among them) on its raw socket; no admission, no provider. */
  handleUpgrade?(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Aborts running requests; "shutdown" fails them as retryable. Returns how many it aborted. */
  abortAll(reason?: "shutdown"): number | void;
  /**
   * New inference gets a retryable 503 from now on, and requests not yet admitted fail
   * as retryable before any provider work. Returns how many admitted requests still run.
   */
  beginDrain?(): number;
  /**
   * Records, as failed, every running request that has not been recorded, with the usage its provider reported so far, and
   * returns how many. A process calls this just before it exits, so a request it stops mid-stream still reaches the ledger.
   */
  recordPending?(): number;
}
type HandledServer = GatewayServer & { gatewayHandlers?: GatewayHandler[]; gatewayClose?: Server["close"]; gatewayClosing?: Promise<Error | undefined>;
  gatewayUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void };
const total = (values: Array<number | void>) => values.reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
const sendableTurnState = (value: unknown): value is string => typeof value === "string" && value.length <= maxTurnStateLength && /^[\x21-\x7e]+$/.test(value);

/**
 * Stops accepting, lets running requests finish for shutdownDrainMs(), fails the rest as
 * retryable, then runs the process shutdown hooks. Resolves when the listener has closed.
 */
async function drain(target: HandledServer, close: Server["close"]): Promise<Error | undefined> {
  const closed = new Promise<Error | undefined>(resolve => close(error => resolve(error)));
  const handlers = () => target.gatewayHandlers || [];
  const idle = () => handlers().every(entry => entry.isIdle());
  // A finished keep-alive connection would otherwise hold the close open until its idle timeout.
  const settle = async (until: number) => { while (!idle() && Date.now() < until) { target.closeIdleConnections(); await delay(100); } target.closeIdleConnections(); };
  const startedAt = Date.now(); const active = total(handlers().map(entry => entry.beginDrain?.()));
  await settle(startedAt + shutdownDrainMs());
  const drainedMs = Date.now() - startedAt; const aborted = total(handlers().map(entry => entry.abortAll("shutdown")));
  // An aborted request keeps reading its provider for up to usageDrainMs, for usage only, and then records its ledger row:
  // the final flush waits for that, so the spend of a request that stopped at shutdown is not left out.
  await Promise.all([runShutdownHooks(1000), settle(Date.now() + usageDrainMs)]);
  // A request still running now (its provider stayed silent past the usage drain) is recorded with what it reported so far.
  total(handlers().map(entry => entry.recordPending?.()));
  telemetry("server_drain", { active, drainedMs, aborted });
  // An idle restart exits straight from its callback, so the record is written first.
  await flushRecords();
  return closed;
}

/**
 * Sends new requests on `server` to `handler`. Requests already running finish on the
 * generation that accepted them, so a release can replace the code that serves
 * requests without refusing a connection. Idle, close and restart cover every
 * generation still at work.
 */
export function adoptGatewayHandler(server: Server, handler: GatewayHandler): GatewayServer {
  const target = server as HandledServer;
  const close = target.gatewayClose ??= server.close.bind(server);
  target.gatewayHandlers = [...(target.gatewayHandlers || []).filter(previous => !previous.isIdle()), handler];
  server.removeAllListeners("request"); server.on("request", handler.handle);
  // Upgrades (WebSocket handshakes among them) never reach an inference path; the newest generation still at work refuses them.
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const entry = (target.gatewayHandlers || []).slice().reverse().find(previous => previous.handleUpgrade);
    if (entry?.handleUpgrade) entry.handleUpgrade(req, socket, head); else socket.destroy();
  };
  if (target.gatewayUpgrade) server.off("upgrade", target.gatewayUpgrade);
  server.on("upgrade", onUpgrade); target.gatewayUpgrade = onUpgrade;
  // Includes body uploads, catalog reads and process-wide work such as live provider sessions.
  target.isIdle = () => (target.gatewayHandlers || []).every(entry => entry.isIdle()) && !runtimeBusy();
  // The callback runs after the drain and the shutdown hooks, so an exit cannot cut them short.
  const closing = () => target.gatewayClosing ??= drain(target, close);
  target.close = ((callback?: (error?: Error) => void) => { void closing().then(error => callback?.(error)); return target; }) as HandledServer["close"];
  target.recordPending = () => total((target.gatewayHandlers || []).map(entry => entry.recordPending?.()));
  target.restartWhenIdle = callback => { if (!target.isIdle()) return false; void closing().then(() => callback()); return true; };
  return target;
}

export async function startGateway(config: GatewayConfig, factory = createProvider, reload?: () => Promise<GatewayConfig>, options: GatewayStartOptions = {}): Promise<GatewayServer> {
  const handler = await createGatewayHandler(config, factory, reload, options);
  const server = createServer(); server.requestTimeout = 30000;
  const controlled = adoptGatewayHandler(server, handler);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  return controlled;
}

export async function createGatewayHandler(config: GatewayConfig, factory = createProvider, reload?: () => Promise<GatewayConfig>, options: GatewayStartOptions = {}): Promise<GatewayHandler> {
  const heartbeatMs = options.heartbeatMs ?? 15000;
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 1) throw new Error("Heartbeat interval must be positive");
  if (config.clientOnly) throw new Error("This is a remote client configuration; start its SSH tunnel instead of a local inference daemon");
  // A gateway that was killed left its Copilot CLIs' prompt logs in the temp folder; remove them before the first request, whatever any provider's mode.
  await sweepCopilotDirectories(options.copilotTempBase);
  // An in-place upgrade adopts the sessions of the release before it, which a configuration it no longer has may not serve.
  retireUnconfiguredCopilotScopes(config.providers);
  const token = await gatewayToken(config.stateDirectory);
  const providerUsage = new ProviderUsageStore(config.stateDirectory); await providerUsage.restore(config.providers);
  const contextWindows = new ObservedContextWindows(config.stateDirectory);
  const buildRoutes = (current: GatewayConfig) => {
    const adapters = new Map(current.providers.map(provider => [provider.id, factory(provider, limit => providerUsage.record(provider, limit), (model, window) => contextWindows.record(provider.id, model, window))] as const));
    const routes = new Map(current.providers.flatMap(provider => Object.entries(provider.models).map(([alias, model]) => [alias, { adapter: adapters.get(provider.id)!, model, id: provider.id, type: provider.type, reasoningScope: reasoningScope(provider) }] as const)));
    // A reviewer slug is served by the same adapter instance as that provider's own rows, so its credential, turn-state and reasoning scope match.
    const reviewers = new Map(autoReviewModels.flatMap(slug => {
      const provider = autoReviewProvider(current, slug);
      return provider ? [[slug as string, { adapter: adapters.get(provider.id)!, model: slug as string, id: provider.id, type: provider.type, reasoningScope: reasoningScope(provider) }] as const] : [];
    }));
    return { routes, reviewers };
  };
  let current = config; let { routes, reviewers } = buildRoutes(config);
  const snapshot = async () => {
    const next = reload ? await reload() : current;
    if (next !== current) {
      const updated = buildRoutes(next); routes = updated.routes; reviewers = updated.reviewers; current = next;
      // Live Copilot sessions of a provider the new configuration removed or changed would otherwise live out their timers.
      retireUnconfiguredCopilotScopes(next.providers);
    }
    return { config: current, routes, reviewers };
  };
  const active = new Map<AbortController, (cause: "shutdown") => void>();
  const admitted = new Set<AbortController>(); let draining = false;
  /** One recorder per running request: writes its failure record if the request has none yet. */
  const pending = new Set<() => boolean>();
  const admission = new Admission(config.maxConcurrent || 4);
  let requests = 0;
  // Every response names the release whose code served it; useful during in-place upgrades.
  const servingRelease = releaseState()?.running;
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (servingRelease) res.setHeader("X-Gateway-Release", servingRelease);
    requests++; let released = false;
    const release = () => { if (!released) { released = true; requests--; } };
    res.once("finish", release); res.once("close", release);
    const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const requestId = randomUUID(); res.setHeader("X-Request-Id", requestId);
    if (req.method === "GET" && path === "/health") {
      try { await snapshot(); send(res, 200, { status: "ok", active: active.size, running: admission.running, queued: admission.queued, idleRestart: true, idleUpgrade: true, features: gatewayFeatures }); }
      catch { send(res, 503, { status: "configuration_error", active: active.size, idleRestart: true }); }
      return;
    }
    if (req.headers.origin) { send(res, 403, { error: { code: "cross_origin", message: "Browser cross-origin requests are disabled" } }); return; }
    if (!validBearer(req.headers.authorization, token)) { send(res, 401, { error: { code: "authentication", message: "Gateway bearer token required" } }); return; }
    // Node versions that hand an upgrade to the request handler instead of the "upgrade" listener get the same refusal.
    if (path === "/v1/responses" && isUpgrade(req.headers.upgrade)) { sendUpgradeRefusal(res); return; }
    if (draining && req.method === "POST" && path === "/v1/responses") { res.setHeader("Retry-After", "1"); send(res, 503, { error: { code: "upstream_unavailable", message: "Gateway is restarting; retry shortly" } }); return; }
    let state: Awaited<ReturnType<typeof snapshot>>;
    try { state = await snapshot(); }
    catch { send(res, 503, { error: { code: "configuration_error", message: "Gateway configuration is invalid; fix it before retrying" } }); return; }
    if (req.method === "GET" && path === "/v1/models") { send(res, 200, { object: "list", data: [...state.routes].map(([id, route]) => ({ id, object: "model", owned_by: route.id })) }); return; }
    if (req.method === "GET" && path === "/v1/model-catalog") { const reviewing = await advertisedReviewers(state.config); send(res, 200, { ...modelCatalog(state.config), ...(reviewing.length ? { auto_review: { models: reviewing } } : {}) }); return; }
    if (req.method === "GET" && path === "/v1/provider-usage") { res.setHeader("Cache-Control", "no-store"); send(res, 200, { data: providerUsage.snapshot(state.config.providers) }); return; }
    if (req.method !== "POST" || path !== "/v1/responses") { send(res, 404, { error: { code: "not_found", message: "Unknown endpoint" } }); return; }
    if (active.size >= (state.config.maxConcurrent || 4) + 32) { res.setHeader("Retry-After", "1"); send(res, 429, { error: { code: "busy", message: "Gateway waiting queue is full; retry shortly" } }); return; }
    const controller = new AbortController();
    let releaseAdmission: (() => void) | undefined;
    let writer: ResponsesWriter | undefined; let open: ((turnState?: string) => void) | undefined;
    let heartbeat: NodeJS.Timeout | undefined; let headWait: NodeJS.Timeout | undefined; let abortCause: AbortCause | undefined;
    active.set(controller, cause => { abortCause ||= cause; clearInterval(heartbeat); controller.abort(); });
    // A request is recorded once, whichever of its end and a process exit gets there first.
    let recorded = false;
    let providerId: string | undefined; let providerType: string | undefined; let model: string | undefined; let context: InferenceContext | undefined;
    const startedAt = Date.now();
    let admittedAt = 0; let firstEventAt = 0; let events = 0; let tools = 0; let droppedControlItems = 0; let usage: Usage | undefined; let accounting: UsageAccounting | undefined; let responseId: string | undefined; let turnStateReturned = false;
    const outcome = () => { const routing = context ?? inferenceContext(req.headers); return { requestId, provider: providerId, model, durationMs: Date.now() - startedAt, queueMs: admittedAt ? admittedAt - startedAt : undefined,
      autoReview: model !== undefined && isAutoReviewModel(model) ? true : undefined,
      firstEventMs: firstEventAt ? firstEventAt - (admittedAt || startedAt) : undefined, events, toolCalls: tools, inputTokens: usage?.input_tokens,
      cachedTokens: usage?.input_tokens_details?.cached_tokens, outputTokens: usage?.output_tokens,
      providerType, cacheWriteTokens: accounting?.cacheWriteTokens, reasoningTokens: accounting?.reasoningTokens, nanoAiu: accounting?.nanoAiu, nanoAiuStatus: accounting?.nanoAiuStatus, initiator: accounting?.initiator, session: !!routing.sessionId, turnStateEchoed: !!routing.turnState, turnStateReturned, droppedControlItems: droppedControlItems || undefined }; };
    // Content-free record of what the request cost, appended once per finished request.
    const ledger = (status: LedgerStatus) => recordUsage(config.stateDirectory, { requestId, responseId, provider: providerId, providerType, model, status,
      inputTokens: usage?.input_tokens, cachedTokens: usage?.input_tokens_details?.cached_tokens, outputTokens: usage?.output_tokens, cacheWriteTokens: accounting?.cacheWriteTokens,
      reasoningTokens: accounting?.reasoningTokens, nanoAiu: accounting?.nanoAiu, nanoAiuStatus: accounting?.nanoAiuStatus }, new Date(), new Map(current.providers.map(entry => [entry.id, entry.type])));
    // The record of a failed request: telemetry, the ledger row with the usage reported so far, and the diagnostic line. Once per request.
    const recordFailure = (error: unknown): ProviderError => {
      const known = classifyProviderFailure(error, abortCause);
      if (recorded) return known;
      recorded = true;
      // A rejected Responses request says which fixed class of data it rejected.
      const translation = translationFailureFields(error);
      // Typed provider and protocol failures stay local; an untyped exception is a gateway bug.
      if (!(error instanceof ProviderError) && known.code === "provider_failed") reportException(error, `provider:${providerId ?? "unknown"}`);
      telemetry("request_failed", { ...outcome(), code: known.code, status: known.status, abortCause, upstreamCode: known.upstream?.code, upstreamEvent: known.upstream?.event, subtype: known.upstream?.subtype, ...translation });
      ledger("failed");
      const failure: GatewayFailure = { event: "request_failed", requestId, ...(providerId ? { providerId, model } : {}), durationMs: Date.now() - startedAt, code: known.code, status: known.status, ...(abortCause ? { abortCause } : {}) };
      try { if (options.onFailure) options.onFailure(failure); else console.error(JSON.stringify(providerFailureDiagnostic({ requestId, providerId, modelAlias: model, durationMs: failure.durationMs, failure: known, abortCause, ...translation }))); } catch { /* Diagnostics never replace the request outcome. */ }
      return known;
    };
    // A process that exits while this request runs records it as it stands: the stop it is about to suffer is the shutdown's doing.
    const recordPending = (): boolean => {
      if (recorded) return false;
      abortCause ||= "shutdown";
      recordFailure(new ProviderError("cancelled", "Request cancelled or timed out", 504));
      return true;
    };
    pending.add(recordPending);
    // timeoutMs bounds silence, not total length: it covers the upload and queue
    // wait, then restarts at admission and on every provider event. Long Max or
    // Ultra streams continue while a stalled provider still fails. The whole
    // request has a one-hour cap.
    const expire = () => {
      abortCause ||= "timeout"; clearInterval(heartbeat); controller.abort();
      if (res.writableNeedDrain || (res.writableEnded && !res.writableFinished)) res.destroy();
    };
    const idleMs = state.config.timeoutMs || 600000;
    let timeout = setTimeout(expire, idleMs).unref();
    const touch = () => { clearTimeout(timeout); timeout = setTimeout(expire, idleMs).unref(); };
    const absolute = setTimeout(expire, Math.max(idleMs, 3600000)).unref();
    const clearDeadline = () => { clearTimeout(timeout); clearTimeout(absolute); res.off("finish", clearDeadline); res.off("close", clearDeadline); };
    res.once("finish", clearDeadline); res.once("close", clearDeadline);
    const cancel = () => { if (!res.writableEnded) { abortCause ||= "cancelled"; clearInterval(heartbeat); controller.abort(); } };
    res.once("close", cancel);
    try {
      const internal = stripOpenAIInternal(await body(req)); const request = internal.request; droppedControlItems = internal.droppedControlItems;
      context = inferenceContext(req.headers, request);
      // Sub-agents that Codex spawns from a gateway chat inherit the gateway provider
      // but take a bare model name from the user's agent roles. Serve that same model
      // through its vendor's subscription route when exactly one alias matches.
      const alias = state.routes.has(request.model) ? request.model : nativeModelAlias(state.config, request.model);
      const route = (alias ? state.routes.get(alias) : undefined) ?? state.reviewers.get(request.model);
      // Only an allowlisted reviewer slug is recorded for a request that has no route; any other name stays out of telemetry.
      if (!route && isAutoReviewModel(request.model)) model = request.model;
      if (!route) throw new ProviderError("model_not_found", unknownModelMessage(request.model), 404);
      if (alias && alias !== request.model) telemetry("model_alias_resolved", { requested: request.model, alias });
      providerId = route.id; providerType = route.type; model = request.model;
      responsesToChatRequest(request); // Validate the supported protocol before invoking any provider.
      const limit = state.config.maxConcurrent || 4; admission.setLimit(limit); admission.check();
      const streaming = request.stream === true;
      let lastEventAt = Date.now(); let opened = false;
      // A marked id lets a spend tool match this request to the client's own record of the response.
      responseId = usageLedgerMarks(route.type) ? "resp_gl_" + requestId.replaceAll("-", "") : undefined;
      const output = writer = new ResponsesWriter(request.model, event => { if (streaming && !res.destroyed) { lastEventAt = Date.now(); res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); } }, responseId ? { id: responseId } : {});
      open = turnState => {
        if (opened) return; opened = true; clearTimeout(headWait);
        if (sendableTurnState(turnState) && !res.headersSent) { res.setHeader("X-Codex-Turn-State", turnState); turnStateReturned = true; }
        if (streaming) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
        output.begin();
        if (streaming) heartbeat = setInterval(() => {
          if (!controller.signal.aborted && !res.destroyed && !res.writableNeedDrain && Date.now() - lastEventAt >= heartbeatMs) output.progress();
        }, heartbeatMs).unref();
      };
      // Codex reads its turn-state from response headers, so a provider that reports one
      // gets the SSE head after its first event. The upstream head often takes over 2 s, and
      // a head sent without the turn-state cannot add it later, so the wait lasts up to one
      // heartbeat interval after admission: the same silence an open stream allows. A queued
      // request still opens at once and shows progress while it waits.
      const deferred = streaming && route.adapter.emitsTransport === true;
      if (!deferred || admission.running >= limit || admission.queued > 0) open();
      // Remote compaction is an executor control item the gateway does not serve: it fails as a final error once the
      // head a stream needs exists, before admission and without a provider. Nonstream requests get the plain HTTP 400.
      if (internal.unsupportedCompaction) throw unsupportedCompactionFailure();
      releaseAdmission = await admission.acquire(controller.signal);
      // Admitted after the drain began (queued, uploading or loading config meanwhile): the
      // process is going away, so the client retries on the next one before any provider spend.
      if (draining) active.get(controller)?.("shutdown");
      controller.signal.throwIfAborted(); touch(); admittedAt = Date.now(); admitted.add(controller);
      if (!opened) headWait = setTimeout(() => open?.(), heartbeatMs);
      // Spend a provider already reported is recorded even when the caller has gone: the ledger and telemetry never lose it.
      const take = (event: InferenceEvent) => { if (event.type === "usage" || event.type === "done") { usage = event.usage; accounting = event.accounting ?? accounting; } };
      const source = route.adapter.infer({ ...restoreReasoning(request, route.reasoningScope), model: route.model }, controller.signal, context)[Symbol.asyncIterator]();
      // This view has no `return`, so leaving the loop early keeps the provider open for the usage drain below.
      const kept = { [Symbol.asyncIterator]: () => ({ next: () => source.next() }) };
      let stopped = false;
      try {
        for await (const event of kept) {
          take(event);
          if (controller.signal.aborted || res.destroyed) { stopped = true; break; }
          touch();
          // Running usage never opens or writes the stream.
          if (event.type === "usage") continue;
          if (event.type === "transport") {
            if (!opened) open(event.turnState);
            else if (!streaming && !res.headersSent && sendableTurnState(event.turnState)) { res.setHeader("X-Codex-Turn-State", event.turnState); turnStateReturned = true; }
            continue;
          }
          open(); events++; if (!firstEventAt) firstEventAt = Date.now();
          if (event.type === "tool") tools++;
          writer.accept(event.type === "reasoning-state" ? { ...event, item: wrapReasoning(event.item, route.reasoningScope) } : event);
          if (writer.completed) clearInterval(heartbeat);
          if (streaming && res.writableNeedDrain) await waitForDrain(res, controller.signal);
          if (controller.signal.aborted || res.destroyed) { stopped = true; break; }
        }
      } catch (error) { await Promise.resolve(source.return?.()).catch(() => undefined); throw error; }
      if (stopped) {
        // The caller has gone or the request was aborted: stop the provider, then read it on for usage only.
        if (!controller.signal.aborted) { abortCause ||= "cancelled"; clearInterval(heartbeat); controller.abort(); }
        await drainUsage(source, take);
      }
      if (!writer.completed) throw new ProviderError(controller.signal.aborted ? "cancelled" : "incomplete", controller.signal.aborted ? "Request cancelled or timed out" : "Provider did not complete", 504);
      if (!recorded) {
        recorded = true;
        telemetry(events <= 1 && !tools ? "request_empty" : "request_completed", outcome());
        ledger(events <= 1 && !tools ? "empty" : "completed");
      }
      if (!res.destroyed) {
        if (controller.signal.aborted && res.writableNeedDrain) res.destroy();
        else if (!streaming) send(res, 200, writer.result());
        else res.end();
      }
    } catch (error) {
      // A deferred head still opens, so the failure is a 200 stream with response.failed.
      if (!res.destroyed) open?.();
      clearInterval(heartbeat);
      const known = recordFailure(error);
      if (!res.destroyed) {
        if (res.writableNeedDrain && controller.signal.aborted) res.destroy();
        else if (res.headersSent && writer) {
          writer.fail(streamFailureCode(known), known.message);
          if (res.writableNeedDrain) await waitForDrain(res, controller.signal);
          if (!res.destroyed) { if (controller.signal.aborted && res.writableNeedDrain) res.destroy(); else res.end(); }
        }
        else send(res, known.status, { error: { code: known.code, message: known.message } });
      }
    } finally { clearInterval(heartbeat); clearTimeout(headWait); res.off("close", cancel); controller.abort(); releaseAdmission?.(); active.delete(controller); admitted.delete(controller); pending.delete(recordPending); }
  };
  const handleUpgrade = (req: IncomingMessage, socket: Duplex): void => {
    const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (req.headers.origin) return refuseUpgrade(socket, 403, { code: "cross_origin", message: "Browser cross-origin requests are disabled" });
    if (!validBearer(req.headers.authorization, token)) return refuseUpgrade(socket, 401, { code: "authentication", message: "Gateway bearer token required" });
    if (path === "/v1/responses") return refuseUpgrade(socket, 426);
    refuseUpgrade(socket, 404, { code: "not_found", message: "Unknown endpoint" });
  };
  return { handle: (req, res) => { void handle(req, res); }, handleUpgrade, isIdle: () => !requests && !active.size,
    abortAll: reason => { let aborted = 0; for (const [controller, abort] of active) { if (controller.signal.aborted) continue; aborted++; if (reason) abort(reason); else controller.abort(); } return aborted; },
    recordPending: () => { let recorded = 0; for (const record of [...pending]) if (record()) recorded++; return recorded; },
    beginDrain: () => {
      draining = true; let running = 0;
      for (const [controller, abort] of active) { if (controller.signal.aborted) continue; if (admitted.has(controller)) running++; else abort("shutdown"); }
      return running;
    } };
}
