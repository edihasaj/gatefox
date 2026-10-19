import { createHash } from "node:crypto";
import { nativeTools, type NativeTool } from "./copilot-render.js";

export interface SessionParams { model: string; effort?: string; summary: unknown; catalog: NativeTool[]; system: string }

/**
 * Everything `session.create` takes except the session id and the two directories. One builder serves the
 * one-shot and the live path, so the confinement (no native tools, no discovery, no store, no BYOK) cannot differ.
 */
export function sessionParams({ model, effort, summary, catalog, system }: SessionParams): Record<string, unknown> {
  return {
    model, allowedModels: [model], streaming: true, ...(effort ? { reasoningEffort: effort } : {}),
    reasoningSummary: summary === "none" ? "none" : summary === "detailed" ? "detailed" : "concise",
    tools: nativeTools(catalog), availableTools: catalog.map(({ name }) => name),
    // Only the caller's tools exist, and none is hidden behind the CLI's own tool search (it could call one itself).
    toolSearch: { enabled: false },
    systemMessage: { mode: "replace", content: system },
    enableConfigDiscovery: false, enableSkills: false, enableFileHooks: false, enableHostGitOperations: false, enableSessionStore: false,
    mcpServers: {}, pluginDirectories: [], customAgents: [], infiniteSessions: { enabled: false },
    memory: { enabled: false }, requestPermission: true, requestUserInput: false,
    // Past about 50 KB the CLI saves a tool result to a file in the OS temp folder and shows the model its path. The model
    // has no file tools, and the result must not leave the session's private directory, so results always stay inline.
    largeOutput: { enabled: false },
  };
}

/**
 * The session's identity: a change in any of these needs a new process, because the CLI fixes them at creation.
 * The effort value itself can change in place (`session.model.switchTo`), but whether one is set cannot.
 */
export function sessionFingerprint(params: Record<string, unknown>): string {
  const { reasoningEffort, ...fixed } = params;
  return createHash("sha256").update(JSON.stringify({ ...fixed, effortSet: reasoningEffort !== undefined })).digest("hex");
}
