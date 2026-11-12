import { createHash } from "node:crypto";
import type { OpenAITool, OpenAIChatMessage } from "../protocol/types.js";

const legacyTools = new WeakSet<OpenAITool>();
/** Preserve a running CLI's registered names without mutating caller definitions or restarting it. */
export function keepLegacyClaudeToolNames(tools: OpenAITool[]): void { for (const tool of tools) legacyTools.add(tool); }

const identity = (tool: OpenAITool) => {
  const source = tool.function.responseTool;
  return `${source?.namespace || "functions"}.${source?.name || tool.function.name}`;
};

/** Historical wire names remain readable in replay, never silently registered as extra actions. */
export function legacyClaudeToolName(tool: OpenAITool): string {
  const name = identity(tool);
  const local = (tool.function.responseTool?.name || name).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 24);
  return `tool_${local}_${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}
/** Existing Copilot/Grok consumers keep their established wire protocol. */
export const claudeToolName = legacyClaudeToolName;
/**
 * Prefer the caller's readable identity rather than asking the model to reproduce an opaque hash.
 * Length-prefixed namespaces keep separators unambiguous. Reserved prefixes isolate fallback names.
 * The full MCP name fits the API's 64-character limit, including `mcp__gateway__`.
 */
export function claudeWireToolName(tool: OpenAITool): string {
  if (legacyTools.has(tool)) return legacyClaudeToolName(tool);
  const source = tool.function.responseTool;
  const namespace = source?.namespace || "functions", local = source?.name || tool.function.name;
  const ordinary = (name: string) => /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
  const candidate = namespace === "functions" ? local : `n${namespace.length}_${namespace}_${local}`;
  if (ordinary(namespace) && ordinary(local) && candidate.length <= 51 &&
      (namespace !== "functions" || !/^(?:n\d+_|tool_)/.test(local))) return candidate;
  const hash = createHash("sha256").update(JSON.stringify([namespace, local])).digest("hex").slice(0, 16);
  return `tool_${local.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 24)}_${hash}`;
}
export function claudeNativeToolName(tool: OpenAITool): string { return `mcp__gateway__${claudeWireToolName(tool)}`; }

/** Only exact, unique bindings are accepted. Local names may span namespaces. */
export function claudeToolBindings(tools: OpenAITool[], readable = false): Map<string, OpenAITool | undefined> {
  const bindings = new Map<string, OpenAITool | undefined>();
  const bind = (name: string | undefined, tool: OpenAITool) => {
    if (!name) return;
    if (!bindings.has(name)) bindings.set(name, tool);
    else if (bindings.get(name) !== tool) bindings.set(name, undefined);
  };
  for (const tool of tools) {
    bind(`mcp__gateway__${legacyClaudeToolName(tool)}`, tool); bind(legacyClaudeToolName(tool), tool);
    if (readable) { bind(claudeNativeToolName(tool), tool); bind(claudeWireToolName(tool), tool); }
    bind(tool.function.name, tool); bind(tool.function.responseTool?.name, tool); bind(identity(tool), tool);
    const source = tool.function.responseTool;
    if (source?.namespace && source.namespace !== "functions") {
      // The SDK's ToolName display and the traditional MCP spelling are exact
      // representations of this declared identity, never prefix stripping.
      bind(`${source.namespace}${source.name}`, tool);
      bind(`mcp__${source.namespace}__${source.name}`, tool);
    }
  }
  return bindings;
}

/** Tool arguments, call IDs, results and message content remain byte-for-byte intact. */
export function claudeToolHistory(messages: OpenAIChatMessage[], tools: OpenAITool[]): OpenAIChatMessage[] {
  const bindings = claudeToolBindings(tools, true);
  const translate = (name: string) => { const tool = bindings.get(name); return tool ? claudeNativeToolName(tool) : name; };
  return messages.map(message => ({ ...message,
    ...(message.name ? { name: translate(message.name) } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls.map(call => ({ ...call, function: { ...call.function, name: translate(call.function.name) } })) } : {}),
  }));
}
