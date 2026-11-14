import { ProviderError } from "./provider.js";

/** Fixed structural reasons only. Tool names, namespaces and arguments never enter diagnostics. */
export const toolIdentityReasons = ["missing_tool_name", "unknown_wire_tool", "unexpected_tool_namespace", "undeclared_tool"] as const;
export type ToolIdentityReason = typeof toolIdentityReasons[number];

/**
 * Fixed structural labels for the unambiguous fallbacks that restore a returned tool name which is not the exact wire name.
 * A fallback never selects a tool outside the declared catalog; it only recognizes the caller-visible spelling of one.
 */
export const toolIdentityFallbacks = ["alias", "namespaced_alias", "functions_prefix", "wire_case"] as const;
export type ToolIdentityFallback = typeof toolIdentityFallbacks[number];

const fallbackCounts = new Map<ToolIdentityFallback, number>();
/** Counts only; no tool name, namespace or argument is recorded. Process-local and reset on restart. */
export function recordToolIdentityFallback(kind: ToolIdentityFallback): void { fallbackCounts.set(kind, (fallbackCounts.get(kind) ?? 0) + 1); }
export function toolIdentityFallbackCounts(): Record<ToolIdentityFallback, number> {
  return Object.fromEntries(toolIdentityFallbacks.map(kind => [kind, fallbackCounts.get(kind) ?? 0])) as Record<ToolIdentityFallback, number>;
}
export function resetToolIdentityFallbackCounts(): void { fallbackCounts.clear(); }

const messages: Record<ToolIdentityReason, string> = {
  missing_tool_name: "Provider tool identity failure: the returned tool name is missing or invalid",
  unknown_wire_tool: "Provider tool identity failure: the returned tool name does not match a declared transport tool",
  unexpected_tool_namespace: "Provider tool identity failure: the returned tool has an unexpected namespace",
  undeclared_tool: "Provider tool identity failure: the returned tool does not match this chat's available tools",
};

export function toolIdentityFailure(reason: ToolIdentityReason): ProviderError {
  return new ProviderError("tool_identity_failure", messages[reason], 502, { code: reason });
}
