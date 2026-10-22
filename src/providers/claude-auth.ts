import { ProviderError } from "./provider.js";

export type ClaudeCredentialReason = "login_unavailable" | "session_expired" | "credential_revoked" | "upstream_rejected" | "unknown";

const maxDiagnosticCharacters = 16 * 1024;
const maxDiagnosticParts = 8;
const loginUnavailable = /\b(?:not logged in|authentication required|login expired)\b/i;
const sessionExpired = /\b(?:OAuth session expired and could not be refreshed|(?:(?:OAuth|access|refresh) )?token (?:(?:has|is) )?(?:expired|no longer valid))\b/i;
const credentialRevoked = /\b(?:(?:(?:OAuth|access|refresh) )?token (?:(?:has been|has|is) )?revoked|credentials have been revoked)\b/i;
const upstreamRejected = /^(?:Failed to authenticate\. API Error: 401(?:\D|$)|Please run \/login · API Error: 401(?:\D|$))/i;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Only the native failed-message envelope is inspected, with fixed bounds and no tool data. */
function diagnostics(message: Record<string, unknown>, assistant: boolean): string[] | undefined {
  const parts: string[] = [];
  let incomplete = false;
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    if (value.length > maxDiagnosticCharacters || parts.length >= maxDiagnosticParts) { incomplete = true; return; }
    parts.push(value);
  };
  add(message.error_message);
  if (assistant) {
    const content = object(message.message)?.content;
    if (typeof content === "string") add(content);
    else if (Array.isArray(content)) {
      if (content.length > maxDiagnosticParts) return;
      for (const block of content) {
        const native = object(block);
        if (native?.type === "text") add(native.text);
        if (incomplete) break;
      }
    }
  } else {
    add(message.result);
    if (Array.isArray(message.errors)) {
      if (message.errors.length > maxDiagnosticParts) return;
      for (const error of message.errors) {
        add(error);
        if (incomplete) break;
      }
    }
  }
  return incomplete ? undefined : parts;
}

export function claudeCredentialReason(message: Record<string, unknown>, assistant: boolean): ClaudeCredentialReason {
  const values = diagnostics(message, assistant);
  // A partial envelope must not authorize a retry: a later diagnostic could be a specific permanent state.
  if (!values) return "unknown";
  // Explicit credential states anywhere in the bounded native envelope outrank a generic CLI 401.
  if (values.some(value => credentialRevoked.test(value))) return "credential_revoked";
  if (values.some(value => sessionExpired.test(value))) return "session_expired";
  if (values.some(value => loginUnavailable.test(value))) return "login_unavailable";
  if (values.some(value => upstreamRejected.test(value))) return "upstream_rejected";
  return "unknown";
}

const messageFor = (reason: ClaudeCredentialReason): string =>
  reason === "upstream_rejected" || reason === "unknown"
    ? "Claude could not authenticate this request. Retry; if it persists, sign in again."
    : "Claude subscription requires login";

/** Maps only native `authentication_failed` failures. Successful prose and tool data never reach this classifier. */
export function claudeAuthenticationFailure(message: Record<string, unknown>): ProviderError | undefined {
  const assistant = message.type === "assistant" && message.error === "authentication_failed";
  const result = message.type === "result" && message.is_error === true && message.error_code === "authentication_failed";
  if (!assistant && !result) return;
  const event = assistant ? "claude.assistant" : "claude.result";
  const reason = claudeCredentialReason(message, assistant);
  return new ProviderError("authentication", messageFor(reason), 401, { code: "authentication_failed", event, reason });
}
