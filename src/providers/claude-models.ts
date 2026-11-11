import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderConfig } from "../config.js";
import type { DiscoveredModel } from "../catalog.js";
import { claudeEnvironment } from "./claude-environment.js";
import { providerCommand } from "../provider-tool-runtime.js";
import { releasedAtMetadata } from "../model-auto-latest/metadata.js";

// Context windows the Claude CLI reports (result modelUsage.contextWindow) on a
// subscription, measured 2026-10-13 and 2026-11-11. These run with 1M under their plain IDs.
const millionTokenModels = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5",
  "claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7", "claude-mythos-5-1"]);
// These reach 1M only through the CLI's "[1m]" variant, which the subscription
// includes. CLI 2.1.299 does not yet recognize Fable 5.2 and runs its plain ID
// at 200K. Sonnet 4.6's variant needs paid usage credits and is not used; Haiku
// 4.5 has no 1M variant (the CLI silently runs a different model for it).
export const longContextVariants = new Set(["claude-opus-4-6", "claude-fable-5-2"]);
/** The model ID the CLI runs; aliases keep the plain ID so saved chats survive. */
export function claudeCliModel(model: string): string { return longContextVariants.has(model) ? `${model}[1m]` : model; }
/** Claude Code's fast mode, offered under Codex's Fast tier for models whose catalog row supports it. */
export const claudeFastTier = { id: "priority", name: "Fast", description: "Faster output, billed to Claude usage credits" };

export function nativeClaudeModels(value: unknown): DiscoveredModel[] {
  if (!Array.isArray(value) || !value.length) throw new Error("Claude returned an invalid model catalog");
  const models: DiscoveredModel[] = []; const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") throw new Error("Claude returned an invalid model entry");
    const item = entry as Record<string, unknown>;
    if (item.value === "default") continue;
    const model = item.resolvedModel || item.value;
    if (typeof model !== "string" || !model || typeof item.displayName !== "string" || !item.displayName) throw new Error("Claude returned an invalid model identity");
    if (seen.has(model)) continue;
    seen.add(model);
    const efforts = item.supportedEffortLevels;
    if (efforts !== undefined && (!Array.isArray(efforts) || efforts.some(effort => !["low", "medium", "high", "xhigh", "max"].includes(effort)))) throw new Error("Claude returned invalid reasoning levels");
    const levels: string[] = item.supportsEffort === true && Array.isArray(efforts) ? efforts : [];
    models.push({ model, metadata: { displayName: item.displayName,
      ...releasedAtMetadata(item),
      inputModalities: item.supportsVision === false ? ["text"] : ["text", "image"],
      // Every current Claude model has at least a 200K window; unknown rows
      // otherwise fall back to 32K and compact almost every turn.
      contextWindow: millionTokenModels.has(model) || longContextVariants.has(model) ? 1000000 : 200000,
      // Codex Ultra is the top effort plus Codex's own v2 delegation. Claude's top
      // effort is max, which is what Codex sends for Ultra.
      reasoningEfforts: levels.includes("max") ? [...levels, "ultra"] : levels, priority: models.length,
      ...(levels.length ? { multiAgentVersion: "v2", multiAgentReasoningEffort: levels.includes("xhigh") ? "xhigh" : levels.at(-1)! } : {}),
      // Explicit empty tiers clear a Fast option the CLI no longer offers on refresh.
      ...(item.supportsFastMode === true ? { serviceTiers: [claudeFastTier], additionalSpeedTiers: ["fast"] } : { serviceTiers: [], additionalSpeedTiers: [] }), defaultServiceTier: null,
    } });
  }
  if (!models.length) throw new Error("Claude returned no selectable models");
  return models;
}

/**
 * Agent SDK initialize is metadata-only: no user prompt or inference request. The
 * catalog rows carry no default effort, so each model's default is read the way
 * Claude Code applies it: the session-scoped flag model, then the applied effort
 * from get_settings. Both are metadata-only too; a model without one keeps medium.
 */
export async function readClaudeModels(child: ChildProcessWithoutNullStreams, timeoutMs = 20000): Promise<DiscoveredModel[]> {
  let failure: Error | undefined;
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.once("error", () => { failure = new Error("Claude CLI unavailable; run gateway doctor"); });
  child.stdin.on("error", () => { failure ||= new Error("Claude model discovery input closed"); });
  child.stderr.resume();
  let hardStop: NodeJS.Timeout | undefined;
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    hardStop ||= setTimeout(() => child.kill("SIGKILL"), 1500).unref();
  };
  const timer = setTimeout(() => { failure = new Error("Claude model discovery timed out"); stop(); }, timeoutMs);
  let bytes = 0;
  const countOutput = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= 1024 * 1024) return;
    failure = new Error("Claude model catalog exceeds 1 MiB");
    lines.close(); child.stdout.destroy(); stop();
  };
  child.stdout.on("data", countOutput);
  const lines = createInterface({ input: child.stdout }); const reader = lines[Symbol.asyncIterator]();
  type Response = { subtype?: string; request_id?: string; response?: { models?: unknown; applied?: { model?: unknown; effort?: unknown } } };
  const control = async (id: string, request: Record<string, unknown>): Promise<Response> => {
    child.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request }) + "\n");
    for (let next = await reader.next(); !next.done; next = await reader.next()) {
      if (failure) throw failure;
      let parsed: unknown;
      try { parsed = JSON.parse(next.value); }
      catch { throw new Error("Claude model discovery returned invalid JSON"); }
      const message = parsed as { type?: string; response?: Response };
      if (message.type === "control_response" && message.response?.request_id === id) return message.response;
    }
    throw failure || new Error("Claude model discovery ended without a catalog");
  };
  try {
    const catalog = await control("gateway-models", { subtype: "initialize", hooks: null });
    if (catalog.subtype !== "success") throw new Error("Claude model discovery failed; run gateway doctor");
    const models = nativeClaudeModels(catalog.response?.models);
    // Explicitly unset, so a refresh without a level clears an older one and the row returns to medium.
    for (const { metadata } of models) metadata.defaultReasoningEffort = undefined;
    try {
      for (const [index, { model, metadata }] of models.entries()) {
        if (!metadata.reasoningEfforts?.length || (await control(`gateway-model-${index}`, { subtype: "apply_flag_settings", settings: { model } })).subtype !== "success") continue;
        const applied = (await control(`gateway-effort-${index}`, { subtype: "get_settings" })).response?.applied;
        if (applied?.model === model && typeof applied.effort === "string" && metadata.reasoningEfforts.includes(applied.effort)) metadata.defaultReasoningEffort = applied.effort;
      }
    } catch { /* Defaults are optional: the catalog stands without them. */ }
    return models;
  } finally {
    clearTimeout(timer); child.stdout.off("data", countOutput); lines.close(); child.stdin.end();
    stop(); await exited; clearTimeout(hardStop);
  }
}

export async function discoverClaudeModels(provider: ProviderConfig): Promise<DiscoveredModel[]> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-models-"));
  try {
    const command = await providerCommand("claude");
    const child = spawn(command, ["--restricted", "--setting-sources", "", "--disable-slash-commands", "--print", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--no-session-persistence", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    { cwd: directory, env: claudeEnvironment(provider.authDirectory), stdio: ["pipe", "pipe", "pipe"] });
    return await readClaudeModels(child);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
