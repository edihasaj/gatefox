import type { ResponsesRequest, ResponsesTool } from "../protocol/types.js";
import { canonicalSchema } from "./tool-catalog.js";

/** Equivalent declarations have identical public Responses bytes; meaningful arrays and history retain their order. */
export function stableResponsesCatalog(request: ResponsesRequest): ResponsesRequest {
  const tools = (list: ResponsesTool[]): ResponsesTool[] => {
    const normalized = list.map(tool => canonicalSchema(tool.type === "namespace" ? { ...tool, tools: tools(tool.tools) } : tool) as ResponsesTool);
    if (!normalized.every(tool => ["function", "custom", "namespace"].includes(tool.type))) return normalized;
    const identity = (tool: ResponsesTool) => {
      const definition = tool as { name?: string; function?: { name?: string } };
      return `${tool.type}\0${definition.name ?? definition.function?.name ?? ""}`;
    };
    return normalized.sort((a, b) => identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0);
  };
  return { ...request, ...(request.tools ? { tools: tools(request.tools) } : {}),
    ...(Array.isArray(request.input) ? { input: request.input.map(item => {
      const declaration = item as unknown as { type?: string; tools?: ResponsesTool[] };
      return declaration.type === "additional_tools" && Array.isArray(declaration.tools)
        ? { ...item, tools: tools(declaration.tools) } : item;
    }) } : {}) };
}
