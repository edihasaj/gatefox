import { createHash } from "node:crypto";
import type { ProviderConfig } from "../config.js";
import { ResponsesTranslationError } from "./request.js";
import type { ResponsesRequest, ResponsesInputItem } from "./types.js";

/** Opaque upstream state belongs to an explicit account route, across restarts. */
export function reasoningScope(provider: ProviderConfig): string {
  return createHash("sha256").update(JSON.stringify([provider.id, provider.type, provider.credentialFile || "", provider.authDirectory || "", provider.baseUrl || ""])).digest("hex");
}

export function wrapReasoning(item: Record<string, unknown>, scope: string): Record<string, unknown> {
  const encrypted = item.encrypted_content;
  return typeof encrypted === "string" && encrypted ? { ...item, encrypted_content: `gws1:${scope}:${Buffer.from(encrypted).toString("base64url")}` } : item;
}

export function restoreReasoning(request: ResponsesRequest, scope: string): ResponsesRequest {
  if (!Array.isArray(request.input)) return request;
  const input = request.input.flatMap<ResponsesInputItem>(item => {
    if (item.type !== "reasoning") return [item];
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
