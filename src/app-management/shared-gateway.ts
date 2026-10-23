import { resolve } from "node:path";
import { readClientToken } from "../config.js";
import type { GatewayConfig } from "../config.js";
import { gatewayInfoPath, gatewayInfoTimeoutMs, maximumGatewayInfoBytes, parseGatewayInfo } from "../gateway-info.js";
import type { SharedGateway } from "./types.js";

const unavailable: SharedGateway = { status: "unavailable", providers: [] };
const stop = () => undefined;

/**
 * The read-only view of the shared gateway a remote client configuration points at: one authenticated loopback
 * request for the public catalog. No inference, no credential content, and nothing is kept when a read fails.
 */
export async function sharedGatewayCatalog(config: GatewayConfig, signal?: AbortSignal, timeoutMs = gatewayInfoTimeoutMs): Promise<SharedGateway> {
  if (!config.clientOnly || !Number.isInteger(config.port) || config.port < 1) return unavailable;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, Math.max(1, timeoutMs)).unref();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let response: Response | undefined;
  // Every exit cancels the body and aborts the request, so a host that keeps a stream open cannot outlive this read.
  const release = () => {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    try { response?.body?.cancel().catch(stop); } catch { /* A locked stream is destroyed by the abort below. */ }
    abort();
  };
  try {
    const token = await readClientToken(resolve(config.stateDirectory, "client-token"));
    response = await fetch(`http://127.0.0.1:${config.port}${gatewayInfoPath}`, {
      method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, redirect: "error", signal: controller.signal,
    });
    if (!response.ok || !String(response.headers.get("content-type") || "").includes("application/json")) return unavailable;
    const bytes = await readStream(response.body, maximumGatewayInfoBytes, controller.signal);
    if (!bytes) return unavailable;
    let payload: unknown;
    try { payload = JSON.parse(bytes.toString("utf8")); } catch { return unavailable; }
    const info = parseGatewayInfo(payload);
    return info ? { status: "available", hostname: info.hostname, providers: info.providers } : unavailable;
  } catch { return unavailable; }
  finally { release(); }
}

/** The whole body, or nothing: a payload past the cap is refused instead of being read or truncated. */
async function readStream(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<Buffer | undefined> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value ?? new Uint8Array());
      size += chunk.length;
      if (size > limit) return undefined;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel(signal.reason).catch(stop); // cancel() releases the lock.
  }
}
