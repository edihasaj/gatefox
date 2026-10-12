import type { ResponsesRequest, InferenceEvent } from "../protocol/types.js";
export interface ProviderStreamDiagnostic { events: number; lastEvent?: string; reasoningItems: number; textDeltas: number; toolCalls: number }
export class ProviderError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502,
    readonly upstream?: { code?: string; event?: string; requestId?: string; retryAfterMs?: number; subtype?: string; stream?: ProviderStreamDiagnostic }) { super(message); }
}
export interface Provider {
  infer(request: ResponsesRequest, signal: AbortSignal): AsyncIterable<InferenceEvent>;
}
