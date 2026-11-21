import { CliContinuityUnavailable, type CliContinuityProvider } from "./cli-continuity.js";
import { ProviderError } from "./provider.js";

/** The types a provider supplies to the shared live ACP session (acp-live-session.ts), and the failure rule they share. */
export type AcpSessionState = "starting" | "generating" | "awaiting_outputs" | "turn_done" | "closed";
export type AcpSessionEnd = "reaped" | "crashed" | "closed";

/** Bounds in milliseconds; tests shorten them. `parkMs` and `toolWaitMs` override the configured timers when set. */
export interface AcpSessionLimits { startMs: number; callQuietMs: number; parkMs?: number; toolWaitMs?: number; maxDenied: number }
/** Test seam: called synchronously just before startup begins acquiring `stage`, so a test can cancel exactly there. */
export interface AcpTestHooks { boot?: (stage: "directory" | "listen") => void }
/** One `session/request_permission` answer: whether it was allowed and what to send back. */
export interface AcpPermission { allowed: boolean; result: Record<string, unknown> }

/**
 * What a provider prepares inside one session's private folder before its CLI starts (for Gemini: a disposable CLI
 * home). The session removes the folder when it ends; `release` runs first, after the process is gone, and is where
 * anything the CLI changed that must outlive the session is carried back.
 */
export interface AcpProvisioned {
  /** The CLI's whole environment. */
  env: NodeJS.ProcessEnv;
  /**
   * Polled while the CLI boots. An error means the CLI cannot start and will not say so itself (Gemini's saved sign-in
   * cannot refresh, so the CLI waits for a browser sign-in): startup ends with that error instead of waiting out its timeout.
   */
  bootFault?(): Promise<ProviderError | undefined>;
  /** Runs once, after the CLI process has been killed. */
  release(): Promise<void>;
}

/**
 * What one CLI provider brings to the shared ACP session: its name, its timing bounds, how the CLI is started, and how
 * a permission request is judged. Grok and Gemini each supply one (grok-live-session.ts, gemini-live-session.ts).
 */
export interface AcpDriver {
  /** The provider's name in fixed prose and continuity refusals ("Grok", "Gemini"). */
  label: CliContinuityProvider;
  /** Method prefixes whose `params: null` is absent rather than a protocol fault. */
  extensions?: readonly string[];
  /** Mutable timing bounds; a provider's tests shorten their own copy. */
  limits: AcpSessionLimits;
  hooks: AcpTestHooks;
  /** The CLI's arguments for one live session. `profilePath` is set only when `profile` is defined. */
  args(options: { profilePath?: string; model: string; effort?: string }): string[];
  /** The tool-less profile the CLI must run under, when its CLI needs one. */
  profile?(system: string, builtinTools: readonly string[]): string;
  /** Fixed environment the CLI needs beyond the provider's own (Grok's summary and title suppression, Gemini's system-prompt file). */
  env?(catalogPath: string, profilePath?: string): Record<string, string>;
  /** The `session/new` MCP server list naming this session's loopback endpoint. */
  mcpServers?(url: string): unknown[];
  /** Answers one agent-to-client permission request; `allow_always` is never chosen. */
  permission(params: Record<string, unknown>, catalog: ReadonlySet<string>): AcpPermission;
  /**
   * Wraps a prompt the CLI is about to receive, for a CLI that treats certain leading characters as its own commands.
   * Absent means the prompt is sent as the session rendered it, which is how Grok is driven.
   */
  framePrompt?(text: string): string;
  /**
   * A `tool_call`/`tool_call_update` announcement the provider must not tolerate: the reason code it ended the session
   * for, or nothing when the announcement may stand. Absent means every announcement is left to the permission layer,
   * which is how Grok is driven.
   */
  guardUpdate?(update: Record<string, unknown>, catalog: ReadonlySet<string>): string | undefined;
  /** Maps an ACP or process failure to the fixed provider classes; provider prose is never forwarded. */
  failure(error: unknown): ProviderError;
}

/**
 * A failure of a live session after its prompt was sent is final: the turn may already have spent allowance, so a retry
 * must not start another process. Sign-in (401) and cancellation (499) keep their own meaning.
 */
export function acpLiveFailure(label: CliContinuityProvider, error: unknown): unknown {
  if (!(error instanceof ProviderError) || error instanceof CliContinuityUnavailable || error.status === 401 || error.status === 499) return error;
  return new CliContinuityUnavailable(label, "session_dead");
}
