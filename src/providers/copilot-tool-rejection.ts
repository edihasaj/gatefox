import type { OpenAITool } from "../protocol/types.js";
import { claudeToolBindings } from "./claude-tool-names.js";

/** Fixed diagnostic categories only: never return a provider's tool name or arguments. */
export function copilotUnknownNameClass(name: unknown, tools: Iterable<OpenAITool>): string {
  if (name === undefined) return "missing";
  if (typeof name !== "string") return "non_string";
  if (!name) return "empty";
  const bindings = claudeToolBindings([...tools]);
  if (bindings.has(name)) return bindings.get(name) ? "declared_alias" : "ambiguous_alias";
  if (/^tool_[A-Za-z0-9_]+_[a-f0-9]{16}$/.test(name)) return "undeclared_native_shape";
  return "undeclared";
}
