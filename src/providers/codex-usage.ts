import { accessSync, constants, statSync } from "node:fs";

/** One usage window exactly as the provider reported it; nothing here is inferred. */
export interface CodexWindow { usedPercent: number; windowMinutes: number; resetsAt: number }
/** A provider-reported snapshot of the default Codex limit family. Either window may be missing. */
export interface CodexUsage { kind: "codex"; primary?: CodexWindow; secondary?: CodexWindow }

const earliestReset = 1577836800, latestReset = 4102444800;
const longestWindowMinutes = 1051200; // two years; far longer than any plan window
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Builds a window only when all three counters are valid. A missing or malformed field is never filled in. */
export function codexWindow(value: unknown): CodexWindow | undefined {
  const row = object(value); if (!row) return;
  const { usedPercent, windowMinutes, resetsAt } = row;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100 ||
    typeof windowMinutes !== "number" || !Number.isSafeInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > longestWindowMinutes ||
    typeof resetsAt !== "number" || !Number.isSafeInteger(resetsAt) || resetsAt < earliestReset || resetsAt > latestReset) return;
  return { usedPercent: usedPercent === 0 ? 0 : usedPercent, windowMinutes, resetsAt };
}
/** Validates a stored or transported observation; at least one valid window is required. */
export function codexUsage(value: unknown): CodexUsage | undefined {
  const row = object(value); if (!row || row.kind !== "codex") return;
  const primary = row.primary === undefined ? undefined : codexWindow(row.primary);
  const secondary = row.secondary === undefined ? undefined : codexWindow(row.secondary);
  if ((row.primary !== undefined && !primary) || (row.secondary !== undefined && !secondary) || (!primary && !secondary)) return;
  return { kind: "codex", ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) };
}
const snapshot = (primary?: CodexWindow, secondary?: CodexWindow): CodexUsage | undefined =>
  primary || secondary ? { kind: "codex", ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) } : undefined;

// Header values must be plain unsigned decimal text: no sign, space, exponent or hex, and a repeated header (joined with ", ") fails.
// Fetch's Headers has already trimmed surrounding whitespace by the time a value reaches this parser; that is not recoverable and not relied on.
const header = (headers: Headers, name: string, pattern: RegExp): number | undefined => {
  const raw = headers.get(name);
  return raw !== null && pattern.test(raw) ? Number(raw) : undefined;
};
function headerWindow(headers: Headers, side: "primary" | "secondary"): CodexWindow | undefined {
  const prefix = `x-codex-${side}-`;
  return codexWindow({ usedPercent: header(headers, prefix + "used-percent", /^\d{1,3}(?:\.\d{1,9})?$/),
    windowMinutes: header(headers, prefix + "window-minutes", /^[1-9]\d{0,7}$/), resetsAt: header(headers, prefix + "reset-at", /^\d{10}$/) });
}
/** The default numeric `x-codex-{primary,secondary}-*` header family of a Responses reply. */
export function codexUsageFromHeaders(headers: Headers): CodexUsage | undefined {
  return snapshot(headerWindow(headers, "primary"), headerWindow(headers, "secondary"));
}

function eventWindow(value: unknown): CodexWindow | undefined {
  const row = object(value); if (!row) return;
  return codexWindow({ usedPercent: row.used_percent, windowMinutes: row.window_minutes, resetsAt: row.reset_at });
}
/** A `codex.rate_limits` stream event. A named limit other than the default family is ignored, so it is never mislabelled. */
export function codexUsageFromEvent(event: unknown): CodexUsage | undefined {
  const row = object(event); if (!row || row.type !== "codex.rate_limits") return;
  for (const name of [row.metered_limit_name, row.limit_name]) {
    if (name === undefined || name === null) continue;
    if (typeof name !== "string" || name.trim().toLowerCase() !== "codex") return;
  }
  const limits = object(row.rate_limits); if (!limits) return;
  return snapshot(eventWindow(limits.primary), eventWindow(limits.secondary));
}

/**
 * Receives what one request observed, with the revision of the credential file taken around that request's token read
 * (`undefined` when the file changed or was unreadable then, which makes the store discard the counters).
 */
export type CodexUsageObserver = (usage: CodexUsage, revision: string | undefined) => Promise<void> | void;

/** Calls an observer without letting it affect the request: a throw or a rejection is dropped. */
export function observeCodexUsage(observer: CodexUsageObserver | undefined, usage: CodexUsage | undefined, revision: string | undefined): void {
  if (!observer || !usage) return;
  try { const result = observer(usage, revision); if (result && typeof result.then === "function") result.then(undefined, () => {}); } catch { /* Observation never fails inference. */ }
}

/**
 * A credential file's identity without its content: device, inode, size, mtime, ctime and mode. Replacing the file, even at
 * the same path, or changing its permissions changes it. A file the gateway cannot read has no revision.
 */
export function credentialRevision(path: string | undefined): string | undefined {
  if (!path) return;
  try {
    const info = statSync(path, { bigint: true }); if (!info.isFile()) return;
    accessSync(path, constants.R_OK);
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].join(":");
  } catch { return; }
}
