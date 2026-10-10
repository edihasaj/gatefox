import type { OpenAITool, OpenAIToolCall, InferenceEvent } from "../protocol/types.js";
import { ProviderError } from "./provider.js";

/** Some Claude versions expose token progress with an empty thinking string. */
export function nativeClaudeReasoning(event: { type?: string; delta?: { type?: string; thinking?: unknown; estimated_tokens?: unknown } }): Extract<InferenceEvent, { type: "reasoning" }> | undefined {
  if (event.type !== "content_block_delta" || event.delta?.type !== "thinking_delta" || typeof event.delta.thinking !== "string") return;
  const tokens = event.delta.estimated_tokens;
  const estimatedTokens = typeof tokens === "number" && Number.isInteger(tokens) && tokens >= 0 ? tokens : undefined;
  if (!event.delta.thinking && estimatedTokens === undefined) return;
  return { type: "reasoning", text: event.delta.thinking, ...(estimatedTokens !== undefined ? { estimatedTokens } : {}) };
}

/** Native tool-use objects are authoritative. Plain model text is never parsed as an action. */
export function nativeClaudeCalls(blocks: Array<{ id?: string; name?: string; input?: unknown }>, tools: OpenAITool[]): OpenAIToolCall[] {
  const ids = new Set<string>();
  return blocks.map(call => {
    const match = call.name?.match(/^mcp__gateway__tool_(\d+)$/);
    const definition = match ? tools[Number(match[1])]?.function : undefined;
    if (!definition || !call.id || ids.has(call.id) || !call.input || typeof call.input !== "object" || Array.isArray(call.input)) throw new ProviderError("invalid_tool_call", "Claude returned an unknown, duplicate, or malformed tool call");
    ids.add(call.id);
    if (definition.responseTool?.type === "custom" && typeof (call.input as { input?: unknown }).input !== "string") throw new ProviderError("invalid_tool_call", "Free-form input must be a string");
    return { id: call.id, type: "function", responseTool: definition.responseTool, function: { name: definition.name, arguments: JSON.stringify(call.input) } };
  });
}
