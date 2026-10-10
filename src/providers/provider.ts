import type { ResponsesRequest, InferenceEvent } from "../protocol/types.js";
export class ProviderError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) { super(message); }
}
export interface Provider {
  infer(request: ResponsesRequest, signal: AbortSignal): AsyncIterable<InferenceEvent>;
}
