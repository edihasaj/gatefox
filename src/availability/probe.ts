import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { apiCredential, type ProviderConfig } from "../config.js";
import { isTailnetAddress, tailnetFetch, type TailnetSeams } from "../tailnet.js";

export type ProbeReason = "no_credential" | "not_tailnet" | "unreachable" | "rejected" | "http_error" | "invalid_response" | "model_missing";
export interface HealthFact {
  status: "healthy" | "degraded" | "unhealthy";
  observedAt: number;
  /** Fastest answering endpoint, in milliseconds. */
  latencyMs?: number;
  endpoints: { healthy: number; total: number };
  /** Upstream model IDs the endpoint serves, at most 32. */
  servedModels: string[];
  /** Configured upstream models that no answering endpoint serves. */
  missingModels: string[];
  reason?: ProbeReason;
}
export interface ProbeSeams extends TailnetSeams { fetch?: typeof fetch; now?: () => number }

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const hostOf = (baseUrl: string) => new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
/** A self-hosted model server: a Chat Completions or Responses provider on loopback or behind the tailnet check. */
export function isLocalProvider(provider: ProviderConfig): boolean {
  if ((provider.type !== "chat-completions-api" && provider.type !== "responses-api") || !provider.baseUrl) return false;
  try { return provider.tailnet === true || loopbackHosts.has(hostOf(provider.baseUrl)); } catch { return false; }
}

const maxBody = 262144;
/** Reads a JSON body, refusing it as soon as it passes `limit` bytes instead of buffering it whole first. */
export async function boundedJson(response: Response, limit = maxBody): Promise<unknown> {
  if (!response.body) throw new Error("empty");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > limit) throw new Error("too large"); chunks.push(next.value); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function modelIds(value: unknown): string[] | undefined {
  const data = value && typeof value === "object" ? (value as { data?: unknown }).data : undefined;
  if (!Array.isArray(data) || data.length > 1024) return;
  return data.flatMap(entry => entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test((entry as { id: string }).id) ? [(entry as { id: string }).id] : []);
}

type EndpointResult = { ok: true; latencyMs: number; models: string[] } | { ok: false; reason: ProbeReason };

/**
 * Reads `GET {baseUrl}/models` from every address of a local provider. A tailnet provider's key goes only to Tailscale
 * addresses, each checked and dialed through the same transport inference uses; nothing else is contacted.
 */
export async function probeLocalProvider(provider: ProviderConfig, seams: ProbeSeams = {}, timeoutMs = 3000): Promise<HealthFact> {
  const now = seams.now ?? Date.now; const configured = [...new Set(Object.values(provider.models))];
  const fact = (status: HealthFact["status"], reason: ProbeReason | undefined, results: EndpointResult[]): HealthFact => {
    const healthy = results.filter((result): result is Extract<EndpointResult, { ok: true }> => result.ok);
    const served = [...new Set(healthy.flatMap(result => result.models))];
    const latency = healthy.length ? Math.min(...healthy.map(result => result.latencyMs)) : undefined;
    return { status, observedAt: now(), ...(latency !== undefined ? { latencyMs: latency } : {}), endpoints: { healthy: healthy.length, total: results.length },
      servedModels: served.slice(0, 32), missingModels: healthy.length ? configured.filter(model => !served.includes(model)) : [], ...(reason ? { reason } : {}) };
  };
  let token: string | undefined;
  try { token = await apiCredential(provider); } catch { token = undefined; }
  if (!token) return fact("unhealthy", "no_credential", []);
  const base = provider.baseUrl!.replace(/\/$/, ""); const host = hostOf(base);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const read = async (request: (signal: AbortSignal) => Promise<Response>): Promise<EndpointResult> => {
    const started = now();
    let response: Response;
    try { response = await request(AbortSignal.timeout(timeoutMs)); } catch { return { ok: false, reason: "unreachable" }; }
    if (response.status === 401 || response.status === 403) { await response.body?.cancel().catch(() => {}); return { ok: false, reason: "rejected" }; }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return { ok: false, reason: "http_error" }; }
    try { const models = modelIds(await boundedJson(response)); return models ? { ok: true, latencyMs: Math.max(0, now() - started), models } : { ok: false, reason: "invalid_response" }; }
    catch { return { ok: false, reason: "invalid_response" }; }
  };
  let results: EndpointResult[];
  if (provider.tailnet) {
    const answers = isIP(host) ? [host] : await (seams.resolve ?? (async (name: string) => (await lookup(name, { all: true, verbatim: true })).map(entry => entry.address)))(host).catch(() => [] as string[]);
    const addresses = [...new Set(answers.filter(isTailnetAddress))].slice(0, 4);
    if (!answers.length) return fact("unhealthy", "unreachable", []);
    if (!addresses.length) return fact("unhealthy", "not_tailnet", []);
    results = await Promise.all(addresses.map(address => read(signal =>
      tailnetFetch(provider.id, { ...seams, resolve: async () => [address], connectTimeoutMs: Math.min(timeoutMs, seams.connectTimeoutMs ?? 1500) })(`${base}/models`, { method: "GET", headers, signal }))));
  } else {
    const request = seams.fetch ?? fetch;
    results = [await read(signal => request(`${base}/models`, { headers, redirect: "error", signal }))];
  }
  const healthy = results.filter(result => result.ok).length;
  const firstReason = (results.find(result => !result.ok) as { reason: ProbeReason } | undefined)?.reason;
  const built = fact(!healthy ? "unhealthy" : healthy < results.length ? "degraded" : "healthy", healthy === results.length ? undefined : firstReason, results);
  if (healthy && configured.length && built.missingModels.length === configured.length) return { ...built, status: "unhealthy", reason: "model_missing" };
  if (built.status === "healthy" && built.missingModels.length) return { ...built, status: "degraded" };
  return built;
}
