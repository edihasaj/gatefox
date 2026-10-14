import { ProviderError } from "../providers/provider.js";
import type { InferenceEvent } from "./types.js";

/** Ids the gateway gives the web searches it reports for Claude; OpenAI never issued them and must not see them. */
export const gatewayClaudeSearchPrefix = "ws_claude_";
const maxActionBytes = 16 * 1024;

/** A replayed web_search_call input item with a string identity. */
export function isHostedWebSearchCall(item: unknown): item is { type: "web_search_call"; id: string } {
  return item !== null && typeof item === "object" && (item as { type?: unknown }).type === "web_search_call" && typeof (item as { id?: unknown }).id === "string";
}

/**
 * A web_search_call an upstream emitted. Codex reads only its id, status and action, so those are
 * checked; every field is kept as received so the item can be replayed to OpenAI unchanged.
 */
export function hostedItem(value: unknown): Extract<InferenceEvent, { type: "hosted-item" }>["item"] {
  const invalid = () => new ProviderError("invalid_output", "Provider returned an invalid web search item");
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const item = value as Record<string, unknown>;
  if (item.type !== "web_search_call" || typeof item.id !== "string" || !item.id || item.id.length > 1024 || item.id.includes("\0")) throw invalid();
  if (typeof item.status !== "string" || item.status.length > 64) throw invalid();
  if (item.action !== undefined && (item.action === null || typeof item.action !== "object" || Array.isArray(item.action) || JSON.stringify(item.action).length > maxActionBytes)) throw invalid();
  return item as Extract<InferenceEvent, { type: "hosted-item" }>["item"];
}
