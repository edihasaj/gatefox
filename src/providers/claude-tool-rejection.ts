import type { OpenAITool } from "../protocol/types.js";
import { claudeNativeToolName, claudeToolBindings } from "./claude-tool-names.js";

/** Fixed categories only. Never retain the rejected name, namespace, arguments or prompt. */
export function claudeToolNameCategory(name: unknown, tools: OpenAITool[]): string {
  if (name === undefined || name === null) return "missing_name";
  if (typeof name !== "string") return "nonstring_name";
  if (!name) return "empty_name";
  if (tools.some(tool => claudeNativeToolName(tool) === name)) return "registered_native_name";
  const bindings = claudeToolBindings(tools, true);
  if (bindings.get(name)) return "declared_caller_alias";
  if (bindings.has(name)) return "ambiguous_caller_alias";
  if (/^(?:mcp__gateway__)?tool_\d+$/.test(name)) return "retired_numeric_alias";
  if (name.startsWith("mcp__gateway__")) return "undeclared_gateway_name";
  if (["Glob", "Grep", "LS"].includes(name)) return "native_file_search";
  if (["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name)) return "native_file_tool";
  if (["Bash", "PowerShell", "REPL"].includes(name)) return "native_command_tool";
  if (["Agent", "Task", "Skill", "AskUserQuestion", "TodoWrite"].includes(name)) return "native_agent_tool";
  if (["WebSearch", "WebFetch"].includes(name)) return "native_web_tool";
  if (["ToolSearch", "MCPSearch", "WaitForMcpServers"].includes(name)) return "native_catalog_helper";
  if (["multi_tool_use.parallel", "multi_tool_use", "parallel"].includes(name)) return "parallel_wrapper";
  return "unrecognized_name";
}
