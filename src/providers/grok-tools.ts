import type { ProviderConfig } from "../config.js";
import type { ResponsesRequest } from "../protocol/types.js";
import { responsesFunctionTools, type ResponsesFunctionToolBridge } from "./responses-function-tools.js";

export type GrokToolBridge = ResponsesFunctionToolBridge;

/**
 * xAI Responses supports function tools, but not Codex namespaces or custom
 * grammars. This is deliberately limited to the official xAI and OpenCode
 * Grok routes; generic Responses-compatible services retain their native wire.
 */
export function isGrokResponsesRoute(provider: Pick<ProviderConfig, "type" | "baseUrl">, model: unknown): boolean {
  if (provider.type !== "responses-api" || typeof model !== "string" || !/^grok-/.test(model)) return false;
  let url: URL;
  try { url = new URL(provider.baseUrl || ""); } catch { return false; }
  if (url.username || url.password || url.search || url.hash || url.protocol !== "https:") return false;
  if (url.origin === "https://api.x.ai") return /^\/v1\/?$/.test(url.pathname);
  return url.origin === "https://opencode.ai" && /^\/inference(?:\/go)?\/openai\/v1\/?$/.test(url.pathname);
}


export function grokToolBridge(provider: Pick<ProviderConfig, "type" | "baseUrl">, request: ResponsesRequest, body: ResponsesRequest): GrokToolBridge | undefined {
  return isGrokResponsesRoute(provider, request.model) ? responsesFunctionTools(body, "grok") : undefined;
}
