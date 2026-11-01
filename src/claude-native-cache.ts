import type { IncomingHttpHeaders } from "node:http";
import type { ProviderConfig } from "./config.js";
import { cacheGuardedInference } from "./cache-guarded-inference.js";
import { reasoningScope } from "./protocol/reasoning-state.js";
import { inferenceContext, type Provider, type ProviderCacheUsage } from "./providers/provider.js";

const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Native Anthropic input excludes reads and writes; incomplete totals stay unknown. */
export function nativeCacheUsage(value: unknown): ProviderCacheUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const usage = value as Record<string, unknown>;
  const input = usage.input_tokens, read = usage.cache_read_input_tokens, writes = usage.cache_creation_input_tokens;
  const total = (count(input) ? input : 0) + (count(read) ? read : 0) + (count(writes) ? writes : 0);
  return {
    ...(count(input) && count(read) && count(writes) ? { inputTokens: total }
      : count(input) || count(read) || count(writes) ? { inputTokensLowerBound: total } : {}),
    ...(count(read) ? { cachedTokens: read } : {}), ...(count(writes) ? { cacheWriteTokens: writes } : {}),
  };
}

/** Auxiliary native requests have a bounded budget separate from conversational inference. */
export async function cacheGuardedNativeMessages(provider: ProviderConfig, payload: Record<string, unknown>,
  headers: IncomingHttpHeaders, signal: AbortSignal,
  run: (observe: (usage: Record<string, unknown>) => void) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  let reply: Record<string, unknown> | undefined;
  const adapter: Provider = {
    async *infer(_request, _signal, context) {
      const observe = (usage: unknown) => context?.observeCacheUsage?.(nativeCacheUsage(usage));
      reply = await run(observe);
      observe(reply.usage);
    },
  };
  const context = { ...inferenceContext(headers, payload), requestKind: "turn" as const };
  for await (const _ of cacheGuardedInference(adapter,
    { model: String(payload.model), input: JSON.stringify(payload.messages ?? []) }, signal, context,
    reasoningScope(provider) + "\0native-classifier")) { /* The native response stays unchanged. */ }
  return reply!;
}
