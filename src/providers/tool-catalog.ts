import type { OpenAITool } from "../protocol/types.js";
import { claudeToolName } from "./claude-tool-names.js";

/** JSON object order has no schema meaning. Array order and scalar values stay exact. */
export function canonicalSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSchema);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonicalSchema(item)]));
  return value;
}

/** Stable translated tool positions keep equivalent caller catalogs on the same cached prefix. */
export function canonicalTools(tools: OpenAITool[]): OpenAITool[] {
  return tools.map(tool => ({ ...tool, function: { ...tool.function,
    parameters: canonicalSchema(tool.function.parameters || { type: "object", properties: {} }) as Record<string, unknown>,
  } })).sort((a, b) => {
    const left = claudeToolName(a), right = claudeToolName(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
