import type { ProviderKind } from "./config.js";

/**
 * Which hosted web-search backend a provider type may run. Only subscription routes that reach a
 * first-party search service have one; every other route has no web search at all, so the gateway
 * drops a hosted `web_search` tool instead of failing the request.
 */
export type WebSearchBackend = "openai" | "anthropic";
export function webSearchBackend(type: ProviderKind | string): WebSearchBackend | undefined {
  if (type === "codex-subscription") return "openai";
  if (type === "claude-subscription") return "anthropic";
  return undefined;
}
