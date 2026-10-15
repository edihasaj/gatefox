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
 * off until tool_search passes through. comp_hash is never copied. The review fields (node_repl
 * policy, guardian, auto_review_model_override, requires_sandboxed_review) follow the native row too.
 * Without a marker or a native row for that slug the row stays as the gateway published it here;
 * snapshot() then gives it nodeReplFallback(), which replaces the two node_repl fields.
 */
export function withNativeRow(model: Row, native: readonly Row[], codeMode = true): Row {
  const { [upstreamSlugField]: upstream, ...row } = model;
  const source = typeof upstream === "string" ? native.find(entry => entry.slug === upstream) : undefined;
  if (!source) return row;
  const copy: Row = { ...nodeReplPolicy(source) };
  // The review fields shape the same review as the node_repl policy, so a native row's value is
  // not left to drift from the Codex 2 row's. Only plainly typed values are copied.
  if (source.guardian === null || plain(source.guardian)) copy.guardian = structuredClone(source.guardian);
  if (typeof source.auto_review_model_override === "string" || source.auto_review_model_override === null) copy.auto_review_model_override = source.auto_review_model_override;
  if (typeof source.requires_sandboxed_review === "boolean") copy.requires_sandboxed_review = source.requires_sandboxed_review;
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

/**
 * Whether a gateway executor can run the auto review that node_repl actions need. Review runs a
 * reviewer model through the executor's own provider, which is the gateway; the SDK asks it for
 * "codex-auto-review" (the preferred reviewer in the native catalog), and the gateway answers that
 * name with 404 model_not_found unless one Codex subscription alias serves it. Review errors fail
 * closed, so every node_repl action that needs review would be rejected. Routing that slug is a
 * privacy decision (a Claude or Copilot transcript would reach an OpenAI reviewer), so it stays off.
 */
export const executorRunsAutoReview = false;

export interface NodeReplPolicy { node_repl_disabled: boolean; node_repl_auto_review_required: boolean; requires_sandboxed_review?: true }

/**
 * Mirrors ModelInfo::computer_use_review_required: a guardian policy, when present, overrides the
 * flag. A flag that is not plainly a boolean counts as requiring review when strict, as the SDK's
 * own default (no review) otherwise.
 */
export function computerUseReviewRequired(row: Row, strict = true): boolean {
  if (row.guardian !== undefined && row.guardian !== null) {
    const guardian = plain(row.guardian);
    // An unparseable policy cannot be shown to skip review, so it counts as requiring it.
    if (!guardian) return true;
    return guardian.computer_use !== undefined && guardian.computer_use !== null && guardian.computer_use !== "disabled";
  }
  return strict ? row.node_repl_auto_review_required !== false : row.node_repl_auto_review_required === true;
}

/**
 * One row's node_repl policy. A field that is not plainly a boolean gets the stricter value. The
 * auto review flag is the row's own. node_repl is off when the row turns it off, and also when the
 * row needs review in an executor that cannot run it, so no action waits on a reviewer that fails.
 */
export function nodeReplPolicy(row: Row): NodeReplPolicy {
  const off = typeof row.node_repl_disabled === "boolean" ? row.node_repl_disabled : true;
  return {
    node_repl_disabled: off || (!executorRunsAutoReview && computerUseReviewRequired(row)),
    node_repl_auto_review_required: typeof row.node_repl_auto_review_required === "boolean" ? row.node_repl_auto_review_required : true,
  };
}

/**
 * The node_repl policy for a row with no native counterpart (Claude, Copilot, API, or a Codex row whose
 * upstream is missing). It is never weaker than any native row: node_repl stays disabled when any native
 * row's effective policy disables it, auto review is required when any native row requires it, and a
 * sandboxed-review requirement carries over. With no native rows both are true. These rows also receive
 * none of a native row's model messages or guardian settings; with node_repl disabled they have no
 * computer-use action to review, so the strictest policy needs neither.
 */
export function nodeReplFallback(native: readonly Row[]): NodeReplPolicy {
  const policies = native.map(nodeReplPolicy);
  return {
    node_repl_disabled: !native.length || policies.some(policy => policy.node_repl_disabled),
    node_repl_auto_review_required: !native.length || policies.some(policy => policy.node_repl_auto_review_required),
    ...(native.some(entry => entry.requires_sandboxed_review === true) ? { requires_sandboxed_review: true as const } : {}),
  };
}

/**
 * A native row carried into the executor catalog keeps its own values, except that node_repl is off
 * where the row requires review the executor cannot run. A row that states no policy keeps the SDK default.
 */
export function executorNativeRow(model: Row): Row {
  return !executorRunsAutoReview && model.node_repl_disabled !== true && computerUseReviewRequired(model, false) ? { ...model, node_repl_disabled: true } : model;
}
