import type { Message } from "./app-server-connection.js";
import { telemetry } from "./telemetry.js";

/**
 * Why a chat's gateway executor connection was gone: `engine_closed` when its host went away or a private executor exited,
 * `generation_retired` when the host is still connected but no longer serves that connection.
 */
export type ReattachReason = "engine_closed" | "generation_retired";
/** Why a re-attach failed: no host or generation could be acquired, or the executor refused to resume the chat. */
export type ReattachFailure = "host_unavailable" | "resume_failed";

/**
 * The `thread/resume` fields that describe how a chat was loaded; nothing about a turn or its content. Only what the SDK
 * cannot restore from the chat's history is replayed: model, provider, reasoning effort, approval policy, approvals
 * reviewer and permissions are deliberately absent, because a resume that omits them makes the SDK apply the latest
 * values saved with the chat, and replaying load-time ones would revert any change the chat made after it was loaded.
 */
const resumeFields = ["serviceTier", "cwd", "runtimeWorkspaceRoots", "config", "baseInstructions", "developerInstructions",
  "personality"] as const;
/**
 * The `config` keys that act as those fields: the SDK lets any of them stand in for a value it would otherwise restore,
 * so a replayed `config` must not carry them.
 */
const gatedConfigKeys = new Set(["model", "model_provider", "model_reasoning_effort", "approval_policy", "approvals_reviewer", "sandbox_mode", "default_permissions"]);
/** How many chats' load parameters one connection keeps; the oldest leave first. An evicted chat re-attaches with its saved settings alone. */
const maxChats = 512;

/**
 * How this connection loaded each gateway chat, so it can load it again on a new executor. The provider id the chat is
 * saved with (docs/harness-identity.md) never passes through here: the resume omits it and the SDK restores it from the
 * chat's own record, so a re-attach can never rewrite it.
 */
export class ChatLoads {
  private readonly chats = new Map<string, Message>();
  remember(threadId: string, params: Message): void {
    const kept: Message = {};
    for (const field of resumeFields) if (params[field] !== undefined && params[field] !== null) kept[field] = params[field];
    if (kept.config && typeof kept.config === "object" && !Array.isArray(kept.config)) {
      const config: Message = {};
      for (const [key, value] of Object.entries(kept.config as Message)) if (!gatedConfigKeys.has(key)) config[key] = value;
      if (Object.keys(config).length) kept.config = config; else delete kept.config;
    }
    this.chats.delete(threadId); this.chats.set(threadId, kept);
    while (this.chats.size > maxChats) this.chats.delete(this.chats.keys().next().value as string);
  }
  forget(threadId: string): void { this.chats.delete(threadId); }
  /** The resume that loads the chat again. A chat this connection never loaded (a sub-agent, or one evicted) resumes with its saved settings. */
  resumeParams(threadId: string): Message {
    return { ...this.chats.get(threadId), threadId, excludeTurns: true };
  }
}

/** A failed re-attach step, carrying its fixed reason; the cause stays out of telemetry. */
export class ReattachError extends Error {
  constructor(readonly reason: ReattachFailure) { super("Gateway executor re-attach failed"); }
}

/** How long one failed host lookup keeps later attempts from waiting on the host again. */
const defaultHostDownWindowMs = 5_000;
let hostDownWindowMs = defaultHostDownWindowMs;
/** Tests shorten the fail-fast window instead of sitting it out. Undefined restores the production value. */
export function setHostDownWindowForTests(ms?: number): void { hostDownWindowMs = ms ?? defaultHostDownWindowMs; }

/**
 * One re-attach per chat at a time: every request that finds the chat's executor gone while one is running waits for it and
 * gets its outcome, so the chat is resumed once. `join` checks for a running flight synchronously, before anything is awaited.
 * While a failed host lookup is recent, later attempts fail at once instead of kicking the host and waiting through it again;
 * the window is cleared by a re-attach that got a host. `executor_reattached` and `executor_reattach_failed` record the
 * reason, how long it took and how many requests shared it; never a chat id, a model or a path. A `host_unavailable`
 * failure records at most one event per window, so a host that stays down cannot spam them.
 */
export class Reattacher {
  private readonly flights = new Map<string, { done: Promise<void>; requests: number }>();
  private hostDownUntil = 0;
  join(threadId: string, reason: ReattachReason, attempt: () => Promise<void>): Promise<void> {
    const running = this.flights.get(threadId);
    if (running) { running.requests++; return running.done; }
    if (Date.now() < this.hostDownUntil) return Promise.reject(new ReattachError("host_unavailable"));
    const startedAt = Date.now();
    const flight = { requests: 1, done: Promise.resolve() };
    flight.done = attempt().then(() => {
      this.hostDownUntil = 0; // The host answered; a later attempt may wait on it again.
      telemetry("executor_reattached", { reason, ms: Date.now() - startedAt, requests: flight.requests });
    }, (error: unknown) => {
      const failure = error instanceof ReattachError ? error.reason : "resume_failed";
      const insideWindow = Date.now() < this.hostDownUntil;
      if (failure === "host_unavailable") this.hostDownUntil = Date.now() + hostDownWindowMs;
      if (failure !== "host_unavailable" || !insideWindow) telemetry("executor_reattach_failed", { reason: failure, requests: flight.requests });
      throw error;
    }).finally(() => { this.flights.delete(threadId); });
    this.flights.set(threadId, flight);
    return flight.done;
  }
}
