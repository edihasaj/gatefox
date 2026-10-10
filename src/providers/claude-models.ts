import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderConfig } from "../config.js";
import type { DiscoveredModel } from "../catalog.js";
import { claudeEnvironment } from "./claude-environment.js";

// Current native 1M models: https://platform.claude.com/docs/en/models/overview.
const millionTokenModels = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);

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
    models.push({ model, metadata: { displayName: item.displayName,
      ...(millionTokenModels.has(model) ? { contextWindow: 1000000 } : {}),
      reasoningEfforts: item.supportsEffort === true && Array.isArray(efforts) ? efforts : [], priority: models.length,
    } });
  }
  if (!models.length) throw new Error("Claude returned no selectable models");
  return models;
}

/** Agent SDK initialize is metadata-only: no user prompt or inference request. */
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
  const lines = createInterface({ input: child.stdout });
  child.stdin.write(JSON.stringify({ type: "control_request", request_id: "gateway-models", request: { subtype: "initialize", hooks: null } }) + "\n");
  try {
    for await (const line of lines) {
      if (failure) throw failure;
      let parsed: unknown;
      try { parsed = JSON.parse(line); }
      catch { throw new Error("Claude model discovery returned invalid JSON"); }
      const message = parsed as { type?: string; response?: { subtype?: string; request_id?: string; response?: { models?: unknown } } };
      if (message.type !== "control_response" || message.response?.request_id !== "gateway-models") continue;
      if (message.response.subtype !== "success") throw new Error("Claude model discovery failed; run gateway doctor");
      return nativeClaudeModels(message.response.response?.models);
    }
    throw failure || new Error("Claude model discovery ended without a catalog");
  } finally {
    clearTimeout(timer); child.stdout.off("data", countOutput); lines.close(); child.stdin.end();
    stop(); await exited; clearTimeout(hardStop);
  }
}

export async function discoverClaudeModels(provider: ProviderConfig): Promise<DiscoveredModel[]> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-models-"));
  try {
    const child = spawn("claude", ["--restricted", "--setting-sources", "", "--disable-slash-commands", "--print", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--no-session-persistence", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    { cwd: directory, env: claudeEnvironment(provider.authDirectory), stdio: ["pipe", "pipe", "pipe"] });
    return await readClaudeModels(child);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
