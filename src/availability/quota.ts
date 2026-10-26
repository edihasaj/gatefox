import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { apiCredential, type ProviderConfig } from "../config.js";
import { readCredentials } from "../auth/chatgpt.js";
import { boundedJson } from "./probe.js";

export interface QuotaWindow { minutes: number; usedPercent: number; resetsAt?: number }
export interface QuotaFact {
  source: "spendwatch" | "gateway";
  /** The account email the quota belongs to, when known. */
  account?: string;
  observedAt: number;
  windows: QuotaWindow[];
  /** 100 minus the most used live window; absent when no window reports a percentage. */
  remainingPercent?: number;
  /** Prepaid credit left, in the provider's currency units, when the source reports it. */
  creditBalance?: number;
}
export interface BalanceFact { source: "openrouter"; observedAt: number; remainingUsd: number; totalUsd: number }
export type QuotaProvider = "codex" | "claude";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined;
const time = (value: unknown): number | undefined => { if (typeof value !== "string") return; const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined; };
const email = (value: unknown): string | undefined => typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? value.trim().toLowerCase() : undefined;

function window(value: unknown): QuotaWindow | undefined {
  const row = object(value); const minutes = finite(row.windowMinutes); const used = finite(row.usedPercent); const resetsAt = time(row.resetsAt);
  if (minutes === undefined || used === undefined || minutes <= 0 || minutes > 527040 || used < 0 || used > 1000) return;
  return { minutes, usedPercent: used, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}
/** Windows that still apply: a window whose reset has passed proves nothing about current use. */
export const liveWindows = (windows: QuotaWindow[], now: number) => windows.filter(entry => entry.resetsAt === undefined || entry.resetsAt > now);
export function remainingPercent(windows: QuotaWindow[], now: number): number | undefined {
  const live = liveWindows(windows, now); if (!live.length) return;
  return Math.max(0, Math.round((100 - Math.max(...live.map(entry => entry.usedPercent))) * 10) / 10);
}

/** Parses `spendwatch capacity-current --json` output into quota facts keyed by lowercased account email. */
export function parseSpendwatch(output: string, provider: QuotaProvider, now = Date.now()): Map<string, QuotaFact> {
  const facts = new Map<string, QuotaFact>();
  let rows: unknown;
  try { rows = JSON.parse(output); } catch { return facts; }
  if (!Array.isArray(rows) || rows.length > 64) return facts;
  for (const entry of rows) {
    const row = object(entry); const usage = object(row.usage);
    if (row.provider !== provider) continue;
    const account = email(row.account) ?? email(usage.accountEmail); if (!account) continue;
    const windows = [usage.primary, usage.secondary, usage.tertiary].map(window).filter((value): value is QuotaWindow => Boolean(value));
    const observedAt = time(usage.updatedAt) ?? now;
    const credits = object(usage.credits); const balance = credits.unlimited === true ? undefined : finite(credits.balance);
    // A row with neither a window nor a balance is no observation at all.
    if (!windows.length && balance === undefined) continue;
    const remaining = remainingPercent(windows, now);
    facts.set(account, { source: "spendwatch", account, observedAt: Math.min(observedAt, now), windows,
      ...(remaining !== undefined ? { remainingPercent: remaining } : {}), ...(balance !== undefined ? { creditBalance: balance } : {}) });
  }
  return facts;
}

/**
 * Runs the configured Spendwatch reader once for one provider; any failure yields no facts. The child is killed outright at
 * the deadline, and the promise settles a second later whatever the child does, so a hung reader never blocks the next round.
 */
export function runSpendwatch(command: string, provider: QuotaProvider, timeoutMs = 15000): Promise<string | undefined> {
  return new Promise(resolve => {
    let settled = false; const done = (value: string | undefined) => { if (!settled) { settled = true; clearTimeout(guard); resolve(value); } };
    const guard = setTimeout(() => done(undefined), timeoutMs + 1000); guard.unref();
    try {
      execFile(command, ["capacity-current", "--provider", provider, "--json"], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 524288, windowsHide: true, encoding: "utf8" },
        (error, stdout) => done(error ? undefined : stdout));
    } catch { done(undefined); }
  });
}

async function boundedText(path: string, limit: number): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, "r"); const info = await file.stat();
    if (!info.isFile() || info.size > limit) return;
    return await file.readFile("utf8");
  } catch { return; } finally { await file?.close().catch(() => {}); }
}
/**
 * The account email a subscription provider signs in with, read from its own local login: the Codex credential record or the
 * Claude configuration's `oauthAccount`. Read only; no token is read into the result and nothing is refreshed.
 */
export async function accountEmail(provider: ProviderConfig): Promise<string | undefined> {
  if (provider.type === "codex-subscription" && provider.credentialFile) {
    try { return email((await readCredentials(provider.credentialFile))?.email); } catch { return; }
  }
  if (provider.type === "claude-subscription") {
    const text = await boundedText(join(provider.authDirectory ?? homedir(), ".claude.json"), 16 * 1048576); if (!text) return;
    try { return email(object(object(JSON.parse(text)).oauthAccount).emailAddress); } catch { return; }
  }
}

export const isOpenRouter = (provider: ProviderConfig) => {
  // A tailnet provider's key may only go to Tailscale addresses, so its balance is never read from the public API.
  if ((provider.type !== "responses-api" && provider.type !== "chat-completions-api") || !provider.baseUrl || provider.tailnet === true) return false;
  try { const url = new URL(provider.baseUrl); return url.protocol === "https:" && url.hostname === "openrouter.ai"; } catch { return false; }
};
/** OpenRouter's prepaid balance, from `GET /credits` with the provider's own key. */
export async function openRouterBalance(provider: ProviderConfig, request: typeof fetch = fetch, now = Date.now): Promise<BalanceFact | undefined> {
  let token: string | undefined;
  try { token = await apiCredential(provider); } catch { return; }
  if (!token) return;
  try {
    const response = await request(`${provider.baseUrl!.replace(/\/$/, "")}/credits`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return; }
    const data = object(object(await boundedJson(response, 65536)).data); const total = finite(data.total_credits); const used = finite(data.total_usage);
    if (total === undefined || used === undefined) return;
    return { source: "openrouter", observedAt: now(), totalUsd: total, remainingUsd: Math.round((total - used) * 100) / 100 };
  } catch { return; }
}
