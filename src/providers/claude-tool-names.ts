import { createHash } from "node:crypto";
import type { OpenAITool, OpenAIChatMessage } from "../protocol/types.js";

const identity = (tool: OpenAITool) => {
  const source = tool.function.responseTool;
  return `${source?.namespace || "functions"}.${source?.name || tool.function.name}`;
};

/** Stable across ordering, deferral and forced-tool filtering; fits CLI name limits. */
export function claudeToolName(tool: OpenAITool): string {
  const name = identity(tool);
  const local = (tool.function.responseTool?.name || name).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 24);
  return `tool_${local}_${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}
export function claudeNativeToolName(tool: OpenAITool): string { return `mcp__gateway__${claudeToolName(tool)}`; }

/** Only exact, unique bindings are accepted. Local names may span namespaces. */
export function claudeToolBindings(tools: OpenAITool[]): Map<string, OpenAITool | undefined> {
  const bindings = new Map<string, OpenAITool | undefined>();
  const bind = (name: string | undefined, tool: OpenAITool) => {
    if (!name) return;
    if (!bindings.has(name)) bindings.set(name, tool);
    else if (bindings.get(name) !== tool) bindings.set(name, undefined);
  };
  for (const tool of tools) {
    bind(claudeNativeToolName(tool), tool); bind(claudeToolName(tool), tool);
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
  const bindings = claudeToolBindings(tools);
  const translate = (name: string) => { const tool = bindings.get(name); return tool ? claudeNativeToolName(tool) : name; };
  return messages.map(message => ({ ...message,
    ...(message.name ? { name: translate(message.name) } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls.map(call => ({ ...call, function: { ...call.function, name: translate(call.function.name) } })) } : {}),
  }));
}
