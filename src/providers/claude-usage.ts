export interface ClaudeLimit {
  status: "allowed" | "allowed_warning" | "rejected";
  window: "five_hour" | "seven_day" | "seven_day_sonnet" | "seven_day_opus";
  resetsAt: number;
}
const windows = new Set(["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus"]);
export function claudeLimit(value: unknown): ClaudeLimit | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (!["allowed", "allowed_warning", "rejected"].includes(String(row.status)) || !windows.has(String(row.window)) ||
    !Number.isSafeInteger(row.resetsAt) || Number(row.resetsAt) < 1577836800 || Number(row.resetsAt) > 4102444800) return;
  return { status: row.status as ClaudeLimit["status"], window: row.window as ClaudeLimit["window"], resetsAt: Number(row.resetsAt) };
}
/** Native discriminants only; ignore private error prose and unrecognized windows. */
export function claudeUsageEvent(message: Record<string, unknown>): ClaudeLimit | undefined {
  if (message.type !== "rate_limit_event" || !message.rate_limit_info || typeof message.rate_limit_info !== "object") return;
  const info = message.rate_limit_info as Record<string, unknown>;
  return claudeLimit({ status: info.status, window: info.rateLimitType, resetsAt: info.resetsAt });
}
export function claudeLimitMessage(limit?: ClaudeLimit): string {
  if (!limit) return "Claude subscription is rate limited; wait for its limit to reset";
  const window = limit.window === "five_hour" ? "five-hour" : "weekly";
  const reset = new Date(limit.resetsAt * 1000);
  const local = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(reset);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `Claude subscription ${window} usage limit reached. Provider-reported reset: ${local} (${zone}; ${reset.toISOString()}). Retry after reset.`;
}

/**
 * Measured cache read of a Claude request that reused nothing but the shared system prefix:
 * its history was a full cache write. Anything above it read part of the conversation back.
 * The number is calibrated to the Codex system prefix (the gateway's fixed text, the caller's
 * instructions and Codex's own scaffolding), so it only identifies a rewrite at that size.
 */
export const systemPrefixCacheReadTokens = 32035;
/**
 * How far past the prefix a request's whole input (cache read plus cache write) has to reach
 * before the read says anything. Below it the prompt is smaller than the prefix it would have
 * rewritten, so a low read is what any short request costs, not evidence of a full rewrite.
 */
export const systemPrefixMinInputTokens = systemPrefixCacheReadTokens + 4096;
export function systemPrefixOnly(cacheReadTokens: number | undefined, cacheWriteTokens: number | undefined): boolean | undefined {
  if (cacheReadTokens === undefined) return undefined;
  if (cacheReadTokens + (cacheWriteTokens ?? 0) <= systemPrefixMinInputTokens) return undefined;
  return cacheReadTokens <= systemPrefixCacheReadTokens;
}
