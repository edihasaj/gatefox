import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import { apiCredential, validBearer, type ProviderConfig } from "./config.js";
import { tailnetFetch } from "./tailnet.js";

const requestLimit = 64 * 1024 * 1024;
const errorLimit = 64 * 1024;
const qwenContextLimit = 500000;
const fixedContextError = Buffer.from(JSON.stringify({
  error: {
    code: "context_length_exceeded",
    message: "The request exceeds the model's context window",
  },
}));

type ProxyFetch = typeof fetch;

export interface ClaudeContextProxyDeps {
  fetch?: ProxyFetch;
  credentialReader?: (provider: ProviderConfig) => Promise<string | undefined>;
}

export interface ClaudeContextProxy {
  provider: ProviderConfig;
  close(): Promise<void>;
  isIdle(): boolean;
}

function fixedError(response: ServerResponse, status: number, code: string): void {
  if (!response.headersSent && !response.destroyed) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code, message: "Claude context proxy request failed" } }));
  } else if (!response.destroyed) response.destroy();
}

function pathAndQuery(request: IncomingMessage): string | undefined {
  try {
    const parsed = new URL(request.url || "/", "http://loopback.invalid");
    return parsed.pathname === "/v1/chat/completions" ? parsed.search : undefined;
  } catch {
    return;
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > requestLimit) throw new Error("body_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

const hopByHopHeaders = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

function namedByConnection(value: string | string[] | undefined): Set<string> {
  return new Set(
    (Array.isArray(value) ? value : [value])
      .flatMap(item => typeof item === "string" ? item.split(",") : [])
      .map(item => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function requestHeaders(request: IncomingMessage, credential: string, body: Buffer): Headers {
  const headers = new Headers();
  const excluded = new Set([
    ...hopByHopHeaders,
    ...namedByConnection(request.headers.connection),
    "authorization", "host", "content-length", "accept-encoding",
  ]);
  for (const [name, value] of Object.entries(request.headers)) {
    if (excluded.has(name) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("authorization", `Bearer ${credential}`);
  headers.set("accept-encoding", "identity");
  headers.set("content-length", String(body.length));
  return headers;
}

function responseHeaders(
  headers: Headers,
  options: { length?: number; stripContentEncoding?: boolean } = {},
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const excluded = new Set([
    ...hopByHopHeaders,
    ...namedByConnection(headers.get("connection") ?? undefined),
    "content-length",
    ...(options.stripContentEncoding ? ["content-encoding"] : []),
  ]);
  headers.forEach((value, name) => {
    if (!excluded.has(name)) result[name] = value;
  });
  const cookies = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (cookies?.length && !excluded.has("set-cookie")) result["set-cookie"] = cookies;
  if (options.length !== undefined) result["content-length"] = String(options.length);
  return result;
}

async function write(response: ServerResponse, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  if (response.destroyed || signal.aborted || response.writableEnded) return;
  if (response.write(bytes) || response.destroyed) return;
  await new Promise<void>(resolve => {
    const finish = () => {
      response.off("drain", finish);
      response.off("close", finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    response.once("drain", finish);
    response.once("close", finish);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function relay(response: ServerResponse, upstream: Response, signal: AbortSignal, stripContentEncoding: boolean): Promise<void> {
  response.writeHead(upstream.status, responseHeaders(upstream.headers, { stripContentEncoding }));
  if (!upstream.body) { response.end(); return; }
  const reader = upstream.body.getReader();
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) break;
      await write(response, next.value, signal);
    }
  } finally {
    if (signal.aborted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!response.destroyed && !response.writableEnded) response.end();
}

function trustedContextOverflow(body: Buffer): boolean {
  if (body.length > errorLimit) return false;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const error = (parsed as { error?: unknown }).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return false;
    const value = error as { type?: unknown; code?: unknown; param?: unknown; message?: unknown };
    if (
      value.type !== "BadRequestError"
      || value.code !== 400
      || value.param !== "input_tokens"
      || typeof value.message !== "string"
    ) return false;
    const match = /^This model's maximum context length is ([0-9]+) tokens\. However, you requested ([0-9]+) output tokens and your prompt contains at least ([0-9]+) input tokens, for a total of at least ([0-9]+) tokens\. Please reduce the length of the input prompt or the number of requested output tokens\. \(parameter=input_tokens, value=([0-9]+)\)$/.exec(value.message);
    if (!match) return false;
    const values = match.slice(1).map(Number);
    if (values.some(item => !Number.isSafeInteger(item))) return false;
    const [maximum, output, input, total, suffix] = values as [number, number, number, number, number];
    return maximum === qwenContextLimit
      && input >= maximum
      && input <= Number.MAX_SAFE_INTEGER - output
      && total === input + output
      && total > maximum
      && suffix === input;
  } catch {
    return false;
  }
}

function decodedGzip400(headers: Headers, body: Buffer, enabled: boolean): Buffer | undefined {
  if (!enabled || headers.get("content-encoding")?.trim().toLowerCase() !== "gzip") return body;
  try {
    return gunzipSync(body, { maxOutputLength: errorLimit });
  } catch {
    return;
  }
}

async function relayOrTranslate400(
  response: ServerResponse,
  upstream: Response,
  signal: AbortSignal,
  stripContentEncoding: boolean,
  decodeGzip400: boolean,
): Promise<void> {
  if (upstream.status !== 400 || !upstream.body) {
    await relay(response, upstream, signal, stripContentEncoding);
    return;
  }
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) {
        const body = Buffer.concat(chunks);
        if (trustedContextOverflow(decodedGzip400(upstream.headers, body, decodeGzip400) ?? Buffer.alloc(0))) {
          response.writeHead(400, {
            ...responseHeaders(upstream.headers, {
              length: fixedContextError.length,
              stripContentEncoding: true,
            }),
            "content-type": "application/json",
          });
          response.end(fixedContextError);
        } else {
          response.writeHead(400, responseHeaders(upstream.headers, {
            length: body.length,
            stripContentEncoding,
          }));
          response.end(body);
        }
        return;
      }
      size += next.value.length;
      chunks.push(next.value);
      if (size > errorLimit) {
        response.writeHead(400, responseHeaders(upstream.headers, { stripContentEncoding }));
        for (const chunk of chunks) await write(response, chunk, signal);
        while (!signal.aborted) {
          const remaining = await reader.read();
          if (remaining.done) break;
          await write(response, remaining.value, signal);
        }
        if (!response.destroyed && !response.writableEnded) response.end();
        return;
      }
    }
  } finally {
    if (signal.aborted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    if (!server.listening) resolve();
    else server.close(() => resolve());
  });
}

function abortableCredential(
  reader: (provider: ProviderConfig) => Promise<string | undefined>,
  provider: ProviderConfig,
  signal: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      reject(error);
    };
    const cancel = (): void => finish(undefined);
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener("abort", cancel, { once: true });
    void Promise.resolve().then(() => reader(provider)).then(finish, fail);
  });
}

/**
 * Wrap one Claude-only Chat Completions provider. The returned clone targets an
 * ephemeral loopback listener; its original base URL and tailnet policy remain
 * unchanged for upstream forwarding.
 */
export async function startClaudeContextProxy(
  providerConfig: ProviderConfig,
  deps: ClaudeContextProxyDeps = {},
): Promise<ClaudeContextProxy> {
  if (providerConfig.type !== "chat-completions-api" || !providerConfig.baseUrl) {
    throw new Error("Claude context proxy requires a Chat Completions provider");
  }
  const originalBaseUrl = providerConfig.baseUrl;
  const original = { ...providerConfig };
  const upstreamBase = originalBaseUrl.replace(/\/+$/, "");
  const directFetch = deps.fetch ?? fetch;
  const credentialReader = deps.credentialReader ?? apiCredential;
  const protectedFetch = original.tailnet ? tailnetFetch(original.id) : undefined;
  const active = new Set<AbortController>();
  const activeWork = new Set<Promise<void>>();
  let stopping = false;
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const work = (async () => {
      const query = pathAndQuery(request);
      if (request.method !== "POST" || query === undefined) {
        fixedError(response, 404, "not_found");
        return;
      }
      if (stopping) {
        fixedError(response, 503, "upstream_unavailable");
        return;
      }
      const controller = new AbortController();
      active.add(controller);
      const cancel = () => {
        if (!response.writableEnded) controller.abort();
      };
      request.once("aborted", cancel);
      response.once("close", cancel);
      try {
        let credential: string | undefined;
        try {
          credential = await abortableCredential(credentialReader, original, controller.signal);
        } catch {
          fixedError(response, 503, "upstream_unavailable");
          return;
        }
        if (stopping || controller.signal.aborted || request.destroyed || response.destroyed) return;
        if (!credential || !validBearer(request.headers.authorization, credential)) {
          fixedError(response, 401, "authentication");
          return;
        }
        const body = await readBody(request);
        const url = `${upstreamBase}/chat/completions${query}`;
        const headers = requestHeaders(request, credential, body);
        const upstream = protectedFetch
          ? await protectedFetch(url, {
            method: "POST",
            headers: Object.fromEntries(headers),
            body: body as unknown as string,
            signal: controller.signal,
          })
          : await directFetch(url, {
            method: "POST",
            headers,
            body: body as unknown as RequestInit["body"],
            signal: controller.signal,
            redirect: "error",
          });
        // Native fetch decodes a noncompliant gzip reply despite identity; its
        // stale encoding header must not reach the next HTTP client. Tailnet
        // transport retains raw bytes, except for bounded 400 classification.
        await relayOrTranslate400(
          response,
          upstream,
          controller.signal,
          !protectedFetch,
          Boolean(protectedFetch),
        );
      } catch (error) {
        if (!controller.signal.aborted && !response.destroyed) {
          fixedError(response, (error as Error).message === "body_too_large" ? 413 : 502,
            (error as Error).message === "body_too_large" ? "request_too_large" : "upstream_unavailable");
        }
      } finally {
        request.off("aborted", cancel);
        response.off("close", cancel);
        active.delete(controller);
      }
    })().catch(() => fixedError(response, 503, "upstream_unavailable"));
    activeWork.add(work);
    void work.finally(() => activeWork.delete(work));
  });
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    provider: { ...original, baseUrl: `http://127.0.0.1:${port}/v1`, tailnet: false },
    isIdle: () => active.size === 0,
    close: async () => {
      if (closing) return closing;
      stopping = true;
      closing = (async () => {
        for (const controller of active) controller.abort();
        server.closeAllConnections();
        await closeServer(server);
        while (activeWork.size) await Promise.all([...activeWork]);
      })();
      return closing;
    },
  };
}
