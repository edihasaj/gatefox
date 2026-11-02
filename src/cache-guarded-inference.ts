import { contextCacheBudget, type CacheCounts } from "./context-cache-budget.js";
import type { InferenceContext, Provider, ProviderCacheUsage } from "./providers/provider.js";
import type { InferenceEvent, ResponsesRequest, Usage, UsageAccounting } from "./protocol/types.js";

const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function observedCacheCounts(value: ProviderCacheUsage): CacheCounts {
  const gross = value.inputTokens, input = valid(gross) ? gross : value.inputTokensLowerBound, read = value.cachedTokens, writes = value.cacheWriteTokens;
  return { ...(valid(input) ? { input } : {}), ...(valid(read) ? { read } : {}),
    complete: valid(gross) && valid(read) && read <= gross,
    ...(valid(gross) && valid(read) && read <= gross ? { uncached: gross - read }
      : valid(writes) ? { uncached: writes } : {}) };
}
const reported = (usage: Usage, accounting?: UsageAccounting): ProviderCacheUsage => ({
  inputTokens: usage.input_tokens, cachedTokens: usage.input_tokens_details?.cached_tokens,
  cacheWriteTokens: accounting?.cacheWriteTokens ?? usage.input_tokens_details?.cache_creation_tokens,
});

/** Empty-completion repair must not silently resubmit already measured large input. */
export function largeUncachedUsage(value: ProviderCacheUsage): boolean {
  const counts = observedCacheCounts(value);
  return counts.complete !== false && valid(counts.read) && valid(counts.uncached)
    ? counts.uncached >= 65536 && counts.uncached > counts.read
    : valid(counts.input) && counts.input >= 65536 || valid(counts.uncached) && counts.uncached >= 65536;
}

/** One guard at the shared provider boundary, including usage reported before an error or abort. */
export async function* cacheGuardedInference(provider: Provider, request: ResponsesRequest, signal: AbortSignal,
  context: InferenceContext, scope: string): AsyncGenerator<InferenceEvent> {
  const identity = context.threadId ?? context.sessionId;
  // Recovery is available even when the ordinary request budget is blocked, but repeated
  // cold compactions have their own bound rather than an unlimited exemption.
  const guardIdentity = context.requestKind === "compaction" ? JSON.stringify([identity ?? null, "compaction"]) : identity;
  const budget = contextCacheBudget(scope, guardIdentity, request.model, Buffer.byteLength(JSON.stringify(request.input)));
  // A caller declaring a normal SDK turn can recover using its own compaction.
  // Compaction itself and unclassified clients keep the final refusal, preventing trim/retry loops.
  budget.beforeRequest("provider", context.cacheRecovery === true && context.requestKind === "turn" && !!context.turnId && !!context.threadId && context.clientProtocol !== "messages");
  const finishActivity = budget.track();
  let observed: CacheCounts | undefined;
  const observeCacheUsage = (value: ProviderCacheUsage) => {
    const next = observedCacheCounts(value);
    // A default/missing terminal usage object cannot erase an earlier measured cache snapshot.
    if (next.complete || !observed?.complete || valid(next.input) && valid(observed.input) && next.input > observed.input) observed = next;
    context.observeCacheUsage?.(value);
  };
  try {
    for await (const event of provider.infer(request, signal, { ...context, observeCacheUsage })) {
      if (event.type === "usage" || event.type === "done") observeCacheUsage(reported(event.usage, event.accounting));
      yield event;
    }
  } finally {
    try { budget.record(observed); } finally { finishActivity(); }
  }
}
