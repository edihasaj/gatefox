import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readClientToken, writePrivateJson, type GatewayConfig, type ProviderConfig } from "./config.js";
import { claudeLimit, type ClaudeLimit } from "./providers/claude-usage.js";
import { codexUsage, credentialRevision, type CodexUsage, type CodexWindow } from "./providers/codex-usage.js";

type ObjectValue = Record<string, unknown>;
export interface ProviderUsage extends ClaudeLimit { providerId: string; observedAt: number }
/** Provider-reported Codex counters for the default limit family; shares the endpoint with Claude rows. */
export interface CodexProviderUsage extends CodexUsage { providerId: string; observedAt: number }
export type ObservedProviderUsage = ProviderUsage | CodexProviderUsage;
export const isCodexUsage = (row: ObservedProviderUsage): row is CodexProviderUsage => "kind" in row && row.kind === "codex";
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const validRow = (row: ObjectValue) => typeof row.providerId === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(row.providerId) &&
  Number.isSafeInteger(row.observedAt) && Number(row.observedAt) >= 1577836800;
function claudeRow(value: unknown): ProviderUsage | undefined {
  const row = object(value); const limit = claudeLimit(row);
  if (!limit || !validRow(row)) return;
  return { ...limit, providerId: row.providerId as string, observedAt: Number(row.observedAt) };
}
function codexRow(value: unknown): CodexProviderUsage | undefined {
  const row = object(value); const observed = codexUsage(row);
  if (!observed || !validRow(row)) return;
  return { ...observed, providerId: row.providerId as string, observedAt: Number(row.observedAt) };
}
const usage = (value: unknown): ObservedProviderUsage | undefined => claudeRow(value) ?? codexRow(value);
const binding = (provider: ProviderConfig) => createHash("sha256").update(JSON.stringify([provider.id, provider.type, provider.authDirectory || null])).digest("hex");
/**
 * A Codex counter belongs to one credential file as it is now: the path and its stat identity (device, inode, size, mtime),
 * never its content or a token. A replaced file, a changed path or an unreadable file leaves no binding, so no old counter shows.
 */
function codexBinding(provider: ProviderConfig, revision: string | undefined): string | undefined {
  return provider.type !== "codex-subscription" || revision === undefined ? undefined : createHash("sha256").update(JSON.stringify([provider.id, provider.type, provider.credentialFile, revision])).digest("hex");
}
const rowKey = (row: ObservedProviderUsage) => row.providerId + ":" + (isCodexUsage(row) ? "codex" : row.window);
const bound = (provider: ProviderConfig, row: ObservedProviderUsage, saved: unknown) => isCodexUsage(row)
  ? provider.type === "codex-subscription" && saved !== undefined && codexBinding(provider, credentialRevision(provider.credentialFile)) === saved
  : provider.type === "claude-subscription" && binding(provider) === saved;
const sameWindows = (a: CodexUsage, b: CodexUsage) => JSON.stringify([a.primary, a.secondary]) === JSON.stringify([b.primary, b.secondary]);

/** Persist only sanitized provider observations, separately from model catalog generations. */
export class ProviderUsageStore {
  private rows = new Map<string, ObservedProviderUsage & { binding: string }>();
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
        const row = usage(entry); const stored = object(entry).binding;
        const provider = providers.find(provider => row && provider.id === row.providerId && bound(provider, row, stored));
        if (row && provider && typeof stored === "string") this.rows.set(rowKey(row), { ...row, binding: stored });
      }
    } catch { /* Missing or invalid observation data never disables inference. */ }
    finally { await file?.close(); }
  }
  record(provider: ProviderConfig, limit: ClaudeLimit): Promise<void> {
    return this.enqueue(() => {
      if (provider.type !== "claude-subscription" || !claudeLimit(limit)) return false;
      this.rows.set(provider.id + ":" + limit.window, { ...limit, providerId: provider.id, observedAt: Math.floor(Date.now() / 1000), binding: binding(provider) });
      return true;
    }, provider);
  }
  /**
   * `revision` is the credential file as the request saw it around its token read, taken before the request went out. It is
   * checked again when the write runs: a counter is kept only if the file is still that exact file, so a replacement while the
   * request was in flight (or while this write waited) never attributes an old account's counters to the new one.
   */
  recordCodex(provider: ProviderConfig, usage: CodexUsage, revision: string | undefined): Promise<void> {
    const expected = codexBinding(provider, revision); // fixed now, before anything can wait
    return this.enqueue(() => {
      const observed = codexUsage(usage); const current = codexBinding(provider, credentialRevision(provider.credentialFile));
      if (!observed || !expected || expected !== current) return false;
      const key = provider.id + ":codex"; const previous = this.rows.get(key); const observedAt = Math.floor(Date.now() / 1000);
      // An unchanged counter seen again within a minute adds nothing worth a disk write.
      if (previous && isCodexUsage(previous) && previous.binding === current && observedAt - previous.observedAt < 60 && sameWindows(previous, observed)) return false;
      this.rows.delete(key); this.rows.set(key, { ...observed, providerId: provider.id, observedAt, binding: current });
      return true;
    }, provider);
  }
  private enqueue(apply: () => boolean, provider: ProviderConfig): Promise<void> {
    const operation = this.writes.then(async () => {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider.id) || !apply()) return;
      while (this.rows.size > 128) this.rows.delete(this.rows.keys().next().value!);
      await writePrivateJson(this.path, { version: 1, data: [...this.rows.values()] });
    });
    this.writes = operation.catch(() => {}); return operation;
  }
  snapshot(providers: ProviderConfig[]): ObservedProviderUsage[] {
    return [...this.rows.values()].filter(row => providers.some(provider => provider.id === row.providerId && bound(provider, row, row.binding)))
      .map(({ binding: _, ...row }) => row);
  }
}

/** Usage reads fail open for native account operations; never return stale network caches. */
export async function gatewayUsage(config: GatewayConfig): Promise<ObservedProviderUsage[]> {
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
  return parsed.data.map(usage).filter((row): row is ObservedProviderUsage => Boolean(row));
}

/** A Codex window the provider reported and that has not yet reset, in the desktop's field names. */
const liveWindow = (window: CodexWindow | undefined, now: number) => window && window.resetsAt > now
  ? { usedPercent: window.usedPercent, windowDurationMins: window.windowMinutes, resetsAt: window.resetsAt } : null;

export function mergeGatewayUsage(native: ObjectValue, observations: ObservedProviderUsage[], now = Math.floor(Date.now() / 1000)): ObjectValue {
  const extras: ObjectValue = {};
  const nativeLimits = object(native.rateLimitsByLimitId);
  for (const row of observations) {
    if (isCodexUsage(row)) {
      // Only counters the provider reported are shown, exactly as reported. Nothing is added for a missing window.
      if (row.observedAt > now + 300 || now - row.observedAt > 86400) continue;
      const limitId = `gateway:${row.providerId}:codex`;
      const primary = liveWindow(row.primary, now), secondary = liveWindow(row.secondary, now);
      if (Object.hasOwn(nativeLimits, limitId) || (!primary && !secondary)) continue;
      extras[limitId] = { limitId, limitName: `Codex · ${row.providerId}`, primary, secondary, credits: null, planType: null, rateLimitReachedType: null };
      continue;
    }
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
