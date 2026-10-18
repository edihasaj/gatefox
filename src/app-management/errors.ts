import type { ManagementResponse } from "./types.js";

const messages: Record<string, string> = {
  invalid_request: "The management request is invalid.",
  invalid_configuration: "The gateway configuration is invalid.",
  unsafe_path: "The requested path is not allowed.",
  configuration_changed: "The configuration changed; refresh and try again.",
  not_found: "The requested connection was not found.",
  invalid_provider: "The provider details are invalid.",
  authentication_failed: "Sign-in did not complete.",
  auth_failed: "Sign-in did not complete.",
  missing_cli: "The required command-line tool is unavailable.",
  key_required: "An API key is required.",
  invalid_url: "The provider URL is invalid.",
  last_provider: "At least one provider must remain configured.",
  invalid_models: "The selected models are invalid.",
  draft_invalid: "The connection draft is no longer valid.",
  discovery_failed: "Model discovery did not complete.",
  external_credential: "This credential is managed outside Harness Gateway.",
  cancelled: "The management operation was cancelled.",
  operation_failed: "The management operation did not complete.",
};

export class ManagementError extends Error {
  constructor(readonly code: keyof typeof messages, message = messages[code]) { super(message); }
}

export function failure(code: keyof typeof messages): ManagementResponse {
  return { ok: false, error: { code, message: messages[code] } };
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ManagementError("cancelled");
}

export function safeFailure(error: unknown): ManagementResponse {
  if (error instanceof ManagementError) return failure(error.code);
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === "invalid_configuration" || code === "unsafe_path" || code === "configuration_changed" || code === "cancelled") return failure(code);
  return failure("operation_failed");
}
