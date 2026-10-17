import type { Message } from "./app-server-connection.js";
import { telemetry } from "./telemetry.js";

/**
 * Why a chat's gateway executor connection was gone: `engine_closed` when its host went away or a private executor exited,
 * `generation_retired` when the host is still connected but no longer serves that connection.
 */
export type ReattachReason = "engine_closed" | "generation_retired";
/** Why a re-attach failed: no host or generation could be acquired, or the executor refused to resume the chat. */
export type ReattachFailure = "host_unavailable" | "resume_failed";

/** The `thread/resume` fields that describe how a chat was loaded; nothing about a turn or its content. */
const resumeFields = ["model", "modelProvider", "serviceTier", "cwd", "runtimeWorkspaceRoots", "approvalPolicy", "approvalsReviewer", "sandbox",
  "permissions", "config", "baseInstructions", "developerInstructions", "personality"] as const;
/** How many chats' load parameters one connection keeps; the oldest leave first. */
const maxChats = 4096;

/**
 * How this connection loaded each gateway chat, so it can load it again on a new executor. The model and provider are the
 * ones the executor answered with: the provider is the id the chat is saved with (docs/harness-identity.md), so the
 * re-attach never rewrites it. A later model choice that the executor applied replaces the model.
 */
export class ChatLoads {
  private readonly chats = new Map<string, Message>();
  remember(threadId: string, params: Message, result: Message): void {
    const kept: Message = {};
    for (const field of resumeFields) if (params[field] !== undefined && params[field] !== null) kept[field] = params[field];
    if (typeof result.model === "string") kept.model = result.model;
    if (typeof result.modelProvider === "string") kept.modelProvider = result.modelProvider;
    this.chats.delete(threadId); this.chats.set(threadId, kept);
    while (this.chats.size > maxChats) this.chats.delete(this.chats.keys().next().value as string);
  }
  model(threadId: string, model: unknown): void {
    const kept = this.chats.get(threadId);
    if (kept && typeof model === "string" && model) kept.model = model;
  }
  forget(threadId: string): void { this.chats.delete(threadId); }
  /** The resume that loads the chat again. A chat this connection never loaded (a sub-agent) resumes with its saved settings. */
  resumeParams(threadId: string): Message {
    return { ...this.chats.get(threadId), threadId, excludeTurns: true };
  }
}

/** A failed re-attach step, carrying its fixed reason; the cause stays out of telemetry. */
export class ReattachError extends Error {
  constructor(readonly reason: ReattachFailure) { super("Gateway executor re-attach failed"); }
}

/**
 * One re-attach per chat at a time: every request that finds the chat's executor gone while one is running waits for it and
 * gets its outcome, so the chat is resumed once. `executor_reattached` and `executor_reattach_failed` record the reason, how
 * long it took and how many requests shared it; never a chat id, a model or a path.
 */
export class Reattacher {
  private readonly flights = new Map<string, { done: Promise<void>; requests: number }>();
  join(threadId: string, reason: ReattachReason, attempt: () => Promise<void>): Promise<void> {
    const running = this.flights.get(threadId);
    if (running) { running.requests++; return running.done; }
    const startedAt = Date.now();
    const flight = { requests: 1, done: Promise.resolve() };
    flight.done = attempt().then(() => {
      telemetry("executor_reattached", { reason, ms: Date.now() - startedAt, requests: flight.requests });
    }, (error: unknown) => {
      telemetry("executor_reattach_failed", { reason: error instanceof ReattachError ? error.reason : "resume_failed", requests: flight.requests });
      throw error;
    }).finally(() => { this.flights.delete(threadId); });
    this.flights.set(threadId, flight);
    return flight.done;
  }
}
