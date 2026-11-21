import { AcpError } from "./acp-connection.js";
import { ProviderError } from "./provider.js";
import { frameGeminiPrompt, geminiLiveArgs, geminiPermission, geminiToolGuard } from "./gemini-acp.js";
import { acpLiveFailure, type AcpDriver, type AcpSessionLimits, type AcpTestHooks } from "./acp-live-session.js";

/**
 * The Gemini half of the shared live ACP session (acp-live-session.ts). The session mechanics — startup, held tool
 * calls, the continuation ledger, permissions, timers and teardown — are shared with the Grok provider; this module
 * supplies what is specific to the Gemini CLI: its `--acp` arguments, the absence of a profile file (the CLI is given
 * no tools of its own beyond the gateway's single MCP server), and its error vocabulary.
 */
export type { AcpSessionState as GeminiSessionState, AcpSessionEnd as GeminiSessionEnd, AcpSessionOptions as GeminiSessionOptions, AcpTurn as GeminiTurn } from "./acp-live-session.js";

/** Bounds in milliseconds; tests shorten them. `parkMs` and `toolWaitMs` override the configured timers when set. */
export const geminiLimits: AcpSessionLimits = { startMs: 30000, callQuietMs: 400, maxDenied: 25 };
/** Test seam: called synchronously just before startup begins acquiring `stage`, so a test can cancel exactly there. */
export const geminiTestHooks: AcpTestHooks = {};

const codes = new Set(["rate_limit", "authentication_failed", "billing_error", "server_error", "overloaded", "invalid_request", "max_output_tokens", "unknown"]);
/**
 * The CLI reports a missing or unreadable Google login as a plain error with prose and no discriminant, so a signed-out
 * home otherwise looked like an upstream transport failure. Only fixed sign-in sentences are matched; no other prose is
 * inspected or forwarded.
 */
const signedOut = /\bnot (?:signed in|logged in|authenticated)\b|\bgoogle (?:account|oauth)\b|\bgemini (?:login|auth)\b/i;
/** Prose the CLI produces for an exhausted allowance or a throttled request: matched, never forwarded. */
const quota = /\b(?:rate limit|quota|resource.?exhausted|allowance|too many requests|429)\b/i;
const signInMessage = "Gemini is not signed in for the gateway. Run `gateway login gemini` with the gateway's Gemini home.";

/** Maps only native error discriminants. Provider prose is never forwarded. */
export function geminiFailure(message: Record<string, unknown>, event: "gemini.assistant" | "gemini.result"): ProviderError {
  const raw = message.error_code ?? message.error;
  const code = typeof raw === "string" && codes.has(raw) ? raw : "unknown";
  const upstream = { code, event };
  if (code === "unknown" && [message.error_message, message.errors, message.result].some(value =>
    (typeof value === "string" && signedOut.test(value)) ||
    (Array.isArray(value) && value.some(part => typeof part === "string" && signedOut.test(part))))) {
    return new ProviderError("authentication", signInMessage, 401, { code: "authentication_failed", event });
  }
  // An exhausted Ultra allowance reported only as prose still gets its own fixed class, because what the caller must do
  // differs ("retry later" rather than "this failed"). Only the fixed pattern above is matched; no provider text is
  // copied into the message, the code, or telemetry.
  if (code === "unknown" && [message.error_message, message.errors, message.result].some(value =>
    (typeof value === "string" && quota.test(value)) ||
    (Array.isArray(value) && value.some(part => typeof part === "string" && quota.test(part))))) {
    return new ProviderError("rate_limit_exceeded", "Gemini is limiting requests or the AI Ultra allowance is used up; retry later.", 429, { code: "rate_limit", event });
  }
  if (code === "authentication_failed") return new ProviderError("authentication", "Gemini could not authenticate this request. If it persists, run `gateway login gemini` for the gateway's Gemini home.", 401, upstream);
  if (code === "rate_limit") return new ProviderError("rate_limit_exceeded", "Gemini is limiting requests or the AI Ultra allowance is used up; retry later.", 429, upstream);
  if (code === "billing_error") return new ProviderError("insufficient_quota", "The Google AI Ultra subscription or billing is unavailable. Check your Google plan, then retry.", 429, upstream);
  if (code === "server_error" || code === "overloaded") return new ProviderError("upstream_unavailable", "Gemini is temporarily unavailable; retry shortly", 503, upstream);
  return new ProviderError("inference_failed", "Gemini inference did not complete", 502, upstream);
}

/** Maps an ACP or process failure to the fixed Gemini provider classes; provider prose is never forwarded. */
export function geminiAcpFailure(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof AcpError) {
    const data = error.data && typeof error.data === "object" && !Array.isArray(error.data) ? error.data as Record<string, unknown> : {};
    // A rejected sign-in on `session/new` arrives as -32000 with prose, and an unauthorised or forbidden call can carry
    // its status in the error data. Both are sign-in failures; only the fixed class below is chosen, never the text.
    const status = typeof data.status === "number" ? data.status : undefined;
    const signedOutError = (error.code === -32000 && /auth|sign.?in|log.?in|credential/i.test(error.message)) || status === 401 || status === 403;
    const throttled = status === 429 || /\b(?:rate limit|quota|resource.?exhausted|allowance|too many requests)\b/i.test(error.message);
    return geminiFailure({ is_error: true, error_message: error.message,
      error_code: signedOutError ? "authentication_failed" : throttled ? "rate_limit" : data.code }, "gemini.result");
  }
  return new ProviderError("cli_failed", "Gemini CLI failed", 502);
}

/** A failure after the prompt was sent is final for Gemini too: see acpLiveFailure. */
export function geminiLiveFailure(error: unknown): unknown { return acpLiveFailure("Gemini", error); }

/** What the shared session needs to drive the Gemini CLI. */
export const geminiDriver: AcpDriver = {
  label: "Gemini",
  // The 0.70.0 CLI implements no ACP extension methods — `extMethod` and `extNotification` answer "method not found" — so
  // no method prefix has a `params: null` that may be excused. The list is empty on purpose: such a frame is a protocol
  // fault and ends the connection rather than being guessed at.
  extensions: [],
  limits: geminiLimits,
  hooks: geminiTestHooks,
  args: ({ model, effort }) => geminiLiveArgs({ model, effort }),
  // The CLI has no system-prompt field on `session/new`, so the gateway's instructions travel as the file that
  // `GEMINI_SYSTEM_MD` names. One process per conversation means it is written once and stays immutable, which is what
  // the CLI requires: it re-reads that file on every prompt turn.
  profile: system => system,
  env: (_catalogPath, profilePath) => ({ ...(profilePath ? { GEMINI_SYSTEM_MD: profilePath } : {}) }),
  // The CLI accepts an `http` MCP server with headers, which is exactly the gateway's loopback endpoint. A `stdio` entry
  // would let the CLI spawn a process of its own, so only this shape is ever sent, and the managed settings keep
  // `mcpServers` empty so nothing outside this list can reach the session.
  mcpServers: url => [{ type: "http", name: "gateway", url, headers: [] }],
  permission: geminiPermission,
  // A prompt whose flattened text begins with `/` or `$` runs as a CLI command instead of being answered, so every
  // prompt is framed; and an announcement naming a tool the caller never offered ends the session.
  framePrompt: frameGeminiPrompt,
  guardUpdate: geminiToolGuard,
  failure: geminiAcpFailure,
};
