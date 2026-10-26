import type { ProviderConfig } from "../config.js";
import type { InferenceContext } from "./provider.js";

const routingSession = (context: InferenceContext): string | undefined =>
  [context.threadId, context.sessionId].find(value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value));

type CacheIdentity = Record<string, unknown>;
const openRouterSession = (value: unknown): string | undefined =>
  typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value) ? value : undefined;

/** Official API conversation affinity; never forward one service's identifiers to another origin. */
export function apiRoutingHeaders(provider: Pick<ProviderConfig, "baseUrl" | "sessionAffinity">, context: InferenceContext, request: CacheIdentity = {}): Record<string, string> {
  // An opted-in self-hosted router (vllm-router consistent_hash) keeps each conversation on the worker holding its prefix cache.
  if (provider.sessionAffinity === true) {
    const session = routingSession(context);
    return session ? { "session-id": session } : {};
  }
  let url: URL;
  try { url = new URL(provider.baseUrl || ""); } catch { return {}; }
  if (url.origin === "https://openrouter.ai" && !url.username && !url.password && !url.search && !url.hash && /^\/api\/v1\/?$/.test(url.pathname)) {
    // Reuse explicit caller choices before conversation metadata. Matching the
    // existing cache key enables first-success stickiness without regrouping forks.
    const explicit = request.session_id !== undefined ? request.session_id : request.prompt_cache_key;
    const session = explicit !== undefined ? openRouterSession(explicit) : routingSession(context);
    return session ? { "x-session-id": session } : {};
  }
  if (url.origin !== "https://opencode.ai" || url.username || url.password || url.search || url.hash ||
    !/^\/(?:inference(?:\/go)?\/(?:openai|anthropic)\/v1|zen(?:\/go)?\/v1)\/?$/.test(url.pathname)) return {};
  const session = routingSession(context);
  return { "User-Agent": "harness-gateway", ...(session ? { "x-opencode-session": session } : {}) };
}
