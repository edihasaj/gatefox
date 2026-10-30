import { apiCredential, type ProviderConfig } from "../config.js";
import { responsesToChatRequest } from "../protocol/request.js";
import { readEvents } from "../protocol/sse.js";
import type { ResponsesRequest, InferenceEvent, Usage } from "../protocol/types.js";
import { ProviderError, type InferenceContext, type Provider } from "./provider.js";
import { apiRoutingHeaders } from "./api-routing.js";
import { generationOptions } from "./generation-options.js";
import { tailnetFetch, type TailnetSeams } from "../tailnet.js";
import { responsesHttpError, responsesStreamError } from "./responses-errors.js";

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

function compactAssistantReplay(messages: ReturnType<typeof responsesToChatRequest>["messages"], nativeName: (name: string) => string) {
  const replay = messages.filter(message => message.role !== "system" && message.role !== "developer").map(({ parts: _parts, name: _name, tool_calls, role, ...message }) => ({ ...message, role,
    ...(tool_calls ? { tool_calls: tool_calls.map(({ id, function: fn }) => ({ id, type: "function" as const, function: { name: nativeName(fn.name), arguments: fn.arguments } })) } : {}),
  }));
  const compacted: typeof replay = [];
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
function incomplete(message: string): ProviderError { return new ProviderError("incomplete", message, 502); }
function unknownFields(value: object, allowed: ReadonlySet<string>): boolean { return Object.keys(value).some(key => !allowed.has(key)); }
function nullOnly(value: object, fields: readonly string[]): boolean { return fields.some(field => Object.hasOwn(value, field) && (value as Record<string, unknown>)[field] !== null); }

type ChatToolDefinition = { name: string; responseTool?: { name?: string; namespace?: string } };
/**
 * Map a returned tool name to its declaration. The wire names are `tool_N`; some self-hosted models (Qwen through vLLM's
 * tool parser) occasionally answer with the caller's original name instead. Accept that only when exactly one declared
 * tool carries it, so a guess never runs a different tool.
 */
export function resolveChatTool<T extends { function: ChatToolDefinition }>(name: string, tools: readonly T[]): T["function"] | undefined {
  if (/^tool_\d+$/.test(name)) return tools[Number(name.slice(5))]?.function;
  if (!name) return undefined;
  const unique = (matches: T[]) => matches.length === 1 ? matches[0]!.function : undefined;
  const local = (tool: T) => tool.function.responseTool?.name;
  const qualified = (tool: T) => tool.function.responseTool?.namespace ? `${tool.function.responseTool.namespace}.${local(tool)}` : undefined;
  return unique(tools.filter(tool => tool.function.name === name))
    ?? unique(tools.filter(tool => qualified(tool) === name))
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
  /** `seams` exist for tests of a `tailnet: true` provider; production never passes them. */
  constructor(private readonly config: ProviderConfig, seams?: TailnetSeams, private readonly recovery?: ChatCompletionRecoveryPolicy) { if (config.tailnet) this.tailnet = tailnetFetch(config.id, seams); }
  async *infer(request: ResponsesRequest, signal: AbortSignal, context: InferenceContext = {}): AsyncGenerator<InferenceEvent> {
    const options = generationOptions(request, 2);
    const credential = await apiCredential(this.config);
    if (!credential) throw new ProviderError("authentication", "Chat API credential is missing", 401);
    const normalized = responsesToChatRequest(request); const tools = normalized.tools || [];
    if (request.previous_response_id !== undefined) throw new ProviderError("invalid_request", "Chat API requires replayed history", 400);
    if (request.max_output_tokens !== undefined && (!Number.isInteger(request.max_output_tokens) || Number(request.max_output_tokens) < 1)) throw new ProviderError("invalid_request", "max_output_tokens must be a positive integer", 400);
    if (normalized.messages.some(message => message.parts?.some(part => part.type === "image"))) throw new ProviderError("unsupported_input", "This chat adapter currently supports text inputs only", 400);
    const nativeName = (name: string): string => {
      const index = tools.findIndex(tool => tool.function.name === name);
      if (index < 0) throw new ProviderError("invalid_request", "Historical tool is absent from the current catalog", 400);
      return `tool_${index}`;
    };
    const reasoning = request.reasoning as { effort?: unknown; summary?: unknown } | undefined;
    const alias = Object.entries(this.config.models).find(([, model]) => model === request.model)?.[0];
    const levels = alias ? this.config.modelMetadata?.[alias]?.reasoningEfforts : undefined;
    if (reasoning?.effort !== undefined && (typeof reasoning.effort !== "string" || !levels?.includes(reasoning.effort))) throw new ProviderError("invalid_request", "Selected chat model does not support this reasoning effort", 400);
    const choice = normalized.tool_choice;
    // Use the same leading-system normalization for both ingress protocols.
    // Strict chat templates reject later system messages. Keep every instruction
    // at system priority and in source order; conversation replay keeps its order.
    const system = normalized.messages.filter(message => message.role === "system" || message.role === "developer").map(message => message.content || "").filter(Boolean).join("\n\n");
    const messages = compactAssistantReplay(normalized.messages, nativeName);
    if (system) messages.unshift({ role: "system", content: system });
    const url = `${this.config.baseUrl!.replace(/\/$/, "")}/chat/completions`;
    const body = JSON.stringify({ model: request.model, messages, stream: true, stream_options: { include_usage: true },
        ...(tools.length ? { tools: tools.map(({ function: fn }, index) => ({ type: "function", function: { name: `tool_${index}`, description: fn.description, parameters: fn.parameters || { type: "object", properties: {} } } })) } : {}),
        ...(choice ? { tool_choice: typeof choice === "object" ? { type: "function", function: { name: nativeName(choice.function.name) } } : choice } : {}),
        ...(reasoning?.effort === undefined ? {} : this.config.chatTemplateReasoningEffort
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
      const outcome = yield* this.streamAttempt(request, signal, undefined, context, url, credential, body, tools, choice, reasoning, false);
      yield* this.completed(outcome.calls, tools, choice);
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
    reasoning: { effort?: unknown; summary?: unknown } | undefined, reportUsage: boolean, strictEmpty = false, eofTimeoutMs = recoveryEofMs): AsyncGenerator<InferenceEvent, AttemptOutcome> {
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
        response = this.tailnet ? await this.tailnet(url, { method: "POST", headers, body, signal })
          : await fetch(url, { method: "POST", redirect: "error", headers, body, signal });
      } catch (error) {
        if (deadline?.aborted && !caller.aborted) throw timeoutError();
        throw error;
      }
      if (!response.ok) {
        const typed = await responsesHttpError(response); if (typed.code === "context_length_exceeded" || response.status === 429) throw typed;
        throw new ProviderError(response.status === 429 ? "usage_limit" : response.status === 401 ? "authentication" : "upstream_error", `Chat API returned HTTP ${response.status}`, [400, 401, 403, 429].includes(response.status) ? response.status : 502);
      }
      if (!response.body) throw incomplete("Chat API returned no stream");
      for await (const event of readEvents(response.body, "chat")) {
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
          if (strictEmpty && noVisibleOutput && (refusedOrMalformed || !sawChoiceModel || !exactChoiceModels)) throw incomplete("Chat API response was incomplete or refused");
          const empty = noVisibleOutput && sawChoiceModel && exactChoiceModels;
          if (empty && strictEmpty) { eofTimer = setTimeout(() => { eofExpired = true; eof.abort(); }, Math.min(recoveryEofMs, eofTimeoutMs)); continue; }
          return { empty: false, usage, durationMs: Date.now() - started, calls, capped };
        }
        if (event.model !== undefined && event.model !== request.model) throw new ProviderError("model_route", "Chat API returned a different model", 502);
        if (strictEmpty && event.usage != null && (typeof event.usage !== "object" || Array.isArray(event.usage))) throw incomplete("Chat API returned invalid usage");
        const wireUsage = event.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: unknown } | null } | null | undefined;
        if (wireUsage) {
          if (strictEmpty && [wireUsage.prompt_tokens, wireUsage.completion_tokens, wireUsage.total_tokens].some(value => value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0))) {
            throw incomplete("Chat API returned invalid usage");
          }
          // vLLM and OpenAI report prefix-cache reuse as prompt_tokens_details.cached_tokens; carry it so cache hits are visible.
          const wireCached = wireUsage.prompt_tokens_details?.cached_tokens;
          const cached = typeof wireCached === "number" && Number.isFinite(wireCached) && wireCached >= 0 ? Math.min(Math.floor(wireCached), wireUsage.prompt_tokens || 0) : undefined;
          usage = { input_tokens: wireUsage.prompt_tokens || 0, output_tokens: wireUsage.completion_tokens || 0, total_tokens: wireUsage.total_tokens || 0,
            ...(cached === undefined ? {} : { input_tokens_details: { cached_tokens: cached } }) };
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
    const ids = new Set<string>();
    for (const call of calls.values()) {
      const definition = resolveChatTool(call.name, tools);
      const shown = JSON.stringify(call.name.slice(0, 64));
      if (!call.id) throw new ProviderError("invalid_tool_call", "Chat API returned a tool call without an ID");
      if (ids.has(call.id)) throw new ProviderError("invalid_tool_call", "Chat API repeated a tool call ID");
      if (!definition) throw new ProviderError("invalid_tool_call", `Chat API returned an unknown tool ${shown}`);
      if (choice === "none" || (typeof choice === "object" && choice.function.name !== definition.name)) throw new ProviderError("invalid_tool_call", `Chat API returned an unselected tool ${shown}`);
      let input: unknown; try { input = JSON.parse(call.arguments); } catch { throw new ProviderError("invalid_tool_call", "Chat API returned invalid tool JSON"); }
      if (!input || typeof input !== "object" || Array.isArray(input) || (definition.responseTool?.type === "custom" && typeof (input as { input?: unknown }).input !== "string")) throw new ProviderError("invalid_tool_call", "Chat API returned invalid tool input");
      ids.add(call.id); yield { type: "tool", call: { id: call.id, type: "function", responseTool: definition.responseTool, function: { name: definition.name, arguments: call.arguments } } };
    }
  }
}
