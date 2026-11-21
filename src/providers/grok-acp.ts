import { AcpConnection as SharedAcpConnection, acpObject, type AcpHandlers, type AcpOptions } from "./acp-connection.js";

/**
 * The ACP connection to `grok agent stdio`: the shared client (see acp-connection.ts) with Grok's name in its fixed
 * error prose and its `_x.ai/*` extension methods. It never logs frames: they carry prompts, tool arguments and results.
 */
export { AcpError, type AcpHandlers, type AcpOptions } from "./acp-connection.js";
export class AcpConnection extends SharedAcpConnection {
  constructor(options: AcpOptions, handlers: AcpHandlers) { super(options, handlers, "Grok", ["_x.ai/"]); }
}

const object = acpObject;

/**
 * The agent profile is mandatory: without it the CLI ran built-in tools without asking. It allows only the
 * two MCP helper tools and names every built-in as disallowed. The body is the CLI's system prompt.
 */
export function grokProfile(system: string, builtinTools: readonly string[]): string {
  return ["---", "name: gateway-inference", "description: Inference backend only; caller tools only.", "tools:", "  - search_tool", "  - use_tool", "disallowedTools:",
    ...builtinTools.map(name => `  - ${name}`), "---", system, ""].join("\n");
}

/** `grok agent` arguments. `--always-approve` is never passed: every permission goes through the gateway. */
export function grokLiveArgs(profilePath: string, model: string, effort?: string): string[] {
  return ["agent", "--no-leader", "--agent-profile", profilePath, "-m", model, ...(effort ? ["--reasoning-effort", effort] : []), "stdio"];
}

/** The gateway's one MCP server and its local helper name for search_tool. */
export const grokMcpPrefix = "gateway__";

/**
 * Answers one `session/request_permission`: allow once only a `use_tool` naming a gateway tool of the caller's
 * catalog (or the `search_tool` helper); reject everything else. `allow_always` is never chosen.
 */
export function grokPermission(params: Record<string, unknown>, catalog: ReadonlySet<string>): { allowed: boolean; result: Record<string, unknown> } {
  const raw = object(object(params.toolCall).rawInput);
  const name = typeof raw.tool_name === "string" ? raw.tool_name : "";
  const allowed = (raw.variant === "UseTool" && name.startsWith(grokMcpPrefix) && catalog.has(name.slice(grokMcpPrefix.length))) || raw.variant === "SearchTool";
  const options = (Array.isArray(params.options) ? params.options : []).map(object);
  const pick = allowed ? options.find(option => option.kind === "allow_once")
    : options.find(option => option.kind === "reject_once") ?? options.find(option => typeof option.kind === "string" && option.kind.startsWith("reject"));
  return { allowed: allowed && !!pick, result: { outcome: pick && typeof pick.optionId === "string" ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } } };
}
