import type { ChatToolSelection, OpenAITool, OpenAIToolCall, InferenceEvent } from "../protocol/types.js";
import { ProviderError } from "./provider.js";
import { claudeToolBindings } from "./claude-tool-names.js";

const callFailure = (code: string) => new ProviderError("invalid_tool_call", code === "unknown_tool"
  ? "Claude returned an undeclared tool call (unknown_tool). Gateway stopped before forwarding tool calls from this response. Send a new message to retry."
  : `Claude returned an invalid tool call (${code}). Gateway stopped before forwarding tool calls from this response.`, 502, { code, event: "claude.tool_use" });

/** Adopted sessions keep their old error class. Normalize only fixed own-data fields, never their prose. */
export function rejectedClaudeTool(error: unknown): ProviderError | undefined {
  const own = (value: unknown, key: string): unknown => value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  try {
    const upstream = own(error, "upstream"), reason = own(upstream, "code");
    if (!(error instanceof Error) || own(error, "code") !== "invalid_tool_call" || own(upstream, "event") !== "claude.tool_use" ||
      typeof reason !== "string" || !["unknown_tool", "native_builtin_tool", "native_tool_search", "native_mcp_wait", "unavailable_gateway_tool"].includes(reason)) return;
    return callFailure(reason);
  } catch { return; }
}

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
  const bindings = claudeToolBindings(tools, true);
  return blocks.map(call => {
    const definition = typeof call.name === "string" ? bindings.get(call.name)?.function : undefined;
    const failure = callFailure;
    if (!definition) throw failure(call.name === "ToolSearch" || call.name === "MCPSearch" ? "native_tool_search" : call.name === "WaitForMcpServers" ? "native_mcp_wait" : typeof call.name === "string" && call.name.startsWith("mcp__gateway__") ? "unavailable_gateway_tool" : ["Bash", "Read", "Write", "Edit", "Agent", "Task", "Skill", "AskUserQuestion"].includes(call.name || "") ? "native_builtin_tool" : "unknown_tool");
    if (typeof call.id !== "string" || !call.id || !call.input || typeof call.input !== "object" || Array.isArray(call.input)) throw failure("malformed_tool_call");
    if (ids.has(call.id)) throw failure("duplicate_tool_id");
    ids.add(call.id);
    if (definition.responseTool?.type === "custom" && typeof (call.input as { input?: unknown }).input !== "string") throw new ProviderError("invalid_tool_call", "Free-form input must be a string", 502, { code: "nontext_custom_input", event: "claude.tool_use" });
    return { id: call.id, type: "function", responseTool: definition.responseTool, function: { name: definition.name, arguments: JSON.stringify(call.input) } };
  });
}

/** The full catalog is always offered, so a forced choice is checked against the returned calls. */
export function validateForcedChoice(calls: OpenAIToolCall[], choice: ChatToolSelection | undefined): void {
  if (typeof choice === "object" && calls.some(call => call.function.name !== choice.function.name)) {
    throw new ProviderError("invalid_tool_call", "Claude called a tool other than the required one", 502, { code: "forced_tool_mismatch", event: "claude.tool_use" });
  }
  if ((choice === "required" || typeof choice === "object") && !calls.length) {
    throw new ProviderError("invalid_tool_call", "Claude did not return the required tool call", 502, { code: "required_tool_missing", event: "claude.result" });
  }
}
