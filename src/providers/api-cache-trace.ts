import { createHash } from "node:crypto";
import type { ResponsesRequest, Usage } from "../protocol/types.js";
import { telemetry } from "../telemetry.js";
import { providerConversationId, type InferenceContext } from "./provider.js";

interface Prefix { catalog: string; instructions: string; opening: string; affinity: string; at: number }
const key = Symbol.for("harness-gateway/api-cache-prefixes/v1");
const state = globalThis as unknown as Record<symbol, Map<string, Prefix> | undefined>;
const prefixes = state[key] ??= new Map<string, Prefix>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");

/** Only hashes live in bounded process memory; diagnostics contain counts and change flags, never content or hashes. */
export function apiCacheTrace(scope: string, provider: string, request: ResponsesRequest, context: InferenceContext, affinity?: string): { record(usage: Usage): void } {
  const identity = providerConversationId(context) ?? affinity;
  if (!identity) return { record() {} };
  const id = hash([scope, request.model, identity]);
  const previous = prefixes.get(id);
  const opening = typeof request.input === "string" ? request.input.slice(0, 4096) : request.input.slice(0, 3).map(item => {
    const message = item as { type?: string; role?: string; content?: unknown };
    const content = typeof message.content === "string" ? message.content.slice(0, 4096) : Array.isArray(message.content)
      ? message.content.slice(0, 4).map(part => ({ type: part?.type, text: typeof part?.text === "string" ? part.text.slice(0, 4096) : undefined })) : undefined;
    return { type: message.type ?? "message", role: message.role, content };
  });
  const declarations = Array.isArray(request.input) ? request.input.filter(item => (item as { type?: string }).type === "additional_tools")
    .map(item => (item as unknown as { tools?: unknown }).tools) : [];
  const current: Prefix = { catalog: hash([request.tools, declarations]), instructions: hash(request.instructions), opening: hash(opening), affinity: hash(affinity), at: Date.now() };
  let recorded = false;
  return { record(usage) {
    const input = usage.input_tokens, cached = usage.input_tokens_details?.cached_tokens;
    if (recorded || !Number.isFinite(input) || typeof cached !== "number" || !Number.isFinite(cached) || cached < 0 || cached > input) return;
    recorded = true;
    prefixes.delete(id); prefixes.set(id, { ...current, at: Date.now() });
    while (prefixes.size > 2048) prefixes.delete(prefixes.keys().next().value!);
    if (input - cached < 65536 || cached >= input * 0.75) return;
    telemetry("api_cache_cold", { provider, model: request.model, inputTokens: input, cachedTokens: cached,
      previousMeasured: !!previous, ...(previous ? { idleSeconds: Math.max(0, (current.at - previous.at) / 1000),
        catalogChanged: current.catalog !== previous.catalog, instructionsChanged: current.instructions !== previous.instructions,
        openingChanged: current.opening !== previous.opening, affinityChanged: current.affinity !== previous.affinity } : {}) });
  } };
}
