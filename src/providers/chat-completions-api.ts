import { apiCredential, type ProviderConfig } from "../config.js";
import { responsesToChatRequest } from "../protocol/request.js";
import { readEvents } from "../protocol/sse.js";
import type { ResponsesRequest, InferenceEvent, Usage, OpenAIChatMessage } from "../protocol/types.js";
import { ProviderError, providerConversationId, type InferenceContext, type Provider } from "./provider.js";
import { apiRoutingHeaders } from "./api-routing.js";
import { generationOptions } from "./generation-options.js";
import { tailnetFetch, type TailnetSeams } from "../tailnet.js";
import { responsesHttpError, responsesStreamError } from "./responses-errors.js";
import { historicalCallText, historicalResultText, toollessChoice, undeclaredCalls } from "./historical-tools.js";
import { boundedJson, chatContextFailure } from "./context-errors.js";
import { chatRejection } from "./chat-rejections.js";
import { imagesOf, imageUrlPart, toolImagesMessage, userContent, type ChatContentPart } from "./chat-images.js";
import { telemetry } from "../telemetry.js";
import { isDeepSeekApi, ReasoningReplay } from "./deepseek-reasoning.js";
import { largeUncachedUsage } from "../cache-guarded-inference.js";
import { canonicalTools } from "./tool-catalog.js";
import { connectChatProvider } from "./chat-connect.js";

const recoveryDeadlineMs = 90_000;
const recoveryEofMs = 5_000;
const chatEnvelopeFields = new Set(["type", "id", "object", "created", "model", "choices", "usage", "system_fingerprint", "service_tier", "prompt_token_ids", "prompt_text"]);
const chatChoiceFields = new Set(["index", "delta", "finish_reason", "logprobs", "stop_reason", "token_ids"]);
const chatDeltaFields = new Set(["role", "content", "reasoning", "reasoning_content", "tool_calls"]);

export interface ChatCompletionRecoveryPolicy {
  /** Upstream model IDs, never public aliases. */
  readonly models: readonly string[];
  /** Bounds only the recovery request, including its body and error parsing. */
  readonly timeoutMs?: number;
  onRecovery?: (event: { outcome: "retry" | "recovered" | "exhausted"; model: string; attempt: 1 | 2; durationMs: number; usage: Usage }) => void;
}

type ReplayMessage = { role: OpenAIChatMessage["role"]; content: string | null | ChatContentPart[]; tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; reasoningSummary?: true };

function compactAssistantReplay(messages: ReturnType<typeof responsesToChatRequest>["messages"], nativeName: (name: string) => string, declared: (name: string) => boolean, vision = false) {
  // Calls to tools this request does not declare, and their results, stay in the history as text (historical-tools.ts).
  const absent = undeclaredCalls(messages, declared);
  const replay: ReplayMessage[] = [];
  // Images from a run of tool results follow it in one user message (chat-images.ts).
  let toolImages: ReturnType<typeof imagesOf> = [];
  const flushToolImages = () => { if (toolImages.length) replay.push(toolImagesMessage(toolImages)); toolImages = []; };
  for (const { parts, name: _name, tool_calls, role, ...message } of messages.filter(message => message.role !== "system" && message.role !== "developer")) {
    const images = vision ? imagesOf(parts) : [];
    if (role === "tool" && message.tool_call_id !== undefined && absent.has(message.tool_call_id)) {
      flushToolImages();
      const { tool_call_id: _id, ...rest } = message;
      const text = historicalResultText(absent.get(message.tool_call_id)!, { content: message.content, parts });
      replay.push({ ...rest, role: "user", content: images.length ? [{ type: "text", text }, ...images.map(imageUrlPart)] : text });
      continue;
    }
    if (role === "tool") { replay.push({ ...message, role, content: message.content }); toolImages.push(...images); continue; }
    flushToolImages();
    if (role === "user" && images.length) { replay.push({ ...message, role, content: userContent(parts!) }); continue; }
    const kept = (tool_calls || []).filter(call => !absent.has(call.id));
    const notes = (tool_calls || []).filter(call => absent.has(call.id)).map(call => historicalCallText(call.function.name, call.function.arguments));
    const content = notes.length ? [message.content || "", ...notes].filter(Boolean).join("\n") : message.content;
    replay.push({ ...message, content, role,
      ...(kept.length ? { tool_calls: kept.map(({ id, function: fn }) => ({ id, type: "function" as const, function: { name: nativeName(fn.name), arguments: fn.arguments } })) } : {}),
    });
  }
  flushToolImages();
  const compacted: ReplayMessage[] = [];
  for (const message of replay) {
    const previous = compacted.at(-1);
    if (previous?.role !== "assistant" || message.role !== "assistant") { compacted.push(message); continue; }
    const before = typeof previous.content === "string" ? previous.content : "";
    const next = typeof message.content === "string" ? message.content : "";
    previous.content = before || next ? before + next : null;
    const calls = [...(previous.tool_calls || []), ...(message.tool_calls || [])];
    if (calls.length) previous.tool_calls = calls;
  }
  return compacted;
}

const zeroUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
function addUsage(left: Usage, right: Usage): Usage {
  const cached = (left.input_tokens_details?.cached_tokens || 0) + (right.input_tokens_details?.cached_tokens || 0);
  const created = (left.input_tokens_details?.cache_creation_tokens || 0) + (right.input_tokens_details?.cache_creation_tokens || 0);
  const cacheReported = (left.input_tokens === 0 || left.input_tokens_details !== undefined)
    && (right.input_tokens === 0 || right.input_tokens_details !== undefined)
    && (left.input_tokens_details !== undefined || right.input_tokens_details !== undefined);
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
    ...(cacheReported ? { input_tokens_details: { cached_tokens: cached, ...(created ? { cache_creation_tokens: created } : {}) } } : {}),
  };
}
function timeoutError(): ProviderError { return new ProviderError("timeout", "Chat API inference timed out", 504); }
/** A sampled completion the client cannot run. Retryable: the next attempt samples again; see `deterministicOutputCodes`. */
function malformedToolCall(message: string, code: "unknown_tool" | "invalid_tool_arguments"): ProviderError {
  return new ProviderError("malformed_tool_call", message, 502, { code, event: "chat.tool_call" });
}
function incomplete(message: string): ProviderError { return new ProviderError("incomplete", message, 502); }
function unknownFields(value: object, allowed: ReadonlySet<string>): boolean { return Object.keys(value).some(key => !allowed.has(key)); }
function nullOnly(value: object, fields: readonly string[]): boolean { return fields.some(field => Object.hasOwn(value, field) && (value as Record<string, unknown>)[field] !== null); }

type ChatToolDefinition = { name: string; responseTool?: { name?: string; namespace?: string } };
/**
 * The name each tool goes by on the wire. A model has to write this name back token by token, and an opaque position gave
 * it nothing to recall: on replayed failure contexts Qwen's per-call chance of an invalid token fell from about 6% to
 * about 0.004% once it saw real names. A tool keeps its name unless the Chat Completions grammar or uniqueness forbids
 * it; only then does it fall back to its position, `tool_N`, a form a real name may not take here.
 */
export function chatWireToolNames<T extends { function: { name: string } }>(tools: readonly T[]): string[] {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.function.name, (counts.get(tool.function.name) || 0) + 1);
  return tools.map(({ function: { name } }, index) => /^[A-Za-z0-9_-]{1,64}$/.test(name) && !/^tool_\d+$/.test(name) && counts.get(name) === 1 ? name : `tool_${index}`);
}
/**
 * Map a returned tool name to its declaration. Besides the wire name, some self-hosted models (Qwen through vLLM's tool
 * parser) occasionally answer with a qualified or local original name. Accept that only when exactly one declared tool
 * carries it, so a guess never runs a different tool. A position that is not a wire name is a guess and never resolves.
 */
export function resolveChatTool<T extends { function: ChatToolDefinition }>(name: string, tools: readonly T[]): T["function"] | undefined {
  const wire = chatWireToolNames(tools).indexOf(name);
  if (wire >= 0) return tools[wire]!.function;
  if (!name || /^tool_\d+$/.test(name)) return undefined;
  const unique = (matches: T[]) => matches.length === 1 ? matches[0]!.function : undefined;
  const local = (tool: T) => tool.function.responseTool?.name;
  const qualified = (tool: T) => tool.function.responseTool?.namespace ? `${tool.function.responseTool.namespace}.${local(tool)}` : undefined;
  return unique(tools.filter(tool => qualified(tool) === name))
    ?? unique(tools.filter(tool => local(tool) === name));
}
function reportRecovery(policy: ChatCompletionRecoveryPolicy, event: Parameters<NonNullable<ChatCompletionRecoveryPolicy["onRecovery"]>>[0]): void {
  try { policy.onRecovery?.(event); } catch { /* Observability never changes an inference. */ }
}
type AttemptOutcome = {
  empty: boolean;
  usage: Usage;
  durationMs: number;
  calls: Map<number, { id: string; name: string; arguments: string }>;
  capped: boolean;
};

/** Chat Completions transport for local vLLM and compatible API servers. */
export class ChatCompletionsAPI implements Provider {
  private readonly tailnet?: ReturnType<typeof tailnetFetch>;
  private readonly reasoningReplay?: ReasoningReplay;
  /** `seams` exist for tests of a `tailnet: true` provider; production never passes them. */
  constructor(private readonly config: ProviderConfig, seams?: TailnetSeams, private readonly recovery?: ChatCompletionRecoveryPolicy) { if (isDeepSeekApi(config.baseUrl)) this.reasoningReplay = new ReasoningReplay(); if (config.tailnet) this.tailnet = tailnetFetch(config.id, seams); }
  async *infer(request: ResponsesRequest, signal: AbortSignal, context: InferenceContext = {}): AsyncGenerator<InferenceEvent> {
    const options = generationOptions(request, 2);
    const credential = await apiCredential(this.config);
    if (!credential) throw new ProviderError("authentication", "Chat API credential is missing", 401);
    // Replayed reasoning replaces a public summary, which would otherwise merge into the answer and change the turn.
    const translated = responsesToChatRequest(request, { reasoningSummaryMetadata: !!this.reasoningReplay });
    const normalized = this.reasoningReplay ? { ...translated, messages: translated.messages.filter(message => !message.reasoningSummary) } : translated;
    const tools = canonicalTools(normalized.tools || []);
    if (request.previous_response_id !== undefined) throw new ProviderError("invalid_request", "Chat API requires replayed history", 400);
    if (request.max_output_tokens !== undefined && (!Number.isInteger(request.max_output_tokens) || Number(request.max_output_tokens) < 1)) throw new ProviderError("invalid_request", "max_output_tokens must be a positive integer", 400);
    const modelAlias = Object.entries(this.config.models).find(([, model]) => model === request.model)?.[0];
    // Images reach only a model whose metadata lists image input; a text-only server keeps the refusal.
    const vision = !!modelAlias && this.config.modelMetadata?.[modelAlias]?.inputModalities?.includes("image") === true;
    if (!vision && normalized.messages.some(message => message.parts?.some(part => part.type === "image"))) throw new ProviderError("unsupported_input", "This chat model does not accept images; its metadata does not list image input", 400);
    const wireNames = chatWireToolNames(tools);
    const nativeName = (name: string): string => {
      const index = tools.findIndex(tool => tool.function.name === name);
      if (index < 0) throw new ProviderError("invalid_request", "Historical tool is absent from the current catalog", 400);
      return wireNames[index]!;
    };
    const reasoning = request.reasoning as { effort?: unknown; summary?: unknown } | undefined;
    const alias = Object.entries(this.config.models).find(([, model]) => model === request.model)?.[0];
    const levels = alias ? this.config.modelMetadata?.[alias]?.reasoningEfforts : undefined;
    if (reasoning?.effort !== undefined && (typeof reasoning.effort !== "string" || !levels?.includes(reasoning.effort))) throw new ProviderError("invalid_request", "Selected chat model does not support this reasoning effort", 400);
    const choice = tools.length ? normalized.tool_choice : toollessChoice(normalized.tool_choice);
    // Use the same leading-system normalization for both ingress protocols.
    // Strict chat templates reject later system messages. Keep every instruction
    // at system priority and in source order; conversation replay keeps its order.
    const system = normalized.messages.filter(message => message.role === "system" || message.role === "developer").map(message => message.content || "").filter(Boolean).join("\n\n");
    const conversation = compactAssistantReplay(normalized.messages, nativeName, name => tools.some(tool => tool.function.name === name), vision);
    // The contract applies only to requests carrying tools. Without the reasoning, thinking is off for this request, which the rule does not cover.
    const replayKey = providerConversationId(context);
    const replayed = this.reasoningReplay && tools.length ? this.reasoningReplay.restore(replayKey, conversation) : conversation;
    const reasoningLost = !replayed;
    if (reasoningLost) telemetry("chat_reasoning_replay_miss", { provider: this.config.id });
    const messages: ReplayMessage[] = replayed ?? conversation;
    if (system) messages.unshift({ role: "system", content: system });
    const url = `${this.config.baseUrl!.replace(/\/$/, "")}/chat/completions`;
    const body = JSON.stringify({ model: request.model, messages, stream: true, stream_options: { include_usage: true },
        ...(tools.length ? { tools: tools.map(({ function: fn }, index) => ({ type: "function", function: { name: wireNames[index], description: fn.description, parameters: fn.parameters || { type: "object", properties: {} } } })) } : {}),
        ...(choice ? { tool_choice: typeof choice === "object" ? { type: "function", function: { name: nativeName(choice.function.name) } } : choice } : {}),
        ...(reasoningLost ? { thinking: { type: "disabled" } } : reasoning?.effort === undefined ? {} : this.config.chatTemplateReasoningEffort
          ? { chat_template_kwargs: { reasoning_effort: reasoning.effort, enable_thinking: reasoning.effort !== "none" } }
          : { reasoning_effort: reasoning.effort }),
        ...(request.max_output_tokens !== undefined ? { max_tokens: request.max_output_tokens } : {}),
        ...(options.stop === undefined ? {} : { stop: options.stop }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.topP === undefined ? {} : { top_p: options.topP }),
        ...(options.parallelToolCalls === undefined ? {} : { parallel_tool_calls: options.parallelToolCalls }),
      });
    const recover = this.recovery && this.recovery.models.includes(request.model) && context.clientProtocol === "messages"
      && choice !== "required" && typeof choice !== "object" && !options.stop?.length;
    if (!recover) {
      const thoughts = this.reasoningReplay ? { reasoning: "", text: "" } : undefined;
      const outcome = yield* this.streamAttempt(request, signal, undefined, context, url, credential, body, tools, choice, reasoning, false, false, undefined, thoughts);
      yield* this.completed(outcome.calls, tools, choice);
      if (thoughts && !reasoningLost) this.reasoningReplay!.remember(replayKey, conversation.filter(message => message.role === "assistant"), { content: thoughts.text, tool_calls: [...outcome.calls.values()] }, thoughts.reasoning);
      yield { type: "done", usage: outcome.usage, ...(outcome.capped ? { stopReason: "max_tokens" as const } : {}) };
      return;
    }
    let cumulative = zeroUsage();
    let retryDeadline: AbortController | undefined; let retryTimer: NodeJS.Timeout | undefined;
    try {
      for (let attempt = 1 as 1 | 2; attempt <= 2; attempt = 2) {
        if (signal.aborted) return;
        let usageEmitted = false;
        const stream = this.streamAttempt(request, signal, retryDeadline?.signal, context, url, credential, body, tools, choice, reasoning, true, true, this.recovery.timeoutMs);
        let outcome: AttemptOutcome;
        try {
          for (;;) {
            const next = await stream.next();
            if (next.done) { outcome = next.value; break; }
            if (next.value.type === "usage") {
              usageEmitted = true; yield { type: "usage", usage: addUsage(cumulative, next.value.usage) };
              if (signal.aborted) return;
            } else yield next.value;
          }
        } finally { await Promise.resolve(stream.return?.(undefined as never)).catch(() => undefined); }
        cumulative = addUsage(cumulative, outcome.usage);
        if (!outcome.empty) {
          yield* this.completed(outcome.calls, tools, choice);
          yield { type: "done", usage: cumulative, ...(attempt === 2 ? { clientUsage: outcome.usage } : {}), ...(outcome.capped ? { stopReason: "max_tokens" as const } : {}) };
          if (attempt === 2) reportRecovery(this.recovery, { outcome: "recovered", model: request.model, attempt, durationMs: outcome.durationMs, usage: cumulative });
          return;
        }
        if (!usageEmitted) yield { type: "usage", usage: cumulative };
        if (largeUncachedUsage({ inputTokens: outcome.usage.input_tokens, cachedTokens: outcome.usage.input_tokens_details?.cached_tokens })) {
          throw new ProviderError("incomplete", "Chat API returned an empty large-context completion; stopped before replaying measured uncached input", 502);
        }
        if (attempt === 2) {
          reportRecovery(this.recovery, { outcome: "exhausted", model: request.model, attempt, durationMs: outcome.durationMs, usage: cumulative });
          throw new ProviderError("incomplete", "Chat API returned an empty completion", 502);
        }
        if (signal.aborted) return;
        reportRecovery(this.recovery, { outcome: "retry", model: request.model, attempt, durationMs: outcome.durationMs, usage: cumulative });
        retryDeadline = new AbortController();
        retryTimer = setTimeout(() => retryDeadline?.abort(), this.recovery.timeoutMs ?? recoveryDeadlineMs);
      }
    } finally { clearTimeout(retryTimer); }
  }

  private async *streamAttempt(request: ResponsesRequest, caller: AbortSignal, deadline: AbortSignal | undefined, context: InferenceContext, url: string, credential: string, body: string,
    tools: NonNullable<ReturnType<typeof responsesToChatRequest>["tools"]>, choice: ReturnType<typeof responsesToChatRequest>["tool_choice"],
    reasoning: { effort?: unknown; summary?: unknown } | undefined, reportUsage: boolean, strictEmpty = false, eofTimeoutMs = recoveryEofMs,
    thoughts?: { reasoning: string; text: string }): AsyncGenerator<InferenceEvent, AttemptOutcome> {
    const started = Date.now(); const eof = new AbortController();
    const signal = AbortSignal.any([caller, eof.signal, ...(deadline ? [deadline] : [])]);
    let eofTimer: NodeJS.Timeout | undefined; let eofExpired = false;
    let usage = zeroUsage(); let done = false; let finish: string | undefined; let sawChoiceModel = false; let exactChoiceModels = true; let textBytes = 0; let toolFragments = false; let refusedOrMalformed = false;
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    try {
      caller.throwIfAborted();
      let response: Response;
      try {
        const headers = { "Content-Type": "application/json", Authorization: `Bearer ${credential}`, ...apiRoutingHeaders(this.config, context, request) };
        response = await connectChatProvider(this.config.id, signal, () => this.tailnet
          ? this.tailnet(url, { method: "POST", headers, body, signal })
          : fetch(url, { method: "POST", redirect: "error", headers, body, signal }));
      } catch (error) {
        if (deadline?.aborted && !caller.aborted) throw timeoutError();
        throw error;
      }
      if (!response.ok) {
        if (response.status === 400) {
          // A copy is read so ordinary error mapping below still sees the original body; only fixed classes leave here.
          const rejected = await boundedJson(response.clone());
          const rejection = chatRejection(rejected);
          telemetry("chat_request_rejected", { provider: /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(this.config.id) ? this.config.id : "other", reason: rejection.reason, ...(rejection.param ? { param: rejection.param } : {}) });
          const overflow = rejected === undefined ? undefined : chatContextFailure(rejected);
          if (overflow) { await response.body?.cancel().catch(() => {}); throw overflow; }
        }
        const typed = await responsesHttpError(response); if (typed.code === "context_length_exceeded" || typed.code === "insufficient_quota" || response.status === 429) throw typed;
        throw new ProviderError(response.status === 429 ? "usage_limit" : response.status === 401 ? "authentication" : "upstream_error", `Chat API returned HTTP ${response.status}`, [400, 401, 403, 429].includes(response.status) ? response.status : 502);
      }
      if (!response.body) throw incomplete("Chat API returned no stream");
      for await (const event of readEvents(response.body, "chat")) {
        const observed = event.usage as { prompt_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
        if (observed && typeof observed === "object") context.observeCacheUsage?.({ inputTokens: observed.prompt_tokens,
          cachedTokens: observed.prompt_tokens_details?.cached_tokens ?? observed.prompt_cache_hit_tokens });
        if (done) throw incomplete("Chat API returned data after completion");
        if (strictEmpty && (nullOnly(event, ["prompt_token_ids", "prompt_text"]) || unknownFields(event, chatEnvelopeFields))) refusedOrMalformed = true;
        if (event.type === "error") {
          const typed = responsesStreamError(event); if (typed.code === "context_length_exceeded") throw typed;
          throw new ProviderError("inference_failed", "Chat API inference failed");
        }
        if (event.type === "chat.done") {
          const capped = context.clientProtocol === "messages" && finish === "length";
          const complete = !!finish && (["stop", "tool_calls"].includes(finish) || capped);
          // vLLM ends an explicitly selected named-tool call with stop rather than tool_calls.
          const namedToolStop = finish === "stop" && choice !== null && typeof choice === "object" && calls.size > 0;
          if (!complete || (!namedToolStop && ((finish === "tool_calls") !== (calls.size > 0))) || (capped && calls.size > 0)) throw incomplete("Chat API response was incomplete or refused");
          if ((choice === "required" || typeof choice === "object") && !calls.size) throw new ProviderError("invalid_tool_call", "Chat API omitted the required tool");
          done = true;
          const noVisibleOutput = finish === "stop" && !calls.size && !textBytes && !toolFragments;
          // Reasoning is not an answer. Responses clients otherwise end the agent
          // turn successfully even when the model only planned its next action.
          if (noVisibleOutput && context.clientProtocol !== "messages") {
            yield { type: "usage", usage };
            throw incomplete("Chat API returned no answer or tool call");
          }
          if (strictEmpty && noVisibleOutput && (refusedOrMalformed || !sawChoiceModel || !exactChoiceModels)) throw incomplete("Chat API response was incomplete or refused");
          const empty = noVisibleOutput && sawChoiceModel && exactChoiceModels;
          if (empty && strictEmpty) { eofTimer = setTimeout(() => { eofExpired = true; eof.abort(); }, Math.min(recoveryEofMs, eofTimeoutMs)); continue; }
          return { empty: false, usage, durationMs: Date.now() - started, calls, capped };
        }
        if (event.model !== undefined && event.model !== request.model) throw new ProviderError("model_route", "Chat API returned a different model", 502);
        if (strictEmpty && event.usage != null && (typeof event.usage !== "object" || Array.isArray(event.usage))) throw incomplete("Chat API returned invalid usage");
        const wireUsage = event.usage as { prompt_cache_hit_tokens?: unknown; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: unknown } | null } | null | undefined;
        if (wireUsage) {
          if (strictEmpty && [wireUsage.prompt_tokens, wireUsage.completion_tokens, wireUsage.total_tokens].some(value => value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0))) {
            throw incomplete("Chat API returned invalid usage");
          }
          // vLLM and OpenAI report prefix-cache reuse as prompt_tokens_details.cached_tokens, and DeepSeek as prompt_cache_hit_tokens; carry it so cache hits are visible.
          const wireCached = wireUsage.prompt_tokens_details?.cached_tokens ?? wireUsage.prompt_cache_hit_tokens;
          const cached = typeof wireCached === "number" && Number.isFinite(wireCached) && wireCached >= 0
            && typeof wireUsage.prompt_tokens === "number" && wireCached <= wireUsage.prompt_tokens ? Math.floor(wireCached) : undefined;
          usage = { input_tokens: wireUsage.prompt_tokens || 0, output_tokens: wireUsage.completion_tokens || 0, total_tokens: wireUsage.total_tokens || 0,
            ...(cached === undefined ? {} : { input_tokens_details: { cached_tokens: cached } }) };
          context.observeCacheUsage?.({ inputTokens: wireUsage.prompt_tokens, cachedTokens: cached });
          if (reportUsage) yield { type: "usage", usage };
        }
        const choices = event.choices as Array<{ index: number; delta?: { role?: unknown; content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
        if (choices.length > 1 || choices.some(choice => choice.index !== 0)) throw new ProviderError("unsupported_output", "Chat API returned multiple choices");
        if (choices.length) {
          sawChoiceModel ||= event.model === request.model;
          exactChoiceModels &&= event.model === request.model;
        }
        for (const next of choices) {
          if (strictEmpty && (nullOnly(next, ["stop_reason", "token_ids"]) || unknownFields(next, chatChoiceFields))) refusedOrMalformed = true;
          const rawDelta = next.delta;
          if (strictEmpty && (rawDelta === undefined || rawDelta === null || typeof rawDelta !== "object" || Array.isArray(rawDelta))) refusedOrMalformed = true;
          const delta = rawDelta && typeof rawDelta === "object" && !Array.isArray(rawDelta) ? rawDelta : {};
          if (finish && (delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls?.length)) throw incomplete("Chat API returned content after completion");
          if (strictEmpty && ((delta.content !== undefined && typeof delta.content !== "string") || (delta.reasoning_content !== undefined && typeof delta.reasoning_content !== "string")
            || (delta.reasoning !== undefined && typeof delta.reasoning !== "string") || (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls))
            || unknownFields(delta, chatDeltaFields))) refusedOrMalformed = true;
          if (typeof delta.content === "string") { textBytes += Buffer.byteLength(delta.content); if (delta.content) yield { type: "text", text: delta.content }; }
          // Read both raw fields before summary suppression. Reasoning-only output remains an empty completion candidate.
          const rawReasoningContent = typeof delta.reasoning_content === "string";
          const rawReasoning = typeof delta.reasoning === "string";
          const thought = rawReasoningContent ? delta.reasoning_content : rawReasoning ? delta.reasoning : undefined;
          if (thoughts && typeof thought === "string") thoughts.reasoning += thought;
          if (thoughts && typeof delta.content === "string") thoughts.text += delta.content;
          if (reasoning?.summary !== "none" && typeof thought === "string" && thought) yield { type: "reasoning", text: thought };
          if (delta.tool_calls?.length) toolFragments = true;
          for (const part of delta.tool_calls || []) {
            if (!Number.isInteger(part.index) || part.index < 0 || part.index > 255) throw new ProviderError("invalid_tool_call", "Chat API returned an invalid tool index");
            const call = calls.get(part.index) || { id: "", name: "", arguments: "" };
            if (part.id && call.id && part.id !== call.id) throw new ProviderError("invalid_tool_call", "Chat API changed a tool call ID");
            if (part.id) call.id = part.id;
            if (part.function?.name) call.name += part.function.name;
            if (part.function?.arguments) call.arguments += part.function.arguments;
            if (call.arguments.length > 8 * 1024 * 1024) throw new ProviderError("output_too_large", "Tool arguments exceed 8 MiB");
            calls.set(part.index, call);
          }
          if (next.finish_reason) { if (finish) throw incomplete("Chat API repeated its completion"); finish = next.finish_reason; }
        }
      }
      if (done && strictEmpty) return { empty: true, usage, durationMs: Date.now() - started, calls, capped: false };
      throw incomplete("Chat API stream ended without completion");
    } catch (error) {
      if (eofExpired) throw incomplete("Chat API stream did not end after completion");
      if (deadline?.aborted && !caller.aborted) throw timeoutError();
      throw error;
    } finally { clearTimeout(eofTimer); }
  }

  private *completed(calls: Map<number, { id: string; name: string; arguments: string }>, tools: NonNullable<ReturnType<typeof responsesToChatRequest>["tools"]>,
    choice: ReturnType<typeof responsesToChatRequest>["tool_choice"]): Generator<InferenceEvent> {
    // Check the whole batch before releasing any call: a client runs a call as it arrives, so a
    // later malformed sibling must not leave an executed call behind for the retry to repeat.
    const ids = new Set<string>(); const accepted: Extract<InferenceEvent, { type: "tool" }>[] = [];
    for (const call of calls.values()) {
      const definition = resolveChatTool(call.name, tools);
      const shown = JSON.stringify(call.name.slice(0, 64));
      if (!call.id) throw new ProviderError("invalid_tool_call", "Chat API returned a tool call without an ID");
      if (ids.has(call.id)) throw new ProviderError("invalid_tool_call", "Chat API repeated a tool call ID");
      if (!definition) throw malformedToolCall(`Chat API returned an unknown tool ${shown}`, "unknown_tool");
      if (choice === "none" || (typeof choice === "object" && choice.function.name !== definition.name)) throw new ProviderError("invalid_tool_call", `Chat API returned an unselected tool ${shown}`);
      let input: unknown; try { input = JSON.parse(call.arguments); } catch { throw malformedToolCall("Chat API returned invalid tool JSON", "invalid_tool_arguments"); }
      if (!input || typeof input !== "object" || Array.isArray(input) || (definition.responseTool?.type === "custom" && typeof (input as { input?: unknown }).input !== "string")) throw malformedToolCall("Chat API returned invalid tool input", "invalid_tool_arguments");
      ids.add(call.id); accepted.push({ type: "tool", call: { id: call.id, type: "function", responseTool: definition.responseTool, function: { name: definition.name, arguments: call.arguments } } });
    }
    yield* accepted;
  }
}
