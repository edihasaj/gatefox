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
import { copilotLive, retireCopilotScope, type CopilotLiveInput, type CopilotLiveOutcome } from "./copilot-live.js";
import { sessionKey } from "./claude-live-contract.js";
import { leadingInstructions, markCustomCalls, type ClaudeConversation, type ClaudeImages } from "./claude-render.js";
import { telemetry } from "../telemetry.js";
import { reportException } from "../error-report.js";

export { nativeCopilotCalls } from "./copilot-turn.js";

/** Protocol 3 supports Auto routing profiles, but no selected-model service tier. */
export function validateCopilotServiceTier(request: ResponsesRequest): void {
  const tier = request.service_tier;
  if (tier === undefined || tier === null || tier === "auto" || tier === "default") return;
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
    const turn = new CopilotTurn({ model: request.model, offered: Object.values(this.config.models), tools, choice, summary });
    const notifications = client.rpc.notifications();
    // Whether the session may still be working: a tool call was made or requested, and the CLI holds its external tool request
    // unanswered. Closing such a session must not let the runtime fail the call and make a model call of its own.
    let working = false;
    /** The session's next event, or undefined once the CLI's stream has ended. */
    const next = async (): Promise<Record<string, unknown> | undefined> => {
      for (;;) {
        const { value, done } = await notifications.next(); if (done) return undefined;
        const params = record(value.params); if (params.sessionId !== sessionId) continue;
        const event = record(params.event);
        if (event.type === "tool.execution_start" || event.type === "external_tool.requested") working = true;
        return event;
      }
    };
    try {
      await client.rpc.request("session.create", { sessionId, ...create, workingDirectory: client.directory, configDir: client.directory });
      await client.rpc.request("session.sendMessages", { sessionId, messages: await copilotPrompts(conversation, images, 0, choiceLine(choice, native), client.directory) }, 30000);
      for (let event = await next(); event; event = await next()) {
        // A cancelled request yields nothing more, except the usage its CLI reported.
        if (signal.aborted) { yield* usageAfterAbort(turn, event, next); throw cancelled(); }
        const step = turn.accept(event);
        yield* step.events;
        if (step.end) { working ||= step.end === "tools"; yield turn.done(); return; }
      }
      throw new ProviderError("incomplete", "Copilot stream ended without completion");
    } catch (error) { if (signal.aborted) throw cancelled(); throw error; }
    finally {
      if (working) {
        // Like a live session that ends: abort (bounded), then SIGKILL of the process group, never session.delete and SIGTERM.
        // The event stream stays open until then: a closed one makes the connection treat the CLI's next event as an overflow and stop it.
        await client.rpc.request("session.abort", { sessionId }, sessionLimits.abortMs).catch(() => {}); await client.close(undefined, true);
        await notifications.return(undefined);
      } else { await notifications.return(undefined); await client.close(sessionId); }
    }
  }
}

/**
 * After a cancellation, which already stopped the one-shot CLI: the usage it reported (read, or still arriving before it
 * exits) is added to the request's totals and handed over as one running total. Nothing else is.
 */
async function* usageAfterAbort(turn: CopilotTurn, first: Record<string, unknown>, next: () => Promise<Record<string, unknown> | undefined>): AsyncGenerator<InferenceEvent> {
  let last: InferenceEvent | undefined;
  const take = (event: Record<string, unknown>) => {
    if (event.type !== "assistant.usage") return;
    try { last = turn.accept(event).events.at(-1) ?? last; } catch { /* The request is cancelled anyway; valid usage is still counted. */ }
  };
  take(first);
  try { for (let event = await next(); event; event = await next()) take(event); } catch { /* The stopped CLI's connection ended. */ }
  if (last) yield last;
}
