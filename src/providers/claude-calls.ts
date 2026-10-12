import type { OpenAITool, OpenAIToolCall, InferenceEvent } from "../protocol/types.js";
import { ProviderError } from "./provider.js";
import { claudeToolBindings } from "./claude-tool-names.js";

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
  const bindings = claudeToolBindings(tools);
  return blocks.map(call => {
    const definition = typeof call.name === "string" ? bindings.get(call.name)?.function : undefined;
    const failure = (code: string) => new ProviderError("invalid_tool_call", "Claude returned an unknown, duplicate, or malformed tool call", 502, { code, event: "claude.tool_use" });
    if (!definition) throw failure(call.name === "ToolSearch" || call.name === "MCPSearch" ? "native_tool_search" : call.name === "WaitForMcpServers" ? "native_mcp_wait" : typeof call.name === "string" && call.name.startsWith("mcp__gateway__") ? "unavailable_gateway_tool" : ["Bash", "Read", "Write", "Edit", "Agent", "Task", "Skill", "AskUserQuestion"].includes(call.name || "") ? "native_builtin_tool" : "unknown_tool");
    if (typeof call.id !== "string" || !call.id || !call.input || typeof call.input !== "object" || Array.isArray(call.input)) throw failure("malformed_tool_call");
    if (ids.has(call.id)) throw failure("duplicate_tool_id");
    ids.add(call.id);
    if (definition.responseTool?.type === "custom" && typeof (call.input as { input?: unknown }).input !== "string") throw new ProviderError("invalid_tool_call", "Free-form input must be a string", 502, { code: "nontext_custom_input", event: "claude.tool_use" });
    return { id: call.id, type: "function", responseTool: definition.responseTool, function: { name: definition.name, arguments: JSON.stringify(call.input) } };
  });
}
