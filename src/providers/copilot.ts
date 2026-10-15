import { randomUUID } from "node:crypto";
import { copilotSessionSettings, type ProviderConfig } from "../config.js";
import { responsesToChatRequest } from "../protocol/request.js";
import type { ChatToolSelection, ResponsesRequest, InferenceEvent, OpenAITool } from "../protocol/types.js";
import { openCopilot } from "./copilot-client.js";
import { record } from "./copilot-rpc.js";
import { ProviderError, type InferenceContext, type Provider } from "./provider.js";
import { imageConversation } from "../protocol/images.js";
import { CopilotTurn } from "./copilot-turn.js";
import { sessionLimits } from "./copilot-live-session.js";
import { sessionFingerprint, sessionParams } from "./copilot-create.js";
import { choiceLine, copilotPrompts, copilotSystem, nativeCatalog, type NativeTool } from "./copilot-render.js";
import { copilotLive, retireCopilotScope, retireCopilotScopes, type CopilotLiveInput, type CopilotLiveOutcome } from "./copilot-live.js";
import { sessionKey } from "./claude-live-contract.js";
import { leadingInstructions, markCustomCalls, type ClaudeConversation, type ClaudeImages } from "./claude-render.js";
import { telemetry } from "../telemetry.js";
import { reportException } from "../error-report.js";

export { nativeCopilotCalls } from "./copilot-turn.js";

/**
 * Protocol 3 supports Auto routing profiles, but no selected-model service tier. Flex is not refused: a native Codex chat that
 * moved to this row keeps asking for it, and the turn runs as Standard.
 */
export function validateCopilotServiceTier(request: ResponsesRequest): void {
  const tier = request.service_tier;
  if (tier === undefined || tier === null || tier === "auto" || tier === "default" || tier === "flex") return;
  if (tier === "priority" || tier === "fast") throw new ProviderError("invalid_request", "Copilot Fast mode is unavailable: its CLI does not support a priority tier for the selected model", 400);
  throw new ProviderError("invalid_request", "Copilot does not support the requested service tier", 400);
}

export function copilotEffort(config: ProviderConfig, request: ResponsesRequest): string | undefined {
  const effort = record(request.reasoning).effort;
  const alias = Object.entries(config.models).find(([, model]) => model === request.model)?.[0];
  const supported = alias ? config.modelMetadata?.[alias]?.reasoningEfforts : undefined;
  if (effort !== undefined && (typeof effort !== "string" || !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort) || (supported && !supported.includes(effort)))) throw new ProviderError("invalid_request", "Selected Copilot model does not support this reasoning effort", 400);
  return effort as string | undefined;
}

// Codex owns these requests' history shape, so they never join or seed a live session.
const oneShotKinds = new Set<unknown>(["compaction", "prewarm", "memory"]);
const cancelled = () => new ProviderError("cancelled", "Request cancelled", 499);

/** One request, translated and rendered once for whichever path serves it. */
export interface CopilotRun {
  request: ResponsesRequest; signal: AbortSignal; context: InferenceContext;
  /** The whole caller catalog, whatever the tool choice: a changed catalog would change the prompt and break the cache. */
  tools: OpenAITool[]; native: NativeTool[]; choice: ChatToolSelection | undefined;
  effort?: string; summary: unknown;
  /** Translated messages after the leading instructions, with images replaced by labels. */
  conversation: ClaudeConversation; images: ClaudeImages; leading: number;
  /** `session.create` parameters: the caller's leading instructions are the system message. */
  create: Record<string, unknown>;
}

/** Validates and translates one request for the one-shot and live paths. */
export function copilotRun(config: ProviderConfig, request: ResponsesRequest, signal: AbortSignal, context: InferenceContext = {}): CopilotRun {
  validateCopilotServiceTier(request);
  const normalized = responsesToChatRequest(request); const choice = normalized.tool_choice;
  const tools = normalized.tools || []; const native = nativeCatalog(tools);
  const effort = copilotEffort(config, request);
  const summary = record(request.reasoning).summary;
  const history = markCustomCalls(normalized.messages, tools);
  const leading = leadingInstructions(history);
  const { conversation, images } = imageConversation(history.slice(leading));
  const create = sessionParams({ model: request.model, effort, summary, catalog: native, system: copilotSystem(history.slice(0, leading).map(message => message.content ?? ""), native) });
  return { request, signal, context, tools, native, choice, effort, summary, conversation, images, leading, create };
}

/** The provider half of a live session key; the thread's half is whatever the caller added. */
const copilotScope = (config: ProviderConfig): string => `${config.id}\0${config.authDirectory ?? ""}`;

/**
 * After a configuration reload: closes the live sessions of every provider scope the new configuration no longer serves live.
 * A removed provider, or one whose id or auth directory changed, never receives a request that could retire its sessions
 * (`provider_removed`); a provider switched to one-shot keeps its scope, and its parked sessions go now (`mode_oneshot`)
 * instead of at its next request.
 */
export function retireUnconfiguredCopilotScopes(providers: ProviderConfig[]): void {
  const copilot = providers.filter(provider => provider.type === "copilot-subscription");
  const live = new Set(copilot.filter(provider => copilotSessionSettings(provider).mode === "live").map(copilotScope));
  const configured = new Set(copilot.map(copilotScope));
  retireCopilotScopes(scope => live.has(scope) ? undefined : configured.has(scope) ? "mode_oneshot" : "provider_removed");
}

/** What a live session needs to place a request of a thread (`threadId` is required). */
export function copilotLiveInput(config: ProviderConfig, run: CopilotRun, threadId: string): CopilotLiveInput {
  const { request, context, tools, native, choice, effort, summary, conversation, images, leading, create } = run;
  return { scope: copilotScope(config), threadId, windowId: context.windowId, model: request.model, effort, fingerprint: sessionFingerprint(create), create,
    config, catalog: tools, native, request, conversation, images, leading, choice,
    newTurn: () => new CopilotTurn({ model: request.model, offered: Object.values(config.models), tools, choice, summary }) };
}

export class CopilotSubscription implements Provider {
  constructor(private readonly config: ProviderConfig) {}

  async *infer(request: ResponsesRequest, signal: AbortSignal, context: InferenceContext = {}): AsyncGenerator<InferenceEvent> {
    const run = copilotRun(this.config, request, signal, context);
    const settings = copilotSessionSettings(this.config);
    if (settings.mode !== "live") retireCopilotScope(copilotScope(this.config), "mode_oneshot");
    else {
      const threadKey = context.threadId ? sessionKey(copilotScope(this.config), context.threadId).slice(0, 8) : undefined;
      let outcome: CopilotLiveOutcome;
      try { outcome = await this.live(run, settings); }
      catch (error) {
        // Placing the request failed unexpectedly, before any session work: the one-shot path still serves it.
        if (signal.aborted || (error instanceof ProviderError && error.code === "cancelled")) throw cancelled();
        if (!(error instanceof ProviderError)) reportException(error, "copilot_live_attach");
        outcome = { kind: "fallback", reason: "attach_failed" };
      }
      if (outcome.kind === "stream") {
        let yielded = false;
        try { for await (const event of outcome.events) { yielded = true; yield event; } return; }
        catch (error) {
          // A session that dies before its first event falls back to one-shot. Limits, cancellation and caller errors would only repeat.
          if (signal.aborted) throw cancelled();
          if (yielded || !(error instanceof ProviderError) || error.code !== "cli_failed") throw error;
          telemetry("copilot_session", { outcome: "fallback", missReason: error.upstream?.code === "delivery_rejected" ? "delivery_rejected" : "stream_failed", threadKey });
        }
      } else telemetry("copilot_session", { outcome: "fallback", missReason: outcome.reason, threadKey });
    }
    yield* this.oneShot(run);
  }

  /** Serves the request from the thread's live session, or says why it cannot. */
  private async live(run: CopilotRun, settings: ReturnType<typeof copilotSessionSettings>): Promise<CopilotLiveOutcome> {
    const skip = (reason: "no_thread" | "request_kind") => ({ kind: "fallback" as const, reason });
    if (!run.context.threadId) return skip("no_thread");
    if (oneShotKinds.has(run.context.requestKind)) return skip("request_kind");
    return copilotLive(settings).attach(copilotLiveInput(this.config, run, run.context.threadId), run.signal);
  }

  /** One session for one request, with the same system message, tools and per-item messages a live session is seeded with. */
  private async *oneShot(run: CopilotRun): AsyncGenerator<InferenceEvent> {
    const { request, signal, tools, native, choice, summary, conversation, images, create } = run;
    const client = await openCopilot(this.config, signal); const sessionId = randomUUID();
    // From here the request ends the CLI, not the client's startup guard: that guard stops it with SIGTERM, which a CLI that may
    // hold a pending tool request must never get.
    client.release();
    const turn = new CopilotTurn({ model: request.model, offered: Object.values(this.config.models), tools, choice, summary });
    const notifications = client.rpc.notifications();
    // Whether the turn ended idle: the answer is complete and the CLI holds no external tool request. Only then may the CLI be
    // asked to exit (`session.delete`, SIGTERM). Any other end - a tool call, a tool request the gateway rejects, a failure, a
    // cancellation, a consumer that stops reading - leaves a CLI that may hold a request unanswered, and closing it must not let
    // the runtime fail the call and make a model call of its own.
    let idle = false;
    /** The session's next event, or undefined once the CLI's stream has ended. */
    const next = async (): Promise<Record<string, unknown> | undefined> => {
      for (;;) {
        const { value, done } = await notifications.next(); if (done) return undefined;
        const params = record(value.params); if (params.sessionId !== sessionId) continue;
        return record(params.event);
      }
    };
    let ending: Promise<void> | undefined;
    // The messages being rendered (images are written into the CLI's folder). Settled, never rejected, so that waiting for it is safe.
    let rendering: Promise<void> = Promise.resolve();
    // It never rejects: the folder's removal is the client's to retry (copilot-client.ts), and a teardown nobody awaits must not
    // end the process with an unhandled rejection.
    const end = (): Promise<void> => ending ??= (async () => {
      if (idle) { await notifications.return(undefined); await rendering; await client.close(sessionId); return; }
      // Like a live session that ends: abort (bounded), then SIGKILL of the process group, never session.delete and SIGTERM.
      // The event stream stays open until then: a closed one makes the connection treat the CLI's next event as an overflow and stop it.
      // A rendering still in progress stops at its next image (the request is cancelled); its last write ends before the folder goes.
      await client.rpc.request("session.abort", { sessionId }, sessionLimits.abortMs).catch(() => {}); await rendering; await client.close(undefined, true);
      await notifications.return(undefined);
    })().catch(() => {});
    // A cancellation ends the CLI at once, the same way, while the request goes on reading what the CLI still reports (its usage).
    const onAbort = () => { void end(); };
    signal.addEventListener("abort", onAbort, { once: true });
    // The connection stays open while the CLI is ending (up to `abortMs`), so a request sent then would still be served: and
    // `session.sendMessages` is a billed model call. Once the request is cancelled or ending, nothing but the abort goes out.
    const ask = (method: string, params: Record<string, unknown>, timeout?: number): Promise<Record<string, unknown>> =>
      signal.aborted || ending ? Promise.reject(cancelled()) : client.rpc.request(method, params, timeout);
    try {
      // The abort may have come between the CLI's start and the listener above.
      if (signal.aborted) throw cancelled();
      await ask("session.create", { sessionId, ...create, workingDirectory: client.directory, configDir: client.directory });
      // Rendering the messages can take a while (images are written to files), and the abort can come during it.
      const render = copilotPrompts(conversation, images, 0, choiceLine(choice, native), client.directory, () => signal.aborted || ending !== undefined);
      rendering = render.then(() => {}, () => {});
      const messages = await render;
      await ask("session.sendMessages", { sessionId, messages }, 30000);
      for (let event = await next(); event; event = await next()) {
        // A cancelled request yields nothing more, except the usage its CLI reported.
        if (signal.aborted) { yield* usageAfterAbort(turn, event, next); throw cancelled(); }
        const step = turn.accept(event);
        yield* step.events;
        if (step.end) { idle = step.end === "idle" && turn.calls.length === 0; yield turn.done(); return; }
      }
      throw new ProviderError("incomplete", "Copilot stream ended without completion");
    } catch (error) { if (signal.aborted) throw cancelled(); throw error; }
    finally { signal.removeEventListener("abort", onAbort); await end(); }
  }
}

/**
 * After a cancellation, which is ending the one-shot CLI (session.abort, then SIGKILL): each usage it reports (already read, or
 * arriving until its stream ends) is added to the request's totals and handed over at once as the running total, which replaces
 * the one before it. A slow abort keeps the CLI's stream open for seconds; the usage must not wait for its end, or a shutdown
 * that leaves before then would miss it. Nothing else is handed over.
 */
async function* usageAfterAbort(turn: CopilotTurn, first: Record<string, unknown>, next: () => Promise<Record<string, unknown> | undefined>): AsyncGenerator<InferenceEvent> {
  const take = (event: Record<string, unknown>): InferenceEvent | undefined => {
    if (event.type !== "assistant.usage") return undefined;
    try { return turn.accept(event).events.at(-1); } catch { return undefined; /* The request is cancelled anyway; valid usage is still counted. */ }
  };
  let total = take(first); if (total) yield total;
  try { for (let event = await next(); event; event = await next()) { total = take(event); if (total) yield total; } } catch { /* The stopped CLI's connection ended. */ }
}
