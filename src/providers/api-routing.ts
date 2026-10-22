import type { ProviderConfig } from "../config.js";
import type { InferenceContext } from "./provider.js";

const routingSession = (context: InferenceContext): string | undefined =>
  [context.threadId, context.sessionId].find(value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value));

/** OpenCode's coding API uses the caller's conversation ID for routing and prompt-cache affinity. */
export function apiRoutingHeaders(provider: Pick<ProviderConfig, "baseUrl" | "sessionAffinity">, context: InferenceContext): Record<string, string> {
  // An opted-in self-hosted router (vllm-router consistent_hash) keeps each conversation on the worker holding its prefix cache.
  if (provider.sessionAffinity === true) {
    const session = routingSession(context);
    return session ? { "session-id": session } : {};
  }
  let url: URL;
  try { url = new URL(provider.baseUrl || ""); } catch { return {}; }
  if (url.origin !== "https://opencode.ai" || url.username || url.password || url.search || url.hash ||
    !/^\/(?:inference(?:\/go)?\/(?:openai|anthropic)\/v1|zen(?:\/go)?\/v1)\/?$/.test(url.pathname)) return {};
  const session = routingSession(context);
  return { "User-Agent": "harness-gateway", ...(session ? { "x-opencode-session": session } : {}) };
}
