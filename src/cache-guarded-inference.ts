import { contextCacheBudget, type CacheCounts } from "./context-cache-budget.js";
import { providerRefusal, type InferenceContext, type Provider, type ProviderCacheUsage } from "./providers/provider.js";
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
  context: InferenceContext, scope: string, options: { advisory?: boolean; cancelled?: () => boolean } = {}): AsyncGenerator<InferenceEvent> {
  const identity = context.threadId ?? context.sessionId;
  // Recovery is available even when the ordinary request budget is blocked, but repeated
  // cold compactions have their own bound rather than an unlimited exemption.
  // A client's side requests are not the conversation either, so they keep their own count.
  const guardIdentity = context.requestKind === "compaction" || context.requestKind === "auxiliary" ? JSON.stringify([identity ?? null, context.requestKind]) : identity;
  const budget = contextCacheBudget(scope, guardIdentity, request.model, Buffer.byteLength(JSON.stringify(request.input)), options);
  // Cache safety never impersonates a model context limit or asks the client to compact.
  budget.beforeRequest("provider");
  const finishActivity = budget.track();
  let observed: CacheCounts | undefined;
  // A caller that disconnects after a finished response cancelled nothing, and Codex does that at once.
  let finished = false;
  const callerCancelled = () => !finished && options.cancelled?.() === true;
  const observeCacheUsage = (value: ProviderCacheUsage) => {
    const next = observedCacheCounts(value);
    // A default/missing terminal usage object cannot erase an earlier measured cache snapshot.
    if (next.complete || !observed?.complete || valid(next.input) && valid(observed.input) && next.input > observed.input) observed = next;
    context.observeCacheUsage?.(value);
  };
  let refused = false;
  try {
    for await (const event of provider.infer(request, signal, { ...context, observeCacheUsage, callerCancelled })) {
      if (event.type === "usage" || event.type === "done") observeCacheUsage(reported(event.usage, event.accounting));
      if (event.type === "done" && event.interrupted !== true) finished = true;
      yield event;
    }
  } catch (error) {
    refused = providerRefusal(error);
    throw error;
  } finally {
    try { budget.record(observed, { cancelled: callerCancelled(), refused }); } finally { finishActivity(); }
  }
}
