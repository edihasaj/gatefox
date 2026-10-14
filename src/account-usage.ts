import type { Message } from "./app-server-connection.js";

/** Rate-limit relabel/merge and the account/* stream filter. Read and merge only; nothing is forwarded live. */
const object = (value: unknown): Message => value && typeof value === "object" && !Array.isArray(value) ? value as Message : {};
const isRequest = (message: Message): boolean => message.method !== undefined && message.id !== undefined;

/** A local JSON-RPC error for a server request from an account engine, or undefined when it is not one. */
export function accountRequestReply(message: Message): Message | undefined {
  if (!isRequest(message) || typeof message.method !== "string" || !message.method.startsWith("account/")) return;
  return { id: message.id, error: { code: -32601, message: "Account requests are handled by this account's own login" } };
}

/** Notifications an account engine must never show the desktop: every account/*, meter updates included. */
export function isAccountNotification(message: Message): boolean {
  return message.id === undefined && typeof message.method === "string" && message.method.startsWith("account/");
}
/** The meter rows inside a dropped account/rateLimits/updated, when it carries any. */
export const isRateLimitsUpdated = (message: Message): boolean => message.method === "account/rateLimits/updated";

export interface LimitWindow { usedPercent?: number; windowDurationMins?: number; resetsAt?: number }
export interface AccountLimit { limitId: string; limitName: string; primary?: LimitWindow; secondary?: LimitWindow }
export interface AccountUsageSnapshot { id: string; label: string; observedAt: number; limits: AccountLimit[] }

const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
function window(value: unknown): LimitWindow | undefined {
  const source = object(value); const out: LimitWindow = {};
  for (const key of ["usedPercent", "windowDurationMins", "resetsAt"] as const) {
    const n = number(source[key]); if (n !== undefined) out[key] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Keep only IDs and numbers: names, emails, permission flags and prose never reach usage.json. */
export function sanitizeRateLimits(result: Message): AccountLimit[] {
  const map = object(result.rateLimitsByLimitId); const limits: AccountLimit[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(map)) {
    const row = object(value);
    const limitId = typeof row.limitId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(row.limitId) ? row.limitId : /^[A-Za-z0-9_-]{1,64}$/.test(key) ? key : undefined;
    if (!limitId || seen.has(limitId)) continue;
    seen.add(limitId);
    limits.push({ limitId, limitName: typeof row.limitName === "string" ? row.limitName.slice(0, 64) : limitId, primary: window(row.primary), secondary: window(row.secondary) });
  }
  return limits;
}

/** The desktop row name: the account's label, and the limit kind only when it is not the plain codex meter. */
export const accountLimitName = (label: string, limit: AccountLimit): string =>
  limit.limitName === "codex" || limit.limitName === label || !limit.limitName ? label : `${label} \u00b7 ${limit.limitName}`;

/** One account's limits as rateLimitsByLimitId entries keyed account:<id>:<limitId>. */
export function relabelAccountLimits(id: string, label: string, limits: AccountLimit[]): Record<string, Message> {
  const out: Record<string, Message> = {};
  for (const limit of limits) {
    out[`account:${id}:${limit.limitId}`] = {
      limitId: limit.limitId, limitName: accountLimitName(label, limit),
      primary: limit.primary ? { ...limit.primary } : null, secondary: limit.secondary ? { ...limit.secondary } : null,
      credits: null, planType: null, rateLimitReachedType: null,
    };
  }
  return out;
}

/** Add account meters to a native account/rateLimits/read result. Native fields are never touched. */
export function mergeAccountUsage(native: Message, snapshots: AccountUsageSnapshot[], now = Math.floor(Date.now() / 1000)): Message {
  const nativeLimits = object(native.rateLimitsByLimitId); const extras: Record<string, Message> = {};
  for (const snapshot of snapshots) {
    if (!Number.isSafeInteger(snapshot.observedAt) || now - snapshot.observedAt > 86400 || snapshot.observedAt > now + 300) continue;
    for (const [key, row] of Object.entries(relabelAccountLimits(snapshot.id, snapshot.label, snapshot.limits))) {
      if (Object.hasOwn(nativeLimits, key)) continue;
      extras[key] = row;
    }
  }
  return Object.keys(extras).length ? { ...native, rateLimitsByLimitId: { ...nativeLimits, ...extras } } : native;
}

/** Reload a persisted usage.json; anything unshapeable or older than the caller's window is ignored. */
export function parseUsageSnapshot(value: unknown): Omit<AccountUsageSnapshot, "id" | "label"> | undefined {
  const saved = object(value);
  if (saved.version !== 1 || !Number.isSafeInteger(saved.observedAt) || !Array.isArray(saved.limits)) return;
  const limits: AccountLimit[] = [];
  for (const entry of saved.limits.slice(0, 16)) {
    const row = object(entry);
    if (typeof row.limitId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(row.limitId)) return;
    limits.push({ limitId: row.limitId, limitName: row.limitId, primary: window(row.primary), secondary: window(row.secondary) });
  }
  return { observedAt: Number(saved.observedAt), limits };
}

/** The bytes written to <state>/accounts/<id>/usage.json: numbers and limitId only. */
export function usageFileContent(limits: AccountLimit[], observedAt: number): Message {
  return { version: 1, observedAt, limits: limits.map(limit => ({ limitId: limit.limitId, ...(limit.primary ? { primary: limit.primary } : {}), ...(limit.secondary ? { secondary: limit.secondary } : {}) })) };
}
export const accountIdFromUsageKey = (key: string): string | undefined => /^account:([a-z][a-z0-9_-]{0,31}):[A-Za-z0-9_-]{1,64}$/.exec(key)?.[1];
