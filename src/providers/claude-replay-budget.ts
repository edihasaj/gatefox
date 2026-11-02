import type { ClaudeTokens } from "./claude-stream.js";
import { contextCacheBudget, ContextCacheBlocked, type ContextCacheBudget } from "../context-cache-budget.js";

export { ContextCacheBlocked as ClaudeReplayBlocked };
export interface ClaudeReplayBudget {
  beforeRequest(mode: "seed" | "oneshot" | "continued"): void;
  record(tokens?: Partial<ClaudeTokens>): void;
}

/** Native Claude counts feed the same safety policy used by every Gateway provider. */
export function claudeReplayBudget(scope: string, identity: string | undefined, model: string, bytes: number): ClaudeReplayBudget & Pick<ContextCacheBudget, "track"> {
  const budget = contextCacheBudget("claude-native\0" + scope, identity, model, bytes);
  return { beforeRequest: mode => budget.beforeRequest(mode), track: () => budget.track(),
    record: tokens => budget.record({ read: tokens?.cacheRead,
      uncached: tokens?.input !== undefined && tokens.cacheWrite !== undefined ? tokens.input + tokens.cacheWrite : tokens?.cacheWrite,
      input: [tokens?.input, tokens?.cacheRead, tokens?.cacheWrite].reduce<number>((sum, value) => sum + (value ?? 0), 0),
      complete: tokens?.input !== undefined && tokens.cacheRead !== undefined && tokens.cacheWrite !== undefined }) };
}
