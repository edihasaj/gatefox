import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderConfig } from "../config.js";
import { readOwnedJson, writeOwnedJson } from "../app-management/storage.js";
import { discoverAll, type CatalogResult, type DiscoveryBudget } from "./discovery.js";
import { refreshAttemptsPath } from "./state.js";
import type { AutoLatestDiscover } from "./types.js";

/**
 * A background check never spends a Codex refresh token on its own (auth/chatgpt.ts), so an account nobody chats with
 * keeps an expired token and its new models never appear. This lets the check renew such a login, but rarely and only
 * when it is safe: at most once per provider every six hours, only on mains power, and with an idle-sleep assertion
 * held for the renewal, so a refresh is not cut off halfway by sleep. Closing the lid can still interrupt one renewal.
 */
export const deferredRefreshIntervalSeconds = 6 * 60 * 60;

export interface DeferredRefreshDeps {
  /** True when sleep is unlikely to interrupt a renewal: mains power on a Mac, always elsewhere. */
  onMains(): Promise<boolean>;
  /** Runs `work` while the Mac is kept from idle sleep. */
  stayAwake<T>(work: () => Promise<T>): Promise<T>;
  readAttempts(configPath: string): Promise<Record<string, number>>;
  writeAttempts(configPath: string, attempts: Record<string, number>): Promise<void>;
}

const run = promisify(execFile);

export const defaultDeferredRefreshDeps: DeferredRefreshDeps = {
  async onMains() {
    if (process.platform !== "darwin") return true;
    try { return /'AC Power'/.test((await run("/usr/bin/pmset", ["-g", "batt"], { timeout: 5_000 })).stdout); }
    catch { return false; }
  },
  async stayAwake(work) {
    if (process.platform !== "darwin") return work();
    let child: ReturnType<typeof spawn> | undefined;
    try { child = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" }); child.on("error", () => undefined); }
    catch { child = undefined; }
    try { return await work(); } finally { child?.kill(); }
  },
  async readAttempts(configPath) {
    try {
      const value = await readOwnedJson<{ attempts?: unknown }>(await refreshAttemptsPath(configPath));
      const attempts = value?.attempts;
      if (!attempts || typeof attempts !== "object" || Array.isArray(attempts)) return {};
      return Object.fromEntries(Object.entries(attempts).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] > 0));
    } catch { return {}; }
  },
  async writeAttempts(configPath, attempts) {
    await writeOwnedJson(await refreshAttemptsPath(configPath), { version: 1, attempts });
  },
};

/**
 * Re-discovers, with token refresh allowed, the providers whose first pass was deferred, and replaces their results.
 * The attempt is recorded before the network call, so a crash or a failed renewal still waits out the interval.
 * Returns the IDs that were retried.
 */
export async function refreshDeferred(configPath: string, providers: readonly ProviderConfig[], results: Map<string, CatalogResult>,
  discover: AutoLatestDiscover, signal: AbortSignal | undefined, budget: DiscoveryBudget, nowSeconds: number,
  deps: DeferredRefreshDeps = defaultDeferredRefreshDeps): Promise<string[]> {
  const deferred = providers.filter(provider => { const result = results.get(provider.id); return Boolean(result && "deferred" in result); });
  if (!deferred.length || signal?.aborted) return [];
  const attempts = await deps.readAttempts(configPath);
  const due = deferred.filter(provider => nowSeconds - (attempts[provider.id] ?? 0) >= deferredRefreshIntervalSeconds);
  if (!due.length || !await deps.onMains()) return [];
  const known = new Set(providers.map(provider => provider.id));
  const next = Object.fromEntries(Object.entries(attempts).filter(([id]) => known.has(id)));
  for (const provider of due) next[provider.id] = nowSeconds;
  try { await deps.writeAttempts(configPath, next); } catch { return []; }
  const retried = await deps.stayAwake(() => discoverAll(due, discover, true, signal, budget));
  for (const [id, result] of retried) results.set(id, result);
  return due.map(provider => provider.id);
}
