import { apiCredential, type ProviderConfig } from "../config.js";
import { responsesToChatRequest } from "../protocol/request.js";
import { readEvents } from "../protocol/sse.js";
import type { ResponsesRequest, InferenceEvent, Usage } from "../protocol/types.js";
import { ProviderError, type InferenceContext, type Provider } from "./provider.js";
import { apiRoutingHeaders } from "./api-routing.js";
import { generationOptions } from "./generation-options.js";

function historicalArguments(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new ProviderError("invalid_request", "Historical tool arguments are not valid JSON", 400); }
}
import { anthropicParts } from "../protocol/images.js";
import { anthropicContextFailure, anthropicHttpContextFailure, contextWindowFailure } from "./context-errors.js";
import { responsesHttpError } from "./responses-errors.js";

/** Attaches up to four ephemeral breakpoints to an outbound body: the last tool, the last system block, then the tails of the last two messages. */
function attachEphemeralCacheControl(body: {
  tools?: Array<Record<string, unknown>>;
  system?: Array<Record<string, unknown>>;
  messages?: Array<{ role?: string; content?: Array<Record<string, unknown>> }>;
}): void {
  const marked = new WeakSet<object>();
  let budget = 4;
  const mark = (target: Record<string, unknown> | undefined): void => {
    if (!target || marked.has(target)) return;
    if (budget === 0) return;
    budget--;
    marked.add(target);
    target.cache_control = { type: "ephemeral" };
  };
  mark(body.tools?.at(-1));
  mark(body.system?.at(-1));
  const messages = body.messages || [];
  if (messages.length >= 2) mark(messages.at(-2)?.content?.at(-1));
  mark(messages.at(-1)?.content?.at(-1));
}

export class AnthropicAPI implements Provider {
  constructor(private readonly config: ProviderConfig) {}
  async *infer(request: ResponsesRequest, signal: AbortSignal, context: InferenceContext = {}): AsyncGenerator<InferenceEvent> {
    const options = generationOptions(request, 1);
    const credential = await apiCredential(this.config);
    if (!credential) throw new ProviderError("authentication", "Anthropic API credential is missing", 401);
    const normalized = responsesToChatRequest(request);
    const reasoning = request.reasoning as { effort?: unknown; summary?: unknown } | undefined;
    const effort = reasoning?.effort;
    const alias = Object.entries(this.config.models).find(([, model]) => model === request.model)?.[0];
    const supported = alias ? this.config.modelMetadata?.[alias]?.reasoningEfforts : undefined;
    const noEffort = effort === "none" && supported?.length === 0;
    if (effort !== undefined && !noEffort && (typeof effort !== "string" || !["low", "medium", "high", "xhigh", "max"].includes(effort) || (supported && !supported.includes(effort)))) throw new ProviderError("invalid_request", "Selected Anthropic model does not support this reasoning effort", 400);
    const tools = normalized.tools || [];
    const nativeName = (name: string): string => {
      const index = tools.findIndex(tool => tool.function.name === name);
      if (index < 0) throw new ProviderError("invalid_request", "Historical tool is absent from the current catalog", 400);
      return `tool_${index}`;
    };
    const messages: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }> = [];
    const system: string[] = [];
    let sawConversation = false;
    for (const message of normalized.messages) {
      if (message.role === "system" || message.role === "developer") {
        if (context.clientProtocol === "messages" && sawConversation) throw new ProviderError("invalid_request", "Anthropic Messages requests cannot represent mid-conversation system instructions", 400);
        if (message.content) system.push(message.content);
        continue;
      }
      sawConversation = true;
      const role = message.role === "assistant" ? "assistant" : "user";
      const content: Array<Record<string, unknown>> = [];
      if (message.role === "tool") content.push({ type: "tool_result", tool_use_id: message.tool_call_id, content: message.parts ? anthropicParts(message) : message.content || "" });
      else {
        content.push(...anthropicParts(message));
        for (const call of message.tool_calls || []) content.push({ type: "tool_use", id: call.id, name: nativeName(call.function.name), input: historicalArguments(call.function.arguments) });
      }
      if (!content.length) continue;
      const last = messages.at(-1);
      if (last?.role === role) last.content.push(...content); else messages.push({ role, content });
    }
    if (!messages.length) messages.push({ role: "user", content: [{ type: "text", text: "Continue" }] });
    const choice = normalized.tool_choice;
    const maxTokens = request.max_output_tokens === undefined ? 8192 : request.max_output_tokens;
    if (!Number.isInteger(maxTokens) || Number(maxTokens) < 1) throw new ProviderError("invalid_request", "max_output_tokens must be a positive integer", 400);
    const outboundMessages = messages;
    const outboundSystem = system.map(text => ({ type: "text", text }));
    const outboundTools = tools.map((tool, index) => ({ name: `tool_${index}`, description: tool.function.description || "", input_schema: tool.function.parameters || { type: "object", properties: {} } }));
    const body = { model: request.model, stream: true, max_tokens: maxTokens, system: outboundSystem, messages: outboundMessages, tools: outboundTools,
        ...(effort !== undefined && !noEffort ? { output_config: { effort } } : {}),
        ...(choice || options.parallelToolCalls === false ? { tool_choice: {
          ...(choice ? (typeof choice === "object" ? { type: "tool", name: nativeName(choice.function.name) } : { type: choice === "required" ? "any" : choice }) : { type: "auto" }),
          ...(options.parallelToolCalls === false ? { disable_parallel_tool_use: true } : {}),
        } } : {}),
        ...(options.stop === undefined ? {} : { stop_sequences: options.stop }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.topP === undefined ? {} : { top_p: options.topP }),
        ...(context.clientProtocol === "messages" && context.adaptiveThinking ? { thinking: { type: "adaptive" } } : {}),
    };
    attachEphemeralCacheControl(body);
    const response = await fetch(`${this.config.baseUrl!.replace(/\/$/, "")}/messages`, {
      method: "POST", redirect: "error", signal, headers: { "Content-Type": "application/json", "x-api-key": credential, "anthropic-version": "2023-06-01", ...apiRoutingHeaders(this.config, context, request) },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const context = await anthropicHttpContextFailure(response); if (context) throw context;
      // Anthropic's per-minute 429s carry Retry-After; they must stay retryable now that usage_limit is final.
      if (response.status === 429) throw await responsesHttpError(response);
      throw new ProviderError(response.status === 429 ? "usage_limit" : response.status === 401 ? "authentication" : "upstream_error", `Anthropic returned HTTP ${response.status}`, [400, 401, 403, 429].includes(response.status) ? response.status : 502);
    }
    if (!response.body) throw new ProviderError("incomplete", "Anthropic returned no stream");
    const blocks = new Map<number, { id: string; name: string; input: unknown; partial: string }>();
    const indices = new Set<number>(); const callIds = new Set<string>();
    const usage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let cacheWriteTokens: number | undefined;
    let stopReason: string | undefined; let stopSequence: unknown; let done = false;
    for await (const event of readEvents(response.body)) {
      if (event.type === "message_start") {
        const message = event.message as { usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
        const cacheReported = typeof message.usage?.cache_read_input_tokens === "number" && Number.isFinite(message.usage.cache_read_input_tokens) && message.usage.cache_read_input_tokens >= 0;
        const writesReported = typeof message.usage?.cache_creation_input_tokens === "number" && Number.isFinite(message.usage.cache_creation_input_tokens) && message.usage.cache_creation_input_tokens >= 0;
        const inputReported = typeof message.usage?.input_tokens === "number" && Number.isFinite(message.usage.input_tokens) && message.usage.input_tokens >= 0;
        const cacheRead = cacheReported ? message.usage!.cache_read_input_tokens! : 0;
        const cacheCreation = writesReported ? message.usage!.cache_creation_input_tokens! : 0;
        cacheWriteTokens = writesReported ? cacheCreation : undefined;
        usage.input_tokens = (inputReported ? message.usage!.input_tokens! : 0) + cacheCreation + cacheRead;
        if (cacheReported && writesReported && inputReported) usage.input_tokens_details = {
          cached_tokens: cacheRead,
          ...(writesReported ? { cache_creation_tokens: cacheCreation } : {}),
        };
      } else if (event.type === "content_block_start") {
        const block = event.content_block as { type: string; id: string; name: string; input: unknown };
        if (!["text", "thinking", "redacted_thinking", "tool_use"].includes(block.type)) throw new ProviderError("unsupported_output", "Anthropic returned an unsupported content block");
        if (block.type === "tool_use") {
          const index = Number(event.index);
          if (!Number.isInteger(index) || index < 0 || indices.has(index) || typeof block.id !== "string" || !block.id || callIds.has(block.id)) throw new ProviderError("invalid_tool_call", "Anthropic returned an invalid or duplicate tool block");
          indices.add(index); callIds.add(block.id); blocks.set(index, { ...block, partial: "" });
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
        if (delta.type === "text_delta" && delta.text) yield { type: "text", text: delta.text };
        if (reasoning?.summary !== "none" && delta.type === "thinking_delta" && typeof delta.thinking === "string") yield { type: "reasoning", text: delta.thinking };
        if (delta.type === "input_json_delta") {
          const block = blocks.get(Number(event.index));
          if (!block) throw new ProviderError("invalid_tool_call", "Anthropic sent arguments without a tool block");
          block.partial += delta.partial_json || "";
          if (block.partial.length > 8 * 1024 * 1024) throw new ProviderError("output_too_large", "Tool arguments exceed 8 MiB");
        }
      } else if (event.type === "content_block_stop") {
        const block = blocks.get(Number(event.index));
        if (block) {
          const definition = tools[Number(block.name.replace(/^tool_/, ""))]?.function;
          if (!definition || !/^tool_\d+$/.test(block.name)) throw new ProviderError("invalid_tool_call", "Anthropic returned an unknown tool");
          let input: unknown;
          try { input = block.partial ? JSON.parse(block.partial) : block.input; }
          catch { throw new ProviderError("invalid_tool_call", "Anthropic returned invalid tool JSON"); }
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new ProviderError("invalid_tool_call", "Anthropic returned non-object tool input");
          if (choice === "none" || (typeof choice === "object" && definition.name !== choice.function.name)) throw new ProviderError("invalid_tool_call", "Anthropic returned a tool outside the requested selection");
          if (definition.responseTool?.type === "custom" && typeof (input as { input?: unknown })?.input !== "string") throw new ProviderError("invalid_tool_call", "Free-form input must be a string");
          yield { type: "tool", call: { id: block.id, type: "function", responseTool: definition.responseTool, function: { name: definition.name, arguments: JSON.stringify(input) } } };
          blocks.delete(Number(event.index));
        }
      } else if (event.type === "message_delta") {
        const delta = event.delta as { stop_reason?: string; stop_sequence?: unknown };
        stopReason = delta.stop_reason;
        if (delta.stop_sequence !== undefined) stopSequence = delta.stop_sequence;
        usage.output_tokens = (event.usage as { output_tokens?: number })?.output_tokens || 0;
      } else if (event.type === "error") {
        const context = anthropicContextFailure(event); if (context) throw context;
        throw new ProviderError("inference_failed", "Anthropic inference failed");
      }
      else if (event.type === "message_stop") {
        if (stopReason === "model_context_window_exceeded") throw contextWindowFailure();
        const messagesClient = context.clientProtocol === "messages";
        const capped = messagesClient && stopReason === "max_tokens";
        const stopped = messagesClient && stopReason === "stop_sequence";
        const complete = !!stopReason && (["end_turn", "stop_sequence", "tool_use"].includes(stopReason) || capped);
        if (!complete || blocks.size) throw new ProviderError("incomplete", "Anthropic response was incomplete, paused, or refused");
        if ((capped || stopped) && callIds.size) throw new ProviderError("incomplete", "Anthropic stopped with tool calls");
        if (stopped && typeof stopSequence !== "string") throw new ProviderError("incomplete", "Anthropic did not provide its stop sequence");
        if (stopReason === "tool_use" && !callIds.size) throw new ProviderError("invalid_tool_call", "Anthropic stopped for a tool without returning one");
        if ((choice === "required" || typeof choice === "object") && !callIds.size) throw new ProviderError("invalid_tool_call", "Anthropic did not return the required tool call");
        usage.total_tokens = usage.input_tokens + usage.output_tokens;
        const nativeStopSequence = stopped ? stopSequence as string : undefined;
        done = true; yield { type: "done", usage, ...(cacheWriteTokens === undefined ? {} : { accounting: { cacheWriteTokens } }),
          ...(capped ? { stopReason: "max_tokens" as const } : {}),
          ...(stopped ? { stopReason: "stop_sequence" as const, stopSequence: nativeStopSequence! } : {}),
        }; break;
      }
    }
    if (!done) throw new ProviderError("incomplete", "Anthropic stream ended without completion");
  }
}
