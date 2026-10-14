import { accessSync, constants, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Row = Record<string, unknown>;

/** Codex 2 rows name the upstream model they serve, so the desktop adapter can find that model's row in its own native catalog. */
export const upstreamSlugField = "upstream_slug";
// These say whether Codex adds its own skills, plugin and apps guidance; a native template that already holds it turns them off.
const usageFlags = ["include_skills_usage_instructions", "include_plugin_usage_instructions", "include_apps_usage_instructions"];

const plain = (value: unknown): Row | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const positive = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max;

/**
 * Codex runs code mode in a host it spawns from beside its own executable. Gateway executors run the
 * packaged gateway SDK when the package has one, and that package ships no host; without it they run
 * the desktop's own Codex, which does. A code-mode row on an executor without the host fails closed.
 */
export function executorRunsCodeMode(packageDirectory = fileURLToPath(new URL("..", import.meta.url))): boolean {
  const directory = resolve(packageDirectory, "gateway-sdk");
  try { lstatSync(directory); } catch { return true; }
  try { accessSync(resolve(directory, "codex-code-mode-host"), constants.X_OK); return true; } catch { return false; }
}

/**
 * The client's own native row supplies a Codex 2 row's harness behaviour: its instructions and
 * messages with their usage flags, tool mode (a code mode only where the executor runs it),
 * defaults, window share and truncation. Account capabilities keep the upstream values: service
 * tiers, multi-agent fields, the window maximum and auto-compaction limit, and search, which stays
 * off until tool_search passes through. comp_hash is never copied.
 * Without a marker or a native row for that slug the row stays as the gateway published it.
 */
export function withNativeRow(model: Row, native: readonly Row[], codeMode = true): Row {
  const { [upstreamSlugField]: upstream, ...row } = model;
  // node_repl (browser, Chrome, computer use) runs through the code-mode host; without it the tool stays off.
  if (!codeMode) row.node_repl_disabled = true;
  const source = typeof upstream === "string" ? native.find(entry => entry.slug === upstream) : undefined;
  if (!source) return row;
  const copy: Row = {};
  if (codeMode && typeof source.node_repl_disabled === "boolean") copy.node_repl_disabled = source.node_repl_disabled;
  const messages = plain(source.model_messages);
  // The usage flags travel with the template; the gateway's own would repeat guidance the template holds.
  if (messages) { copy.model_messages = structuredClone(messages); for (const key of usageFlags) if (typeof source[key] === "boolean") copy[key] = source[key]; }
  for (const key of ["shell_type", "default_reasoning_summary"]) if (typeof source[key] === "string") copy[key] = source[key];
  if (typeof source.tool_mode === "string" && (codeMode || source.tool_mode === "direct")) copy.tool_mode = source.tool_mode;
  for (const key of ["apply_patch_tool_type", "default_verbosity"]) if (typeof source[key] === "string" || source[key] === null) copy[key] = source[key];
  if (typeof source.support_verbosity === "boolean") copy.support_verbosity = source.support_verbosity;
  // The default must be a level this route offers; Codex would otherwise start chats at an unsupported effort.
  const levels = Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels.map(level => plain(level)?.effort) : [];
  if (typeof source.default_reasoning_level === "string" && levels.includes(source.default_reasoning_level)) copy.default_reasoning_level = source.default_reasoning_level;
  if (positive(source.effective_context_window_percent, 100)) copy.effective_context_window_percent = source.effective_context_window_percent;
  const policy = plain(source.truncation_policy);
  if (policy && typeof policy.mode === "string" && positive(policy.limit)) copy.truncation_policy = { mode: policy.mode, limit: policy.limit };
  // A native window applies only within the maximum the upstream itself reports.
  if (positive(source.context_window) && positive(row.max_context_window) && source.context_window <= row.max_context_window) copy.context_window = source.context_window;
  return { ...row, ...copy };
}

/** A row with no native counterpart (Claude, Copilot, API) enables node_repl only where every native row does and the executor runs code mode. */
export function nodeReplFallback(native: readonly Row[], codeMode: boolean): boolean {
  return !codeMode || !native.length || native.some(entry => entry.node_repl_disabled !== false);
}
