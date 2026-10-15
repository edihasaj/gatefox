import { createHash } from "node:crypto";
import type { OpenAITool } from "../protocol/types.js";

/** The one-shot system message. The caller's instructions travel inside the conversation it receives. */
export const oneShotSystem = "You are an inference backend. Respect system/developer messages in the supplied conversation. Use only supplied caller-dispatched tools. The caller executes actions and supplies results. Never execute native tools, spawn agents, or invent tool-call text. Otherwise answer normally.";

/**
 * The live session's system message. It is fixed for the session's life, so the caller's leading
 * system and developer content and the tool names live here, and the history arrives as user messages.
 */
export function liveSystem(caller: string[], tools: OpenAITool[]): string {
  const aliases = tools.map((tool, index) => ({ caller: tool.function.name, native: `gateway_tool_${index}` }));
  return [
    "You are an inference backend. Respect the caller instructions below and any system/developer items in the conversation. Use only supplied caller-dispatched tools. The caller executes actions and supplies results. Never execute native tools, spawn agents, or invent tool-call text. Otherwise answer normally.",
    `Tool names: ${JSON.stringify(aliases)}`,
    "Conversation items arrive as user messages, oldest first, one item per message. Each message starts with an <<item>> header line and ends with a <</item>> line; everything between them is the item's exact content. Results of your tool calls arrive as tool results.",
    ...caller.filter(Boolean).map((text, index) => index === 0 ? `Caller instructions:\n${text}` : text),
  ].join("\n\n");
}

/** The tools as the CLI sees them: neutral names, so the caller's own names never collide with a native tool. */
export function nativeTools(tools: OpenAITool[], skipPermission: boolean) {
  return tools.map((tool, index) => ({ name: `gateway_tool_${index}`, description: `Caller tool ${tool.function.name}. ${tool.function.description || ""}`,
    parameters: tool.function.parameters || { type: "object", properties: {} }, ...(skipPermission ? { skipPermission: true } : {}) }));
}

export interface SessionParams { model: string; effort?: string; summary: unknown; tools: OpenAITool[]; system: string; live: boolean }

/**
 * Everything `session.create` takes except the session id and the two directories. One builder serves both
 * paths, so the confinement (no native tools, no discovery, no store, no BYOK) cannot differ between them.
 */
export function sessionParams({ model, effort, summary, tools, system, live }: SessionParams): Record<string, unknown> {
  return {
    model, allowedModels: [model], streaming: true, ...(effort ? { reasoningEffort: effort } : {}),
    reasoningSummary: summary === "none" ? "none" : summary === "detailed" ? "detailed" : "concise",
    tools: nativeTools(tools, live), availableTools: tools.map((_, index) => `gateway_tool_${index}`),
    systemMessage: { mode: "replace", content: system },
    enableConfigDiscovery: false, enableSkills: false, enableFileHooks: false, enableHostGitOperations: false, enableSessionStore: false,
    mcpServers: {}, pluginDirectories: [], customAgents: [], infiniteSessions: { enabled: false },
    memory: { enabled: false }, requestPermission: true, requestUserInput: false,
    // Past about 50 KB the CLI saves a tool result to a file in the OS temp folder and shows the model its path. The model
    // has no file tools, and the result must not leave the session's private directory, so results always stay inline.
    ...(live ? { largeOutput: { enabled: false } } : {}),
  };
}

/** The session's identity: a change in any of these needs a new process, because the CLI fixes them at creation. */
export function sessionFingerprint(params: Record<string, unknown>): string {
  const { reasoningEffort: _effort, ...fixed } = params;
  return createHash("sha256").update(JSON.stringify(fixed)).digest("hex");
}
