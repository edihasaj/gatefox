/**
 * OpenAI-internal wire fields and control items Codex sends beside the conversation.
 * They are transport or executor state, not model input: the gateway removes them once,
 * in the request handler, before any provider sees the request. When nothing is removed
 * the original object is returned unchanged, so a route that re-serializes the body
 * (Responses upstreams) keeps sending byte-identical requests.
 */
import type { ResponsesRequest } from "./types.js";

export interface PreparedInternalRequest {
  /** The request as providers may see it; the very same object when nothing was removed. */
  request: ResponsesRequest;
  /** `configuration_update` input items removed before translation. */
  droppedControlItems: number;
  /** True when an input item requests remote compaction, which the gateway does not serve. */
  unsupportedCompaction: boolean;
}

/** Codex's per-item internal metadata (thread/turn routing state); never model input. */
export const passthroughField = "internal_chat_message_metadata_passthrough";
/** Codex's encrypted function arguments on `function_call` items: transport state, not input. */
export const encryptedArgsField = "encrypted_function_args";
/** Codex's MCP attribution map on `client_metadata`; its other keys are the caller's own. */
export const mcpAttributionField = "mcp_attribution";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Remove the internal fields from one input item; a copy only when something actually goes. */
function stripItem(source: unknown): { value: unknown; changed: boolean } {
  if (!object(source)) return { value: source, changed: false };
  const stripPassthrough = Object.hasOwn(source, passthroughField);
  const stripArguments = source.type === "function_call" && Object.hasOwn(source, encryptedArgsField);
  if (!stripPassthrough && !stripArguments) return { value: source, changed: false };
  const value = { ...source };
  if (stripPassthrough) delete value[passthroughField];
  if (stripArguments) delete value[encryptedArgsField];
  return { value, changed: true };
}

/**
 * Prepare a request for providers: strip internal transport fields, drop
 * `configuration_update` control items, and report a `compaction_trigger` item so the
 * handler can fail it as unsupported before any provider runs.
 */
export function stripOpenAIInternal(request: ResponsesRequest): PreparedInternalRequest {
  let droppedControlItems = 0;
  let unsupportedCompaction = false;
  if (Array.isArray(request.input)) {
    // Real callers carry item types beyond the translated union (control items among them), so each entry is read as data.
    const entries: unknown[] = request.input;
    const items: unknown[] = [];
    let changed = false;
    for (const entry of entries) {
      if (object(entry) && entry.type === "configuration_update") { droppedControlItems++; changed = true; continue; }
      // Removed like any control item so translation reports this failure, not an unknown item; the request itself never reaches a provider.
      if (object(entry) && entry.type === "compaction_trigger") { unsupportedCompaction = true; changed = true; continue; }
      const stripped = stripItem(entry);
      changed ||= stripped.changed;
      items.push(stripped.value);
    }
    if (changed) request = { ...request, input: items as ResponsesRequest["input"] };
  }
  if (object(request.client_metadata) && Object.hasOwn(request.client_metadata, mcpAttributionField)) {
    const metadata = { ...request.client_metadata };
    delete metadata[mcpAttributionField];
    request = { ...request, client_metadata: metadata };
  }
  return { request, droppedControlItems, unsupportedCompaction };
}
