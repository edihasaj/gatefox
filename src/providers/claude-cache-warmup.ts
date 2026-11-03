import type { ProviderConfig } from "../config.js";
import type { ClaudeConversation } from "./claude-render.js";

/** Transport-size heuristic for avoiding a second large seed, not a tokenizer or context limit. */
export const largeClaudeHistoryBytes = 256 * 1024;

export function claudeLiveWarmup(config: Pick<ProviderConfig, "claudeSessions"> | undefined,
  conversation: ClaudeConversation, defaultWarmup: number): number {
  // Explicit warmup policy remains authoritative. Small/new requests retain the default.
  if (config?.claudeSessions?.warmup !== undefined) return config.claudeSessions.warmup;
  return Buffer.byteLength(JSON.stringify(conversation)) >= largeClaudeHistoryBytes ? 0 : defaultWarmup;
}
