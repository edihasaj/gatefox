import type { ResponsesRequest, InferenceEvent } from "../protocol/types.js";
export interface ProviderStreamDiagnostic { events: number; lastEvent?: string; reasoningItems: number; textDeltas: number; toolCalls: number }
export class ProviderError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502,
    readonly upstream?: { code?: string; event?: string; requestId?: string; retryAfterMs?: number; subtype?: string; stream?: ProviderStreamDiagnostic }) { super(message); }
}
/** Caller-supplied conversation routing identifiers; never request content. */
export interface InferenceContext { sessionId?: string; threadId?: string }
export interface Provider {
  infer(request: ResponsesRequest, signal: AbortSignal, context?: InferenceContext): AsyncIterable<InferenceEvent>;
}

const routingId = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;

/** Reads Codex's session and thread headers. Malformed or repeated values are ignored. */
export function inferenceContext(headers: Record<string, string | string[] | undefined>): InferenceContext {
  const sessionId = routingId(headers["session-id"]) ?? routingId(headers["session_id"]);
  const threadId = routingId(headers["thread-id"]) ?? routingId(headers["thread_id"]);
  return { ...(sessionId ? { sessionId } : {}), ...(threadId ? { threadId } : {}) };
}
