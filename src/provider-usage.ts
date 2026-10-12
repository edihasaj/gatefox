import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readClientToken, writePrivateJson, type GatewayConfig, type ProviderConfig } from "./config.js";
import { claudeLimit, type ClaudeLimit } from "./providers/claude-usage.js";

type ObjectValue = Record<string, unknown>;
export interface ProviderUsage extends ClaudeLimit { providerId: string; observedAt: number }
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
function usage(value: unknown): ProviderUsage | undefined {
  const row = object(value); const limit = claudeLimit(row);
  if (!limit || typeof row.providerId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(row.providerId) ||
    !Number.isSafeInteger(row.observedAt) || Number(row.observedAt) < 1577836800) return;
  return { ...limit, providerId: row.providerId, observedAt: Number(row.observedAt) };
}
const binding = (provider: ProviderConfig) => createHash("sha256").update(JSON.stringify([provider.id, provider.type, provider.authDirectory || null])).digest("hex");

/** Persist only sanitized provider observations, separately from model catalog generations. */
export class ProviderUsageStore {
  private rows = new Map<string, ProviderUsage & { binding: string }>();
  private writes: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  constructor(stateDirectory: string) { this.path = resolve(stateDirectory, "provider-usage.json"); }
  async restore(providers: ProviderConfig[]): Promise<void> {
    let file;
    try {
      file = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = await file.stat();
      if (!info.isFile() || info.size > 65536 || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077)))) return;
      const bytes = await file.readFile(); if (bytes.length > 65536) return;
      const saved = object(JSON.parse(bytes.toString("utf8")));
      if (saved.version !== 1 || !Array.isArray(saved.data) || saved.data.length > 128) return;
      for (const entry of saved.data) {
        const row = usage(entry); const provider = providers.find(provider => provider.id === row?.providerId && provider.type === "claude-subscription");
        if (row && provider && object(entry).binding === binding(provider)) this.rows.set(row.providerId + ":" + row.window, { ...row, binding: binding(provider) });
      }
    } catch { /* Missing or invalid observation data never disables inference. */ }
    finally { await file?.close(); }
  }
  record(provider: ProviderConfig, limit: ClaudeLimit): Promise<void> {
    const operation = this.writes.then(async () => {
      if (provider.type !== "claude-subscription" || !/^[a-z][a-z0-9_-]{0,63}$/.test(provider.id) || !claudeLimit(limit)) return;
      this.rows.set(provider.id + ":" + limit.window, { ...limit, providerId: provider.id, observedAt: Math.floor(Date.now() / 1000), binding: binding(provider) });
      while (this.rows.size > 128) this.rows.delete(this.rows.keys().next().value!);
      await writePrivateJson(this.path, { version: 1, data: [...this.rows.values()] });
    });
    this.writes = operation.catch(() => {}); return operation;
  }
  snapshot(providers: ProviderConfig[]): ProviderUsage[] {
    return [...this.rows.values()].filter(row => providers.some(provider => provider.id === row.providerId && provider.type === "claude-subscription" && binding(provider) === row.binding))
      .map(({ binding: _, ...row }) => row);
  }
}

/** Usage reads fail open for native account operations; never return stale network caches. */
export async function gatewayUsage(config: GatewayConfig): Promise<ProviderUsage[]> {
  const token = await readClientToken(resolve(config.stateDirectory, "client-token"));
  const response = await fetch(`http://127.0.0.1:${config.port}/v1/provider-usage`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(2000),
  });
  if (!response.ok || !response.body) throw new Error("Gateway usage is unavailable");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 65536) throw new Error("Gateway usage exceeds its bound"); chunks.push(next.value); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const parsed = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (!Array.isArray(parsed.data) || parsed.data.length > 128) throw new Error("Invalid gateway usage response");
  return parsed.data.map(usage).filter((row): row is ProviderUsage => Boolean(row));
}

export function mergeGatewayUsage(native: ObjectValue, observations: ProviderUsage[], now = Math.floor(Date.now() / 1000)): ObjectValue {
  const extras: ObjectValue = {};
  const nativeLimits = object(native.rateLimitsByLimitId);
  for (const row of observations) {
    // A rejected window establishes 100% usage. Allowed events give no percentage.
    // Passing reset time proves neither zero usage nor restored availability.
    if (row.status !== "rejected" || row.resetsAt <= now || row.observedAt > now + 300 || now - row.observedAt > 86400) continue;
    const limitId = `gateway:${row.providerId}:${row.window}`;
    if (Object.hasOwn(nativeLimits, limitId)) continue;
    extras[limitId] = { limitId, limitName: row.providerId === "claude" ? "Claude" : `Claude · ${row.providerId}`, primary: {
      usedPercent: 100, windowDurationMins: row.window === "five_hour" ? 300 : 10080, resetsAt: row.resetsAt,
    }, secondary: null, credits: null, planType: null, rateLimitReachedType: null };
  }
  return Object.keys(extras).length ? { ...native, rateLimitsByLimitId: { ...nativeLimits, ...extras } } : native;
}
