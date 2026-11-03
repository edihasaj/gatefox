import { ProviderError } from "./provider.js";

/** Fixed structural reasons only. Tool names, namespaces and arguments never enter diagnostics. */
export const toolIdentityReasons = ["missing_tool_name", "unknown_wire_tool", "unexpected_tool_namespace", "undeclared_tool"] as const;
export type ToolIdentityReason = typeof toolIdentityReasons[number];

const messages: Record<ToolIdentityReason, string> = {
  missing_tool_name: "Provider tool identity failure: the returned tool name is missing or invalid",
  unknown_wire_tool: "Provider tool identity failure: the returned tool name does not match a declared transport tool",
  unexpected_tool_namespace: "Provider tool identity failure: the returned tool has an unexpected namespace",
  undeclared_tool: "Provider tool identity failure: the returned tool does not match this chat's available tools",
};

export function toolIdentityFailure(reason: ToolIdentityReason): ProviderError {
  return new ProviderError("tool_identity_failure", messages[reason], 502, { code: reason });
}
