import { apiCredential, type ProviderConfig } from "../config.js";
import { responsesToChatRequest } from "../protocol/request.js";
import { readEvents } from "../protocol/sse.js";
import type { ResponsesRequest, InferenceEvent, Usage } from "../protocol/types.js";
import { ProviderError, type InferenceContext, type Provider } from "./provider.js";
import { generationOptions } from "./generation-options.js";
import { tailnetFetch, type TailnetSeams } from "../tailnet.js";
import { responsesHttpError, responsesStreamError } from "./responses-errors.js";

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

/** Chat Completions transport for local vLLM and compatible API servers. */
export class ChatCompletionsAPI implements Provider {
  private readonly tailnet?: ReturnType<typeof tailnetFetch>;
  /** `seams` exist for tests of a `tailnet: true` provider; production never passes them. */
  constructor(private readonly config: ProviderConfig, seams?: TailnetSeams) { if (config.tailnet) this.tailnet = tailnetFetch(config.id, seams); }
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
    const init = { method: "POST", redirect: "error" as const, signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` }, body: JSON.stringify({ model: request.model, messages, stream: true, stream_options: { include_usage: true },
        ...(tools.length ? { tools: tools.map(({ function: fn }, index) => ({ type: "function", function: { name: `tool_${index}`, description: fn.description, parameters: fn.parameters || { type: "object", properties: {} } } })) } : {}),
        ...(choice ? { tool_choice: typeof choice === "object" ? { type: "function", function: { name: nativeName(choice.function.name) } } : choice } : {}),
        ...(reasoning?.effort !== undefined ? { reasoning_effort: reasoning.effort } : {}),
        ...(request.max_output_tokens !== undefined ? { max_tokens: request.max_output_tokens } : {}),
        ...(options.stop === undefined ? {} : { stop: options.stop }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.topP === undefined ? {} : { top_p: options.topP }),
        ...(options.parallelToolCalls === undefined ? {} : { parallel_tool_calls: options.parallelToolCalls }),
      }) };
    const response = this.tailnet ? await this.tailnet(url, init) : await fetch(url, init);
    if (!response.ok) {
      const typed = await responsesHttpError(response); if (typed.code === "context_length_exceeded" || response.status === 429) throw typed;
      throw new ProviderError(response.status === 429 ? "usage_limit" : response.status === 401 ? "authentication" : "upstream_error", `Chat API returned HTTP ${response.status}`, [400, 401, 403, 429].includes(response.status) ? response.status : 502);
    }
    if (!response.body) throw new ProviderError("incomplete", "Chat API returned no stream");
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let finish: string | undefined; let done = false;
    let usage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    for await (const event of readEvents(response.body, "chat")) {
      if (event.type === "error") {
        const typed = responsesStreamError(event); if (typed.code === "context_length_exceeded") throw typed;
        throw new ProviderError("inference_failed", "Chat API inference failed");
      }
      if (event.type === "chat.done") {
        const capped = context.clientProtocol === "messages" && finish === "length";
        const complete = !!finish && (["stop", "tool_calls"].includes(finish) || capped);
        if (!complete || ((finish === "tool_calls") !== (calls.size > 0)) || (capped && calls.size > 0)) throw new ProviderError("incomplete", "Chat API response was incomplete or refused");
        if ((choice === "required" || typeof choice === "object") && !calls.size) throw new ProviderError("invalid_tool_call", "Chat API omitted the required tool");
        const ids = new Set<string>();
        for (const call of calls.values()) {
          const index = /^tool_\d+$/.test(call.name) ? Number(call.name.slice(5)) : -1; const definition = tools[index]?.function;
          if (!call.id || ids.has(call.id) || !definition || choice === "none" || (typeof choice === "object" && choice.function.name !== definition.name)) throw new ProviderError("invalid_tool_call", "Chat API returned an invalid or unselected tool");
          let input: unknown; try { input = JSON.parse(call.arguments); } catch { throw new ProviderError("invalid_tool_call", "Chat API returned invalid tool JSON"); }
          if (!input || typeof input !== "object" || Array.isArray(input) || (definition.responseTool?.type === "custom" && typeof (input as { input?: unknown }).input !== "string")) throw new ProviderError("invalid_tool_call", "Chat API returned invalid tool input");
          ids.add(call.id); yield { type: "tool", call: { id: call.id, type: "function", responseTool: definition.responseTool, function: { name: definition.name, arguments: call.arguments } } };
        }
        done = true; yield { type: "done", usage, ...(capped ? { stopReason: "max_tokens" as const } : {}) }; break;
      }
      if (event.model !== undefined && event.model !== request.model) throw new ProviderError("model_route", "Chat API returned a different model", 502);
      const wireUsage = event.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
      if (wireUsage) usage = { input_tokens: wireUsage.prompt_tokens || 0, output_tokens: wireUsage.completion_tokens || 0, total_tokens: wireUsage.total_tokens || 0 };
      const choices = event.choices as Array<{ index: number; delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
      if (choices.length > 1 || choices.some(choice => choice.index !== 0)) throw new ProviderError("unsupported_output", "Chat API returned multiple choices");
      for (const choice of choices) {
        const delta = choice.delta || {};
        if (finish && (delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls?.length)) throw new ProviderError("incomplete", "Chat API returned content after completion");
        if (typeof delta.content === "string" && delta.content) yield { type: "text", text: delta.content };
        const thought = delta.reasoning_content ?? delta.reasoning;
        if (reasoning?.summary !== "none" && typeof thought === "string" && thought) yield { type: "reasoning", text: thought };
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
        if (choice.finish_reason) { if (finish) throw new ProviderError("incomplete", "Chat API repeated its completion"); finish = choice.finish_reason; }
      }
    }
    if (!done) throw new ProviderError("incomplete", "Chat API stream ended without completion");
  }
}
