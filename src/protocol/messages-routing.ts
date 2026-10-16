import type { ProviderKind } from "../config.js";
import { ProviderError } from "../providers/provider.js";
import type { ResponsesRequest } from "./types.js";

/** Apply only the explicitly documented Messages ingress compatibility rules. */
export function messagesProviderRequest(request: ResponsesRequest, kind: ProviderKind): ResponsesRequest {
  const result = { ...request };
  const subscription = ["codex-subscription", "claude-subscription", "copilot-subscription"].includes(kind);
  // Messages requires this field. Subscription harnesses own their generation
  // limit; the HTTP response advertises that limitation and never claims a cap.
  if (subscription) delete result.max_output_tokens;
  if (subscription && ["temperature", "top_p", "stop"].some(key => result[key] !== undefined)) {
    throw new ProviderError("invalid_request", "Subscription routes do not support Messages sampling options or stop sequences", 400);
  }
  if (["responses-api", "codex-subscription"].includes(kind) && result.stop !== undefined) {
    throw new ProviderError("invalid_request", "The selected Responses provider does not support stop sequences", 400);
  }
  if (["claude-subscription", "copilot-subscription"].includes(kind) && result.parallel_tool_calls === false) {
    throw new ProviderError("invalid_request", "The selected subscription provider cannot enforce disabled parallel tool use", 400);
  }
  return result;
}
