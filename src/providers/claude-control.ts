import { randomUUID } from "node:crypto";
import type { OpenAITool } from "../protocol/types.js";
import { claudeEnvironment } from "./claude-environment.js";
import { claudeToolName } from "./claude-tool-names.js";
import { canonicalSchema } from "./tool-catalog.js";

/** Part of the prompt-cache identity: any change rewrites every Claude chat's cache once. */
export const gatewaySystemPrompt = "You are an inference backend. Use only supplied gateway MCP tools for caller-dispatched actions. The caller executes them and supplies results in the conversation. You cannot execute native tools. Respect system/developer messages in the supplied conversation. Never print invented tool-call JSON or XML; use actual tools. Otherwise answer normally.";
/** The CLI's system prompt: the gateway's fixed text, then the caller's leading system and developer content unchanged. */
export function claudeSystemPrompt(caller: string[]): string { return [gatewaySystemPrompt, ...caller.filter(Boolean)].join("\n\n"); }
/** The CLI cuts MCP tool descriptions longer than this (2.1.293: CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH, default 2048, no upper bound). */
const defaultDescriptionLimit = 2048;

export interface ClaudeCliOptions {
  mcpPath: string;
  /** A private file holding claudeSystemPrompt; a file keeps caller instructions out of the process list and argv limits. */
  systemPath: string;
  /** The CLI model id (claudeCliModel). */
  model: string;
  effort?: string;
  fast: boolean;
  /** Ask for summarized thinking text; applies only with an effort. */
  thinkingDisplay: boolean;
  live?: boolean;
}

/**
 * Flags for one gateway CLI process. Both modes allow only the gateway's MCP
 * tools: an allowed caller call waits on the gateway server (which never answers
 * in one-shot mode), whereas a denied one is answered with an error and the CLI
 * immediately posts a follow-up request. The allowlist leaves the cached prompt unchanged.
 */
export function claudeCliArgs({ mcpPath, systemPath, model, effort, fast, thinkingDisplay }: ClaudeCliOptions): string[] {
  const settings = { ...(effort ? { alwaysThinkingEnabled: true } : {}), ...(fast ? { fastMode: true } : {}) };
  return ["--restricted", "--setting-sources", "", "--disable-slash-commands", "--print", "--tools", "", "--strict-mcp-config", "--mcp-config", mcpPath,
    "--model", model, "--no-session-persistence", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    "--system-prompt-file", systemPath,
    ...(effort ? ["--effort", effort] : []),
    "--input-format", "stream-json",
    ...(Object.keys(settings).length ? ["--settings", JSON.stringify(settings)] : []),
    // Newer Claude models default to omitting thinking text; ask for summaries
    // unless the caller turned them off, so long Max turns show progress.
    ...(effort && thinkingDisplay ? ["--thinking-display", "summarized"] : []),
    "--allowedTools", "mcp__gateway",
  ];
}

/**
 * `requestedEffort` is the caller's raw effort: any value lets it replace an inherited thinking budget.
 * `catalog` is the gateway MCP catalog; its descriptions reach the model whole.
 */
export function claudeEnv(authDirectory: string | undefined, live = false, requestedEffort?: unknown, catalog: ClaudeMcpTool[] = []): NodeJS.ProcessEnv {
  const env = claudeEnvironment(authDirectory);
  // This virtual catalog is the only action surface on both paths: it finishes loading before inference,
  // with no deferred search/wait tools, no server-side advisor and no description cut.
  Object.assign(env, { MCP_CONNECTION_NONBLOCKING: "0", CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1", ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: String(Math.max(defaultDescriptionLimit, ...catalog.map(tool => tool.description.length))) });
  if (requestedEffort !== undefined) delete env.MAX_THINKING_TOKENS;
  // A live session waits on caller tools for as long as Codex takes, and Codex owns compaction.
  if (live) Object.assign(env, { CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0", MCP_TOOL_TIMEOUT: "7200000", MAX_MCP_OUTPUT_TOKENS: "200000", DISABLE_AUTO_COMPACT: "1" });
  return env;
}

export interface ClaudeMcpTool { name: string; description: string; inputSchema: Record<string, unknown> }
/** The private MCP catalog. Its bytes depend only on the caller catalog, so forced choices keep the cached tool prefix. */
export function claudeMcpCatalog(tools: OpenAITool[]): ClaudeMcpTool[] {
  return tools.map(tool => ({
    name: claudeToolName(tool), description: `Caller tool ${tool.function.name}. ${tool.function.description || ""}`,
    inputSchema: canonicalSchema(tool.function.parameters || { type: "object", properties: {} }) as Record<string, unknown>,
  })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** One newline-terminated stream-json control request. */
export function controlLine(subtype: string, fields: Record<string, unknown> = {}): { requestId: string; line: string } {
  const requestId = `gw-${randomUUID()}`;
  return { requestId, line: JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype, ...fields } }) + "\n" };
}

/** One newline-terminated stream-json user message. */
export function userLine(content: Array<Record<string, unknown>>, uuid: string = randomUUID()): string {
  return JSON.stringify({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content }, uuid }) + "\n";
}

/** The CLI's answer to control request `requestId`, if `message` is that answer. */
export function controlResult(message: Record<string, unknown>, requestId: string): "success" | "error" | undefined {
  if (message.type !== "control_response" || !message.response || typeof message.response !== "object") return;
  const response = message.response as { subtype?: unknown; request_id?: unknown };
  if (response.request_id !== requestId) return;
  return response.subtype === "success" || response.subtype === "error" ? response.subtype : undefined;
}
