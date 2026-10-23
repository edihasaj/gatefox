import { createHash } from "node:crypto";
import type { ProviderConfig } from "../config.js";
import { ResponsesTranslationError } from "./request.js";
import type { ResponsesRequest, ResponsesInputItem, ResponsesReasoningItem } from "./types.js";

/** Opaque upstream state belongs to an explicit account route, across restarts. */
export function reasoningScope(provider: ProviderConfig): string {
  return createHash("sha256").update(JSON.stringify([provider.id, provider.type, provider.credentialFile || "", provider.authDirectory || "", provider.baseUrl || ""])).digest("hex");
}

export function wrapReasoning(item: Record<string, unknown>, scope: string): Record<string, unknown> {
  const encrypted = item.encrypted_content;
  return typeof encrypted === "string" && encrypted ? { ...item, encrypted_content: `gws1:${scope}:${Buffer.from(encrypted).toString("base64url")}` } : item;
}

export interface RestoreReasoningOptions {
  /** Claude replays only public summaries; it cannot safely resume opaque native thinking. */
  preserveSummaries?: boolean;
}

function publicSummary(item: ResponsesReasoningItem): { text: string; type: "summary_text" }[] | undefined {
  if (item.summary === undefined) return;
  if (!Array.isArray(item.summary)) throw new ResponsesTranslationError("Reasoning summary must be a list", "invalid_reasoning_state");
  const summary = item.summary.map(part => {
    if (part === null || typeof part !== "object" || Array.isArray(part) || part.type !== "summary_text" || typeof part.text !== "string") {
      throw new ResponsesTranslationError("Reasoning summary must contain summary text", "invalid_reasoning_state");
    }
    return { type: "summary_text" as const, text: part.text };
  });
  return summary.map(part => part.text).join("\n") ? summary : undefined;
}

export function restoreReasoning(request: ResponsesRequest, scope: string, options: RestoreReasoningOptions = {}): ResponsesRequest {
  if (!Array.isArray(request.input)) return request;
  const input = request.input.flatMap<ResponsesInputItem>(item => {
    if (item.type !== "reasoning") return [item];
    if (options.preserveSummaries) {
      // Never carry opaque Codex state into Claude: it has no compatible signature or thinking block.
      const summary = publicSummary(item);
      return summary ? [{ type: "reasoning", summary }] : [];
    }
    const encrypted = item.encrypted_content;
    if (typeof encrypted === "string" && encrypted.startsWith(`gws1:${scope}:`)) {
      const payload = encrypted.slice(scope.length + 6);
      const original = Buffer.from(payload, "base64url").toString("utf8");
      if (!payload || Buffer.from(original).toString("base64url") !== payload) throw new ResponsesTranslationError("Malformed gateway reasoning state", "invalid_reasoning_state");
      return [{ ...item, encrypted_content: original }];
    }
    const summary = item.summary?.map(part => part.text).join("\n");
    return summary ? [{ type: "message", role: "assistant", content: summary }] : [];
  });
  return { ...request, input };
}
