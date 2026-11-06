import { request as httpRequest, createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { gatewayToken, loadConfig, validBearer, type GatewayConfig, type ProviderConfig } from "./config.js";
import { startClaudeContextProxy, type ClaudeContextProxy, type ClaudeContextProxyDeps } from "./claude-desktop-context-proxy.js";
import { loadQwenTokenizer } from "./claude-desktop-tokenizer.js";
import type { NoToolsOutputRecovery } from "./claude-desktop-no-tools.js";
import { anthropicError } from "./protocol/messages.js";
import { createProvider, maxRequestBytes, startGateway, type GatewayServer } from "./server.js";
import { ChatCompletionsAPI, type ChatCompletionRecoveryPolicy } from "./providers/chat-completions-api.js";
import type { ClaudeLimit } from "./providers/claude-usage.js";
import { telemetry } from "./telemetry.js";
import { requestPath } from "./server-upgrade.js";
import { cacheGuardedNativeMessages } from "./claude-native-cache.js";
import { completedNativeMessage } from "./claude-native-review.js";
import { ContextCacheBlocked } from "./context-cache-budget.js";

const nativeRequestLimit = 256 * 1024;
const defaultNativeRequestLimit = 192 * 1024;
const healthResponseLimit = 1024 * 1024;
const hopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

export interface ClaudeDesktopNativeConfig {
  command: string;
  authDirectory?: string;
  models: Record<string, string>;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxConcurrent?: number;
  contextProviders?: string[];
  emptyCompletionRecoveryProviders?: string[];
  noToolsOutputRecoveryProviders?: Record<string, string>;
}

export interface NativeMessagesOptions {
  observeCacheUsage?: (usage: Record<string, unknown>) => void;
  command: string;
  authDirectory?: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
  maxRequestBytes: number;
}

export type NativeMessagesRunner = (payload: Record<string, unknown>, nativeModel: string, options: NativeMessagesOptions) => Promise<Record<string, unknown>>;
export type NativeClassifierRequest = (payload: Record<string, unknown>) => boolean | Promise<boolean>;

export interface ClaudeDesktopInferenceDeps {
  loadGatewayConfig?: (path: string) => Promise<GatewayConfig>;
  backendFactory?: (config: GatewayConfig) => Promise<GatewayServer>;
  nativeRunner?: NativeMessagesRunner;
  nativeClassifierRequest?: NativeClassifierRequest;
  contextProxyFactory?: (provider: ProviderConfig, deps?: ClaudeContextProxyDeps) => Promise<ClaudeContextProxy>;
  tokenReader?: (stateDirectory: string) => Promise<string>;
}

export interface ClaudeDesktopInference {
  readonly server: Server;
  readonly backend: GatewayServer;
  readonly port: number;
  readonly isIdle: () => boolean;
  /** Stops the private front end, aborts its own work, then closes its owned backend. */
  close(): Promise<void>;
}

type NativeRoute = { alias: string; nativeModel: string; provider: ProviderConfig; config: ClaudeDesktopNativeConfig };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const safeStatus = (value: unknown) => typeof value === "number" && [400, 401, 403, 408, 413, 429, 500, 502, 503, 504].includes(value) ? value : 502;

function messages(path: string): boolean { return path === "/v1/messages" || path === "/v1/messages/count_tokens"; }
function writeError(response: ServerResponse, path: string, status: number, code: string, message: string): void {
  const body = messages(path) ? anthropicError(code, message, status) : { error: { code, message } };
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body));
}

function authenticated(request: IncomingMessage, token: string, path: string): boolean {
  const apiKey = request.headers["x-api-key"];
  const authorization = request.headers.authorization;
  return authorization !== undefined
    ? validBearer(authorization, token) && (!messages(path) || apiKey === undefined || (typeof apiKey === "string" && validBearer(`Bearer ${apiKey}`, token)))
    : messages(path) && typeof apiKey === "string" && validBearer(`Bearer ${apiKey}`, token);
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseNativeConfig(value: unknown): ClaudeDesktopNativeConfig {
  if (!isRecord(value) || Object.keys(value).some(key => !["command", "authDirectory", "models", "timeoutMs", "maxRequestBytes", "maxConcurrent", "contextProviders", "emptyCompletionRecoveryProviders", "noToolsOutputRecoveryProviders"].includes(key))) {
    throw new Error("Native Claude configuration is invalid");
  }
  if (typeof value.command !== "string" || !isAbsolute(value.command)) throw new Error("Native Claude command must be an absolute path");
  if (value.authDirectory !== undefined && (typeof value.authDirectory !== "string" || !isAbsolute(value.authDirectory))) throw new Error("Native Claude authDirectory must be an absolute path");
  if (!isRecord(value.models) || !Object.keys(value.models).length || Object.values(value.models).some(model => typeof model !== "string" || !/^claude-[A-Za-z0-9._-]+$/.test(model))) {
    throw new Error("Native Claude models must map aliases to Claude model IDs");
  }
  const timeoutMs = value.timeoutMs;
  const maxBytes = value.maxRequestBytes;
  const maxConcurrent = value.maxConcurrent;
  const contextProviders = value.contextProviders;
  const emptyCompletionRecoveryProviders = value.emptyCompletionRecoveryProviders;
  const noToolsOutputRecoveryProviders = value.noToolsOutputRecoveryProviders;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000)) throw new Error("Native Claude timeoutMs must be 1000 through 600000");
  if (maxBytes !== undefined && (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > nativeRequestLimit)) {
    throw new Error("Native Claude maxRequestBytes must be 1 through 262144");
  }
  if (maxConcurrent !== undefined && (typeof maxConcurrent !== "number" || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8)) {
    throw new Error("Native Claude maxConcurrent must be 1 through 8");
  }
  if (contextProviders !== undefined && (!Array.isArray(contextProviders) || contextProviders.some(id => typeof id !== "string" || !/^[a-z][a-z0-9_-]*$/.test(id)) || new Set(contextProviders).size !== contextProviders.length)) {
    throw new Error("Native Claude contextProviders must be unique provider IDs");
  }
  if (emptyCompletionRecoveryProviders !== undefined && (!Array.isArray(emptyCompletionRecoveryProviders) || emptyCompletionRecoveryProviders.some(id => typeof id !== "string" || !/^[a-z][a-z0-9_-]*$/.test(id)) || new Set(emptyCompletionRecoveryProviders).size !== emptyCompletionRecoveryProviders.length)) {
    throw new Error("Native Claude emptyCompletionRecoveryProviders must be unique provider IDs");
  }
  if (noToolsOutputRecoveryProviders !== undefined && (!isRecord(noToolsOutputRecoveryProviders) || Object.entries(noToolsOutputRecoveryProviders).some(([id, path]) => !/^[a-z][a-z0-9_-]*$/.test(id) || typeof path !== "string" || !isAbsolute(path)))) {
    throw new Error("Native Claude noToolsOutputRecoveryProviders must map provider IDs to absolute tokenizer assets");
  }
  return {
    command: resolve(value.command), ...(value.authDirectory === undefined ? {} : { authDirectory: resolve(value.authDirectory) }),
    models: Object.fromEntries(Object.entries(value.models) as Array<[string, string]>),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxBytes === undefined ? {} : { maxRequestBytes: maxBytes }),
    ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
    ...(contextProviders === undefined ? {} : { contextProviders }),
    ...(emptyCompletionRecoveryProviders === undefined ? {} : { emptyCompletionRecoveryProviders }),
    ...(noToolsOutputRecoveryProviders === undefined ? {} : { noToolsOutputRecoveryProviders: Object.fromEntries(Object.entries(noToolsOutputRecoveryProviders) as Array<[string, string]>) }),
  };
}

async function loadNativeConfig(path: string): Promise<ClaudeDesktopNativeConfig> {
  if (!isAbsolute(path)) throw new Error("--native-config must be an absolute path");
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("Native Claude configuration is unreadable or invalid JSON"); }
  return parseNativeConfig(raw);
}

function sameAuthDirectory(provider: ProviderConfig, config: ClaudeDesktopNativeConfig): boolean {
  return provider.authDirectory === undefined ? config.authDirectory === undefined : provider.authDirectory === config.authDirectory;
}

function nativeRoutes(source: GatewayConfig, config: ClaudeDesktopNativeConfig): Map<string, NativeRoute> {
  const result = new Map<string, NativeRoute>();
  for (const [alias, nativeModel] of Object.entries(config.models)) {
    const provider = source.providers.find(entry => Object.hasOwn(entry.models, alias));
    if (nativeModel !== "claude-sonnet-5" || !provider || provider.type !== "claude-subscription" || provider.models[alias] !== nativeModel || !sameAuthDirectory(provider, config)) {
      throw new Error("Native Claude model ownership does not match the gateway configuration");
    }
    result.set(alias, { alias, nativeModel, provider, config });
  }
  return result;
}

function recoveryProviders(source: GatewayConfig, ids: string[] | undefined): Map<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  for (const id of ids || []) {
    const provider = source.providers.find(entry => entry.id === id);
    if (!provider || provider.type !== "chat-completions-api") throw new Error("Native Claude emptyCompletionRecoveryProviders must name configured Chat Completions providers");
    result.set(provider.id, Object.values(provider.models));
  }
  return result;
}

async function noToolsRecoveryProviders(source: GatewayConfig, native: ClaudeDesktopNativeConfig): Promise<Map<string, NoToolsOutputRecovery>> {
  const result = new Map<string, NoToolsOutputRecovery>();
  for (const [id, asset] of Object.entries(native.noToolsOutputRecoveryProviders || {})) {
    const provider = source.providers.find(entry => entry.id === id);
    const models = provider?.type === "chat-completions-api" ? [...new Set(Object.values(provider.models))] : [];
    if (!provider || provider.type !== "chat-completions-api" || !native.contextProviders?.includes(id) || !native.emptyCompletionRecoveryProviders?.includes(id) || models.length !== 1) {
      throw new Error("Native Claude noToolsOutputRecoveryProviders must name an opted-in context and empty-completion Chat provider");
    }
    const codec = await loadQwenTokenizer(asset);
    if (codec.model !== models[0]) throw new Error("Native Claude no-tools tokenizer model does not match the configured provider");
    result.set(id, {
      model: codec.model, codec,
      onRestored: event => telemetry("claude_no_tools_output_restored", {
        provider: id, model: codec.model, outputTokens: event.outputTokens, recoveredBytes: event.recoveredBytes,
      }),
    });
  }
  return result;
}

async function contextProxyProviders(source: GatewayConfig, ids: string[] | undefined,
  factory: (provider: ProviderConfig, deps?: ClaudeContextProxyDeps) => Promise<ClaudeContextProxy>,
  noTools: ReadonlyMap<string, NoToolsOutputRecovery>): Promise<ClaudeContextProxy[]> {
  const proxies: ClaudeContextProxy[] = [];
  try {
    for (const id of ids || []) {
      const provider = source.providers.find(entry => entry.id === id);
      if (!provider || provider.type !== "chat-completions-api") throw new Error("Native Claude contextProviders must name configured Chat Completions providers");
      proxies.push(await factory(provider, noTools.has(id) ? { noToolsOutputRecovery: noTools.get(id) } : undefined));
    }
    return proxies;
  } catch (error) {
    await Promise.all(proxies.map(proxy => proxy.close().catch(() => undefined)));
    throw error;
  }
}

type NativeRuntime = { runNativeMessages?: NativeMessagesRunner; isNativeClassifierRequest?: NativeClassifierRequest };
let nativeRuntime: Promise<NativeRuntime> | undefined;
function nativeRuntimeModule(): Promise<NativeRuntime> {
  return nativeRuntime ??= import(new URL("../scripts/claude-desktop-native-messages.mjs", import.meta.url).href) as Promise<NativeRuntime>;
}

async function defaultRunner(payload: Record<string, unknown>, nativeModel: string, options: NativeMessagesOptions): Promise<Record<string, unknown>> {
  const module = await nativeRuntimeModule();
  if (typeof module.runNativeMessages !== "function") throw new Error("Native Claude runner is unavailable");
  return module.runNativeMessages(payload, nativeModel, options);
}

async function defaultClassifierRequest(payload: Record<string, unknown>): Promise<boolean> {
  try {
    const module = await nativeRuntimeModule();
    return module.isNativeClassifierRequest?.(payload) === true;
  } catch { return false; }
}

function nativeHeaders(request: IncomingMessage): Record<string, string> | undefined {
  const requestClass = request.headers["x-claude-code-request-class"];
  if (Array.isArray(requestClass) || (requestClass !== undefined && requestClass !== "auxiliary")) return;
  const headers: Record<string, string> = { "x-claude-code-request-class": "auxiliary" };
  const beta = request.headers["anthropic-beta"];
  if (beta !== undefined && (typeof beta !== "string" || beta.length > 4096 || !/^[\x20-\x7e]*$/.test(beta))) return;
  if (typeof beta === "string") headers["anthropic-beta"] = beta;
  return headers;
}

function nativeCandidate(payload: unknown, routes: Map<string, NativeRoute>): { route: NativeRoute; payload: Record<string, unknown> } | undefined {
  if (!isRecord(payload) || typeof payload.model !== "string" || (payload.stream !== undefined && payload.stream !== false)) return;
  if (payload.tools !== undefined && (!Array.isArray(payload.tools) || payload.tools.length !== 0)) return;
  const route = routes.get(payload.model);
  return route ? { route, payload } : undefined;
}

function proxyError(response: ServerResponse, path: string): void {
  if (!response.headersSent && !response.destroyed) writeError(response, path, 502, "upstream_unavailable", "Private gateway backend is unavailable");
  else response.destroy();
}

function endToEndHeaders(headers: IncomingHttpHeaders): Record<string, string | string[] | undefined> {
  const stripped = { ...headers } as Record<string, string | string[] | undefined>;
  const connection = headers.connection;
  const named = typeof connection === "string" ? connection.split(",").map(value => value.trim().toLowerCase()) : [];
  for (const name of [...hopHeaders, ...named]) delete stripped[name];
  return stripped;
}

function requestStopped(request: IncomingMessage, response: ServerResponse, signal: AbortSignal, stopping: () => boolean): boolean {
  return stopping() || signal.aborted || request.aborted || response.destroyed || response.writableEnded;
}

function waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  if (!response.writableNeedDrain) return Promise.resolve();
  return new Promise((resolveResult, reject) => {
    const finish = (error?: Error) => {
      response.off("drain", drained); response.off("close", closed); signal.removeEventListener("abort", closed);
      error ? reject(error) : resolveResult();
    };
    const drained = () => finish();
    const closed = () => finish(new Error("proxy response closed"));
    response.once("drain", drained); response.once("close", closed); signal.addEventListener("abort", closed, { once: true });
  });
}

async function proxy(request: IncomingMessage, response: ServerResponse, body: Buffer, backendPort: number, signal: AbortSignal,
  stopping: () => boolean,
  transform?: (status: number, headers: Record<string, string | string[] | undefined>, body: Buffer) => { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }): Promise<void> {
  if (requestStopped(request, response, signal, stopping)) return;
  await new Promise<void>((resolveResult, reject) => {
    if (requestStopped(request, response, signal, stopping)) { resolveResult(); return; }
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; signal.removeEventListener("abort", abort);
      error ? reject(error) : resolveResult();
    };
    const upstream = httpRequest({ hostname: "127.0.0.1", port: backendPort, method: request.method, path: request.url, headers: endToEndHeaders(request.headers) }, reply => {
      const headers = endToEndHeaders(reply.headers);
      reply.once("aborted", () => finish(new Error("backend response was aborted")));
      reply.once("error", error => finish(error));
      if (transform) {
        void (async () => {
          try {
            const chunks: Buffer[] = []; let bytes = 0;
            for await (const chunk of reply) {
              bytes += chunk.length;
              if (bytes > healthResponseLimit) throw new Error("health response exceeds 1 MiB");
              chunks.push(chunk);
            }
            if (!reply.complete) throw new Error("backend response ended before completion");
            const next = transform(reply.statusCode || 502, headers, Buffer.concat(chunks));
            response.writeHead(next.status, next.headers); response.end(next.body); finish();
          } catch (error) { finish(error as Error); }
        })();
        return;
      }
      void (async () => {
        try {
          response.writeHead(reply.statusCode || 502, headers);
          for await (const chunk of reply) {
            if (response.destroyed || signal.aborted) throw new Error("proxy response closed");
            if (!response.write(chunk)) await waitForDrain(response, signal);
          }
          if (!reply.complete) throw new Error("backend response ended before completion");
          if (!response.destroyed) response.end();
          finish();
        } catch (error) { finish(error as Error); }
      })();
    });
    const abort = () => upstream.destroy();
    signal.addEventListener("abort", abort, { once: true });
    upstream.once("error", error => finish(error));
    upstream.end(body);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolveResult => { if (!server.listening) resolveResult(); else server.close(() => resolveResult()); });
}

/**
 * Runs the original gateway behind a private loopback front. The front only sends
 * selected, tool-free, nonstream Claude Messages requests to the native runner.
 */
export async function startClaudeDesktopInference(gatewayConfigPath: string, nativeConfigPath: string, deps: ClaudeDesktopInferenceDeps = {}): Promise<ClaudeDesktopInference> {
  if (!isAbsolute(gatewayConfigPath)) throw new Error("--gateway-config must be an absolute path");
  const source = await (deps.loadGatewayConfig ?? loadConfig)(gatewayConfigPath);
  if (!source.port) throw new Error("Claude Desktop inference requires a fixed gateway port");
  const native = await loadNativeConfig(nativeConfigPath);
  const routes = nativeRoutes(source, native);
  const recovery = recoveryProviders(source, native.emptyCompletionRecoveryProviders);
  const noTools = await noToolsRecoveryProviders(source, native);
  const contextProxies = await contextProxyProviders(source, native.contextProviders, deps.contextProxyFactory ?? startClaudeContextProxy, noTools);
  const contextById = new Map(contextProxies.map(proxy => [proxy.provider.id, proxy.provider]));
  const noToolsBases = new Map(contextProxies.flatMap(proxy => proxy.noToolsBaseUrl ? [[proxy.provider.id, proxy.noToolsBaseUrl] as const] : []));
  let backend: GatewayServer | undefined;
  let front: Server | undefined;
  let drainFrontWork: (() => Promise<void>) | undefined;
  const rollback = async () => {
    if (front) { front.closeAllConnections(); await closeServer(front); }
    await drainFrontWork?.();
    if (backend) { backend.closeAllConnections(); await closeServer(backend); }
    await Promise.all(contextProxies.map(proxy => proxy.close().catch(() => undefined)));
  };
  try {
    const factory = (provider: ProviderConfig, onUsage?: (limit: ClaudeLimit) => Promise<void>, onContextWindow?: (model: string, contextWindow: number) => void) => {
      const models = recovery.get(provider.id);
      const policy: ChatCompletionRecoveryPolicy | undefined = models ? {
        models,
        onRecovery: event => telemetry("chat_empty_completion_recovery", { provider: provider.id, model: event.model, attempt: event.attempt, outcome: event.outcome, durationMs: event.durationMs,
          inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens }),
      } : undefined;
      if (!policy) return createProvider(provider, onUsage, onContextWindow);
      const regular = new ChatCompletionsAPI(provider, undefined, policy);
      const noToolsBaseUrl = noToolsBases.get(provider.id);
      if (!noToolsBaseUrl) return regular;
      const scoped = new ChatCompletionsAPI({ ...provider, baseUrl: noToolsBaseUrl }, undefined, policy);
      return {
        async *infer(request: Parameters<ChatCompletionsAPI["infer"]>[0], signal: Parameters<ChatCompletionsAPI["infer"]>[1], context: NonNullable<Parameters<ChatCompletionsAPI["infer"]>[2]> = {}) {
          yield* (context.clientProtocol === "messages" ? scoped : regular).infer(request, signal, context);
        },
      };
    };
    backend = await (deps.backendFactory ?? (config => startGateway(config, factory, undefined, { claudeNativeReview: false })))({
      ...source, port: 0, providers: source.providers.map(provider => contextById.get(provider.id) ?? provider),
    });
    const backendPort = (backend.address() as { port?: number } | null)?.port;
    if (!backendPort) throw new Error("Private gateway backend did not bind a loopback port");
    const token = await (deps.tokenReader ?? gatewayToken)(source.stateDirectory);
    const runner = deps.nativeRunner ?? defaultRunner;
    const classifierRequest = deps.nativeClassifierRequest ?? defaultClassifierRequest;
    const active = new Set<AbortController>(); const nativeActive = new Set<AbortController>();
    const work = new Set<Promise<void>>();
    drainFrontWork = async () => {
      while (work.size) await Promise.allSettled([...work]);
    };
    let stopping = false; let closing: Promise<void> | undefined;
    front = createServer((request, response) => {
      const task = (async () => {
      const path = requestPath(request.url);
      if (!path) { writeError(response, "/", 400, "invalid_request", "Request target is not valid"); return; }
      if (stopping) { writeError(response, path, 503, "upstream_unavailable", "Private gateway is restarting"); return; }
      if (!authenticated(request, token, path)) { writeError(response, path, 401, "authentication", "Gateway client token required"); return; }
      if (request.headers.origin) { writeError(response, path, 403, "cross_origin", "Browser cross-origin requests are disabled"); return; }
      const controller = new AbortController(); active.add(controller);
      const cancel = () => { if (!response.writableEnded) controller.abort(); };
      request.once("aborted", cancel); response.once("close", cancel);
      try {
        const wire = await readBody(request, maxRequestBytes);
        let parsed: unknown;
        if (request.method === "POST" && path === "/v1/messages") {
          try { parsed = JSON.parse(wire.toString("utf8")); } catch { /* The unchanged backend owns invalid JSON. */ }
        }
        const directHeaders = nativeHeaders(request);
        const possibleCandidate = directHeaders ? nativeCandidate(parsed, routes) : undefined;
        const candidate = possibleCandidate && await classifierRequest({ ...possibleCandidate.payload, model: possibleCandidate.route.nativeModel }) ? possibleCandidate : undefined;
        if (requestStopped(request, response, controller.signal, () => stopping)) return;
        if (candidate) {
          const limit = candidate.route.config.maxRequestBytes ?? defaultNativeRequestLimit;
          if (wire.length > limit) { writeError(response, path, 413, "request_too_large", "Native Claude request exceeds the configured size"); return; }
          if (nativeActive.size >= (candidate.route.config.maxConcurrent ?? 2)) {
            writeError(response, path, 429, "rate_limit_exceeded", "Native Claude concurrency is full; retry shortly");
            return;
          }
          nativeActive.add(controller);
          try {
            const nativePayload = { ...candidate.payload, model: candidate.route.nativeModel };
            const reply = completedNativeMessage(await cacheGuardedNativeMessages(candidate.route.provider, nativePayload, request.headers, controller.signal,
              observeCacheUsage => runner(nativePayload, candidate.route.nativeModel, { observeCacheUsage,
              command: candidate.route.config.command, ...(candidate.route.config.authDirectory === undefined ? {} : { authDirectory: candidate.route.config.authDirectory }),
              headers: directHeaders!, signal: controller.signal, timeoutMs: candidate.route.config.timeoutMs ?? 60000, maxRequestBytes: limit,
            })), candidate.route.nativeModel);
            if (!reply) throw new Error("Native Claude runner returned an incomplete response");
            reply.model = candidate.route.alias;
            if (!response.destroyed && !controller.signal.aborted) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(reply)); }
          } catch (error) {
            if (!response.destroyed && !response.writableEnded) {
              if (error instanceof ContextCacheBlocked) { writeError(response, path, 400, "invalid_request", error.message); return; }
              const status = controller.signal.aborted && stopping ? 503 : safeStatus((error as { status?: unknown }).status);
              const code = status === 413 ? "request_too_large" : status === 429 ? "rate_limit_exceeded" : status === 400 ? "invalid_request" : "upstream_unavailable";
              const message = status === 413 ? "Native Claude request exceeds the allowed size" : status === 400 ? "Native Claude request is unsupported" : status === 429 ? "Native Claude request is rate limited" : "Native Claude request failed";
              writeError(response, path, status, code, message);
            }
          } finally { nativeActive.delete(controller); }
          return;
        }
        const health = request.method === "GET" && path === "/health";
        await proxy(request, response, wire, backendPort, controller.signal, () => stopping, health ? (status, headers, reply) => {
          let body = reply;
          try {
            const parsed = JSON.parse(reply.toString("utf8"));
            if (isRecord(parsed)) body = Buffer.from(JSON.stringify({ ...parsed, nativeActive: nativeActive.size }));
          } catch { /* Preserve an unexpected backend health reply. */ }
          const next = { ...headers }; delete next["content-length"];
          next["content-length"] = String(body.length);
          return { status, headers: next, body };
        } : undefined);
      } catch (error) {
        if (!controller.signal.aborted) {
          if ((error as Error).message === "body_too_large") writeError(response, path, 413, "request_too_large", "Request exceeds 64 MiB");
          else proxyError(response, path);
        }
      } finally {
        request.off("aborted", cancel); response.off("close", cancel); active.delete(controller);
      }
      })();
      work.add(task);
      void task.finally(() => work.delete(task));
    });
    front.requestTimeout = 0;
    await new Promise<void>((resolveResult, reject) => {
      front!.once("error", reject);
      front!.listen(source.port, "127.0.0.1", () => { front!.off("error", reject); resolveResult(); });
    });
    const port = (front.address() as { port: number }).port;
    return {
      server: front, backend, port,
      isIdle: () => active.size === 0 && nativeActive.size === 0 && contextProxies.every(proxy => proxy.isIdle()) && backend!.isIdle(),
      close: async () => {
        closing ??= (async () => {
          stopping = true;
          for (const controller of active) controller.abort();
          await rollback();
        })();
        await closing;
      },
    };
  } catch (error) {
    await rollback();
    throw error;
  }
}
