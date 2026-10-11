import type { ProviderConfig } from "../config.js";
import { responsesToChatRequest } from "../protocol/request.js";
import { readEvents } from "../protocol/sse.js";
import type { ResponsesRequest, InferenceEvent, Usage } from "../protocol/types.js";
import { ProviderError, type Provider } from "./provider.js";
import { anthropicParts } from "../protocol/images.js";

export class AnthropicAPI implements Provider {
  constructor(private readonly config: ProviderConfig) {}
  async *infer(request: ResponsesRequest, signal: AbortSignal): AsyncGenerator<InferenceEvent> {
    const credential = process.env[this.config.apiKeyEnv!];
    if (!credential) throw new ProviderError("authentication", "Anthropic API credential is missing", 401);
    const normalized = responsesToChatRequest(request);
    const tools = normalized.tools || [];
    const nativeName = (name: string): string => {
      const index = tools.findIndex(tool => tool.function.name === name);
      if (index < 0) throw new ProviderError("invalid_request", "Historical tool is absent from the current catalog", 400);
      return `tool_${index}`;
    };
    const messages: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }> = [];
    const system: string[] = [];
    for (const message of normalized.messages) {
      if (message.role === "system" || message.role === "developer") { if (message.content) system.push(message.content); continue; }
      const role = message.role === "assistant" ? "assistant" : "user";
      const content: Array<Record<string, unknown>> = [];
      if (message.role === "tool") content.push({ type: "tool_result", tool_use_id: message.tool_call_id, content: message.parts ? anthropicParts(message) : message.content || "" });
      else {
        content.push(...anthropicParts(message));
        for (const call of message.tool_calls || []) content.push({ type: "tool_use", id: call.id, name: nativeName(call.function.name), input: JSON.parse(call.function.arguments) });
      }
      if (!content.length) continue;
      const last = messages.at(-1);
      if (last?.role === role) last.content.push(...content); else messages.push({ role, content });
    }
    if (!messages.length) messages.push({ role: "user", content: [{ type: "text", text: "Continue" }] });
    const choice = normalized.tool_choice;
    const maxTokens = request.max_output_tokens === undefined ? 8192 : request.max_output_tokens;
    if (!Number.isInteger(maxTokens) || Number(maxTokens) < 1) throw new ProviderError("invalid_request", "max_output_tokens must be a positive integer", 400);
    const response = await fetch(`${this.config.baseUrl!.replace(/\/$/, "")}/messages`, {
      method: "POST", redirect: "error", signal, headers: { "Content-Type": "application/json", "x-api-key": credential, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: request.model, stream: true, max_tokens: maxTokens, system: system.join("\n"), messages,
        tools: tools.map((tool, index) => ({ name: `tool_${index}`, description: tool.function.description || "", input_schema: tool.function.parameters || { type: "object", properties: {} } })),
        ...(choice ? { tool_choice: typeof choice === "object" ? { type: "tool", name: nativeName(choice.function.name) } : { type: choice === "required" ? "any" : choice } } : {}),
      }),
    });
    if (!response.ok) throw new ProviderError(response.status === 429 ? "usage_limit" : response.status === 401 ? "authentication" : "upstream_error", `Anthropic returned HTTP ${response.status}`, [400, 401, 403, 429].includes(response.status) ? response.status : 502);
    if (!response.body) throw new ProviderError("incomplete", "Anthropic returned no stream");
    const blocks = new Map<number, { id: string; name: string; input: unknown; partial: string }>();
    const usage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let stopReason: string | undefined; let done = false;
    for await (const event of readEvents(response.body)) {
      if (event.type === "message_start") {
        const message = event.message as { usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
        usage.input_tokens = (message.usage?.input_tokens || 0) + (message.usage?.cache_creation_input_tokens || 0) + (message.usage?.cache_read_input_tokens || 0);
      } else if (event.type === "content_block_start") {
        const block = event.content_block as { type: string; id: string; name: string; input: unknown };
        if (block.type === "tool_use") blocks.set(Number(event.index), { ...block, partial: "" });
      } else if (event.type === "content_block_delta") {
        const delta = event.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
        if (delta.type === "text_delta" && delta.text) yield { type: "text", text: delta.text };
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") yield { type: "reasoning", text: delta.thinking };
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
          const input = block.partial ? JSON.parse(block.partial) : block.input;
          if (definition.responseTool?.type === "custom" && typeof (input as { input?: unknown })?.input !== "string") throw new ProviderError("invalid_tool_call", "Free-form input must be a string");
          yield { type: "tool", call: { id: block.id, type: "function", responseTool: definition.responseTool, function: { name: definition.name, arguments: JSON.stringify(input) } } };
          blocks.delete(Number(event.index));
        }
      } else if (event.type === "message_delta") {
        stopReason = (event.delta as { stop_reason?: string }).stop_reason;
        usage.output_tokens = (event.usage as { output_tokens?: number })?.output_tokens || 0;
      } else if (event.type === "error") throw new ProviderError("inference_failed", "Anthropic inference failed");
      else if (event.type === "message_stop") {
        if (!stopReason || ["max_tokens", "refusal"].includes(stopReason) || blocks.size) throw new ProviderError("incomplete", "Anthropic response was incomplete or refused");
        usage.total_tokens = usage.input_tokens + usage.output_tokens;
        done = true; yield { type: "done", usage }; break;
      }
    }
    if (!done) throw new ProviderError("incomplete", "Anthropic stream ended without completion");
  }
}
