import { randomUUID } from "node:crypto";
import { copilotSessionSettings, type ProviderConfig } from "../config.js";
import { responsesToChatRequest } from "../protocol/request.js";
import type { ChatToolSelection, ResponsesRequest, InferenceEvent, OpenAITool } from "../protocol/types.js";
import { openCopilot } from "./copilot-client.js";
import { record } from "./copilot-rpc.js";
import { ProviderError, type InferenceContext, type Provider } from "./provider.js";
import { imageConversation } from "../protocol/images.js";
import { CopilotTurn } from "./copilot-turn.js";
import { sessionFingerprint, sessionParams } from "./copilot-create.js";
import { choiceLine, copilotPrompts, copilotSystem, nativeCatalog, type NativeTool } from "./copilot-render.js";
import { copilotLive, retireCopilotScope } from "./copilot-live.js";
import { sessionKey } from "./claude-live-contract.js";
import { leadingInstructions, markCustomCalls, type ClaudeConversation, type ClaudeImages } from "./claude-render.js";
import { telemetry } from "../telemetry.js";

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

/** One request, translated and rendered once for whichever path serves it. */
interface Run {
  request: ResponsesRequest; signal: AbortSignal; context: InferenceContext;
  /** The whole caller catalog, whatever the tool choice: a changed catalog would change the prompt and break the cache. */
  tools: OpenAITool[]; native: NativeTool[]; choice: ChatToolSelection | undefined;
  effort?: string; summary: unknown;
  /** Translated messages after the leading instructions, with images replaced by labels. */
  conversation: ClaudeConversation; images: ClaudeImages; leading: number;
  /** `session.create` parameters: the caller's leading instructions are the system message. */
  create: Record<string, unknown>;
}

export class CopilotSubscription implements Provider {
  constructor(private readonly config: ProviderConfig) {}

  /** The provider half of a live session key; the thread's half is whatever the caller added. */
  private scope(): string { return `${this.config.id}\0${this.config.authDirectory ?? ""}`; }

  async *infer(request: ResponsesRequest, signal: AbortSignal, context: InferenceContext = {}): AsyncGenerator<InferenceEvent> {
    validateCopilotServiceTier(request);
    const normalized = responsesToChatRequest(request); const choice = normalized.tool_choice;
    const tools = normalized.tools || []; const native = nativeCatalog(tools);
    const effort = copilotEffort(this.config, request);
    const summary = record(request.reasoning).summary;
    const settings = copilotSessionSettings(this.config);
    const history = markCustomCalls(normalized.messages, tools);
    const leading = leadingInstructions(history);
    const { conversation, images } = imageConversation(history.slice(leading));
    const create = sessionParams({ model: request.model, effort, summary, catalog: native, system: copilotSystem(history.slice(0, leading).map(message => message.content ?? ""), native) });
    const run: Run = { request, signal, context, tools, native, choice, effort, summary, conversation, images, leading, create };
    if (settings.mode !== "live") retireCopilotScope(this.scope(), "mode_oneshot");
    else {
      const threadKey = context.threadId ? sessionKey(this.scope(), context.threadId).slice(0, 8) : undefined;
      let yielded = false;
      try {
        const outcome = await this.live(run, settings);
        if (outcome.kind === "stream") {
          try { for await (const event of outcome.events) { yielded = true; yield event; } return; }
          catch (error) {
            // A session that dies before its first event falls back to one-shot. Limits, cancellation and caller errors would only repeat.
            if (signal.aborted) throw new ProviderError("cancelled", "Request cancelled", 499);
            if (yielded || !(error instanceof ProviderError) || error.code !== "cli_failed") throw error;
            telemetry("copilot_session", { outcome: "fallback", missReason: error.upstream?.code === "delivery_rejected" ? "delivery_rejected" : "stream_failed", threadKey });
          }
        } else telemetry("copilot_session", { outcome: "fallback", missReason: outcome.reason, threadKey });
      } catch (error) { if (signal.aborted) throw new ProviderError("cancelled", "Request cancelled", 499); throw error; }
    }
    yield* this.oneShot(run);
  }

  /** Serves the request from the thread's live session, or says why it cannot. */
  private async live(run: Run, settings: ReturnType<typeof copilotSessionSettings>) {
    const { request, signal, context, tools, native, choice, effort, summary, conversation, images, leading, create } = run;
    const skip = (reason: "no_thread" | "request_kind") => ({ kind: "fallback" as const, reason });
    if (!context.threadId) return skip("no_thread");
    if (oneShotKinds.has(context.requestKind)) return skip("request_kind");
    return copilotLive(settings).attach({ scope: this.scope(), threadId: context.threadId, windowId: context.windowId, model: request.model, effort, fingerprint: sessionFingerprint(create), create,
      config: this.config, catalog: tools, native, request, conversation, images, leading, choice,
      newTurn: () => new CopilotTurn({ model: request.model, offered: Object.values(this.config.models), tools, choice, summary }) }, signal);
  }

  /** One session for one request, with the same system message, tools and per-item messages a live session is seeded with. */
  private async *oneShot(run: Run): AsyncGenerator<InferenceEvent> {
    const { request, signal, tools, native, choice, summary, conversation, images, create } = run;
    const client = await openCopilot(this.config, signal); const sessionId = randomUUID();
    const turn = new CopilotTurn({ model: request.model, offered: Object.values(this.config.models), tools, choice, summary });
    try {
      await client.rpc.request("session.create", { sessionId, ...create, workingDirectory: client.directory, configDir: client.directory });
      await client.rpc.request("session.sendMessages", { sessionId, messages: copilotPrompts(conversation, images, 0, choiceLine(choice, native)) }, 30000);
      for await (const message of client.rpc.notifications()) {
        const params = record(message.params); if (params.sessionId !== sessionId) continue;
        const step = turn.accept(record(params.event));
        yield* step.events;
        if (step.end) { yield turn.done(); return; }
      }
      throw new ProviderError("incomplete", "Copilot stream ended without completion");
    } catch (error) { if (signal.aborted) throw new ProviderError("cancelled", "Request cancelled", 499); throw error; }
    finally { await client.close(sessionId); }
  }
}
