import { AcpError } from "./acp-connection.js";
import { ProviderError } from "./provider.js";
import { grokLiveArgs, grokPermission, grokProfile } from "./grok-acp.js";
import { acpLiveFailure, type AcpDriver, type AcpSessionLimits, type AcpTestHooks } from "./acp-live-session.js";
import { grokFailure } from "./grok-stream.js";

/**
 * The Grok half of the shared live ACP session (acp-live-session.ts). The session mechanics — startup, held tool calls,
 * continuation ledger, permissions, timers, teardown — are shared with the Gemini provider; this module supplies what is
 * specific to the Grok Build CLI: its `agent stdio` arguments, the mandatory tool-less profile, its summary and title
 * suppression, and its error vocabulary.
 */
export type { AcpSessionState as GrokSessionState, AcpSessionEnd as GrokSessionEnd, AcpSessionOptions as GrokSessionOptions, AcpTurn as GrokTurn } from "./acp-live-session.js";

/** Bounds in milliseconds; tests shorten them. `parkMs` and `toolWaitMs` override the configured timers when set. */
export const grokLimits: AcpSessionLimits = { startMs: 30000, callQuietMs: 400, maxDenied: 25 };
/** Test seam: called synchronously just before startup begins acquiring `stage`, so a test can cancel exactly there. */
export const grokTestHooks: AcpTestHooks = {};

/** Maps an ACP or process failure to the fixed Grok provider classes; provider prose is never forwarded. */
export function grokAcpFailure(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof AcpError) {
    const data = error.data && typeof error.data === "object" && !Array.isArray(error.data) ? error.data as Record<string, unknown> : {};
    const signedOut = error.code === -32000 && /auth|sign.?in|log.?in|credential/i.test(error.message);
    return grokFailure({ type: "result", is_error: true, error_message: error.message, error_code: signedOut ? "authentication_failed" : data.code }, "grok.result");
  }
  return new ProviderError("cli_failed", "Grok CLI failed", 502);
}

/** A failure after the prompt was sent is final for Grok too: see acpLiveFailure. */
export function grokLiveFailure(error: unknown): unknown { return acpLiveFailure("Grok", error); }

/** What the shared session needs to drive the Grok Build CLI. */
export const grokDriver: AcpDriver = {
  label: "Grok",
  extensions: ["_x.ai/"],
  limits: grokLimits,
  hooks: grokTestHooks,
  // `--always-approve` is never passed: every permission goes through the gateway.
  args: ({ profilePath, model, effort }) => grokLiveArgs(profilePath ?? "", model, effort),
  profile: grokProfile,
  // The CLI must not start inference of its own: no turn summary, no title refresh.
  env: () => ({ GROK_TURN_SUMMARY: "false", GROK_TITLE_REFRESH: "false" }),
  permission: grokPermission,
  failure: grokAcpFailure,
};
