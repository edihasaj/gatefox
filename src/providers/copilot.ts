import { randomUUID } from "node:crypto";
import { copilotSessionSettings, type ProviderConfig } from "../config.js";
import { responsesToChatRequest } from "../protocol/request.js";
import type { ChatToolSelection, ResponsesRequest, InferenceEvent, OpenAITool } from "../protocol/types.js";
import { openCopilot } from "./copilot-client.js";
import { record } from "./copilot-rpc.js";
import { ProviderError, type InferenceContext, type Provider } from "./provider.js";
import { imageConversation } from "../protocol/images.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CopilotTurn } from "./copilot-turn.js";
import { liveSystem, oneShotSystem, sessionFingerprint, sessionParams } from "./copilot-create.js";
import { copilotLive, retireCopilotScope, type CopilotMissReason } from "./copilot-live.js";
import { sessionKey } from "./claude-live-contract.js";
import { leadingInstructions, markCustomCalls } from "./claude-render.js";
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
const forced = (choice: ChatToolSelection | undefined) => choice === "required" || typeof choice === "object";

export class CopilotSubscription implements Provider {
  constructor(private readonly config: ProviderConfig) {}

  /** The provider half of a live session key; the thread's half is whatever the caller added. */
  private scope(): string { return `${this.config.id}\0${this.config.authDirectory ?? ""}`; }

  async *infer(request: ResponsesRequest, signal: AbortSignal, context: InferenceContext = {}): AsyncGenerator<InferenceEvent> {
    validateCopilotServiceTier(request);
    const normalized = responsesToChatRequest(request); const choice = normalized.tool_choice;
    const tools = choice === "none" ? [] : (normalized.tools || []).filter(tool => typeof choice !== "object" || tool.function.name === choice.function.name);
    const effort = copilotEffort(this.config, request);
    const summary = record(request.reasoning).summary;
    const settings = copilotSessionSettings(this.config);
    if (settings.mode !== "live") retireCopilotScope(this.scope(), "mode_oneshot");
    else {
      const attempt = this.live({ request, signal, context, normalized, tools, choice, effort, summary, settings });
      let yielded = false;
      try {
        const outcome = await attempt;
        if (outcome.kind === "stream") {
          try { for await (const event of outcome.events) { yielded = true; yield event; } return; }
          catch (error) {
            // A session that dies before its first event falls back to one-shot. Limits, cancellation and caller errors would only repeat.
            if (signal.aborted) throw new ProviderError("cancelled", "Request cancelled", 499);
            if (yielded || !(error instanceof ProviderError) || error.code !== "cli_failed") throw error;
            telemetry("copilot_session", { outcome: "fallback", missReason: "stream_failed", threadKey: context.threadId ? sessionKey(this.scope(), context.threadId).slice(0, 8) : undefined });
          }
        } else telemetry("copilot_session", { outcome: "fallback", missReason: outcome.reason, threadKey: context.threadId ? sessionKey(this.scope(), context.threadId).slice(0, 8) : undefined });
      } catch (error) { if (signal.aborted) throw new ProviderError("cancelled", "Request cancelled", 499); throw error; }
    }
    yield* this.oneShot(request, signal, normalized.messages, tools, choice, effort, summary);
  }

  /** Serves the request from the thread's live session, or says why it cannot. */
  private async live(run: { request: ResponsesRequest; signal: AbortSignal; context: InferenceContext; normalized: ReturnType<typeof responsesToChatRequest>; tools: OpenAITool[]; choice: ChatToolSelection | undefined; effort?: string; summary: unknown; settings: ReturnType<typeof copilotSessionSettings> }) {
    const { request, signal, context, normalized, tools, choice, effort, summary, settings } = run;
    const live = copilotLive(settings); const skip = (reason: CopilotMissReason) => ({ kind: "fallback" as const, reason });
    if (!context.threadId) return skip("no_thread");
    if (oneShotKinds.has(context.requestKind)) return skip("request_kind");
    // A forced choice names itself in a user message, and tool outputs travel as tool results: neither fits a live session.
    // `none` would give the session a catalog of zero tools and break its identity for the next request.
    if (forced(choice) || choice === "none") { await live.release(this.scope(), context.threadId, "forced_choice"); return skip("forced_choice"); }
    const history = markCustomCalls(normalized.messages, normalized.tools || []);
    const leading = leadingInstructions(history);
    const { conversation, images } = imageConversation(history.slice(leading));
    // Images travel as attachments in one-shot requests; a live session sends text only.
    if (images.length || history.slice(0, leading).some(message => message.parts)) return skip("images");
    const create = sessionParams({ model: request.model, effort, summary, tools, system: liveSystem(history.slice(0, leading).map(message => message.content ?? ""), tools), live: true });
    return live.attach({ scope: this.scope(), threadId: context.threadId, windowId: context.windowId, model: request.model, effort, fingerprint: sessionFingerprint(create), create,
      config: this.config, catalog: normalized.tools || [], toolCount: tools.length, request, conversation, leading,
      newTurn: () => new CopilotTurn({ model: request.model, offered: Object.values(this.config.models), tools, choice, summary }) }, signal);
  }

  private async *oneShot(request: ResponsesRequest, signal: AbortSignal, messages: ReturnType<typeof responsesToChatRequest>["messages"], tools: OpenAITool[], choice: ChatToolSelection | undefined, effort: string | undefined, summary: unknown): AsyncGenerator<InferenceEvent> {
    const { conversation, images } = imageConversation(messages);
    const client = await openCopilot(this.config, signal); const sessionId = randomUUID();
    const turn = new CopilotTurn({ model: request.model, offered: Object.values(this.config.models), tools, choice, summary });
    try {
      await client.rpc.request("session.create", { sessionId, ...sessionParams({ model: request.model, effort, summary, tools, system: oneShotSystem, live: false }), workingDirectory: client.directory, configDir: client.directory });
      const aliases = tools.map((tool, index) => ({ caller: tool.function.name, native: `gateway_tool_${index}` }));
      const attachments = await Promise.all(images.map(async ({ label, image }) => {
        const extension = image.mediaType === "image/jpeg" ? "jpg" : image.mediaType.split("/")[1];
        const path = join(client.directory, `${label}.${extension}`);
        await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
        return { type: "file", path, displayName: label };
      }));
      await client.rpc.request("session.send", { sessionId, ...(attachments.length ? { attachments } : {}), prompt: `Tool names: ${JSON.stringify(aliases)}\n${forced(choice) ? "Use the required caller tool.\n" : ""}Conversation: ${JSON.stringify(conversation)}` });
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
