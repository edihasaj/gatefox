import { accessSync, constants, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { autoReviewModels } from "./auto-review.js";

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
 * off until tool_search passes through. comp_hash is never copied. The node_repl policy (both
 * fields, see nodeReplPolicy) and the review fields (guardian, auto_review_model_override,
 * requires_sandboxed_review, model_specialty) follow the native row too; requires_sandboxed_review
 * is data only, because neither the pinned SDK nor ChatGPT 26.1007's codex reads it. Without a marker or a native
 * row for that slug the row stays as the gateway published it here; snapshot() then gives it nodeReplFallback().
 * `reviewers` are the reviewer slugs the inference host advertised; with none, review cannot run.
 */
export function withNativeRow(model: Row, native: readonly Row[], codeMode = true, reviewers: ReadonlySet<string> = noReviewers): Row {
  const { [upstreamSlugField]: upstream, ...row } = model;
  const source = typeof upstream === "string" ? native.find(entry => entry.slug === upstream) : undefined;
  if (!source) return row;
  // Both node_repl fields come from the native row's policy; the review fields shape the same review,
  // so they are copied with it. Only plainly typed values are copied.
  const copy: Row = { ...nodeReplPolicy(source, native, reviewers) };
  if (source.guardian === null || plain(source.guardian)) copy.guardian = structuredClone(source.guardian);
  if (typeof source.auto_review_model_override === "string" || source.auto_review_model_override === null) copy.auto_review_model_override = source.auto_review_model_override;
  if (typeof source.requires_sandboxed_review === "boolean") copy.requires_sandboxed_review = source.requires_sandboxed_review;
  // The specialty (cyber) chooses the SDK's Guardian rejection policy and its exec-policy handling, so a reviewed row must carry it.
  if (typeof source.model_specialty === "string" || source.model_specialty === null) copy.model_specialty = source.model_specialty;
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

/** No reviewer is reachable: every row that needs review keeps node_repl off. */
export const noReviewers: ReadonlySet<string> = new Set();

/**
 * Which reviewer the SDK asks for on behalf of a row (select_review_model): the row's own
 * auto_review_model_override when it is a non-empty string, otherwise the default reviewer
 * "codex-auto-review", which gateway executors always get (see src/auto-review.ts). Any other
 * override value names no model, so there is no reviewer.
 */
export function reviewerFor(row: Row): string | undefined {
  const override = row.auto_review_model_override;
  if (override === undefined || override === null) return autoReviewModels[0];
  return typeof override === "string" && override ? override : undefined;
}

/**
 * Whether that reviewer runs in this executor. The inference host must advertise the slug, and the
 * executor catalog must offer its row to API-key auth (`supported_in_api` exactly true), because the
 * SDK lists models for a command-authenticated provider that way. A reviewer missing from the list
 * makes the SDK fall back to the parent model with the parent's own messages, which is not the
 * native review, so a missing or hidden reviewer row counts as unable.
 */
export function reviewRuns(row: Row, native: readonly Row[], reviewers: ReadonlySet<string>): boolean {
  const slug = reviewerFor(row);
  return slug !== undefined && reviewers.has(slug) && native.some(entry => entry.slug === slug && entry.supported_in_api === true);
}

export interface NodeReplPolicy { node_repl_disabled: boolean; node_repl_auto_review_required: boolean; requires_sandboxed_review?: true }

/**
 * Mirrors ModelInfo::computer_use_review_required: a guardian policy, when present, overrides the
 * flag, and reviews computer use unless its mode is absent, null or "disabled". A guardian that is
 * not an object, or a flag that is not plainly a boolean, cannot be shown to skip review, so it
 * counts as requiring it.
 */
export function computerUseReviewRequired(row: Row): boolean {
  if (row.guardian !== undefined && row.guardian !== null) {
    const guardian = plain(row.guardian);
    if (!guardian) return true;
    return guardian.computer_use !== undefined && guardian.computer_use !== null && guardian.computer_use !== "disabled";
  }
  return row.node_repl_auto_review_required !== false;
}

/** A native row turns node_repl off itself unless it plainly says it is enabled. */
const rawOff = (row: Row) => typeof row.node_repl_disabled === "boolean" ? row.node_repl_disabled : true;

/**
 * One row's node_repl policy in a gateway executor. Codex 2 rows and the native rows the executor
 * catalog carries for sub-agents both use it, so one upstream model gets one policy there, as the
 * native row has it. Each field is copied; one that is not plainly a boolean gets the stricter value.
 * Two things are stricter than a copy. node_repl is also off when the row needs review and its
 * reviewer does not run in this executor, so no action waits on a reviewer that fails. And a guardian
 * that is not an object is never copied to a Codex 2 row, so the flag alone must then require review.
 */
export function nodeReplPolicy(row: Row, native: readonly Row[], reviewers: ReadonlySet<string> = noReviewers): NodeReplPolicy {
  const flag = typeof row.node_repl_auto_review_required === "boolean" ? row.node_repl_auto_review_required : true;
  const unreadable = row.guardian !== undefined && row.guardian !== null && !plain(row.guardian);
  return {
    node_repl_disabled: rawOff(row) || (computerUseReviewRequired(row) && !reviewRuns(row, native, reviewers)),
    node_repl_auto_review_required: flag || unreadable,
  };
}

/** The review texts of a row that a Claude, Copilot or API row can share (see sharedReviewMessages). */
const sharedMessageKeys = ["confirmation_policies", "guardian_v2"] as const;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry as Row).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry);

/**
 * The confirmation and classifier texts the native rows share. A value present on several rows must be
 * the same on all of them, compared as canonical JSON, or the rows disagree and nothing is shared.
 * A key no row states is left out. Without the shared texts, node_repl would read an empty
 * `openai/confirmation_policies` on a row that has none, which clears the connector defaults.
 */
export function sharedReviewMessages(native: readonly Row[]): { messages: Row; conflict: boolean } {
  const messages: Row = {}; let conflict = false;
  for (const key of sharedMessageKeys) {
    const present = native.map(row => plain(row.model_messages)?.[key]).filter(value => value !== undefined && value !== null);
    if (!present.length) continue;
    if (present.some(value => canonical(value) !== canonical(present[0]))) conflict = true;
    else messages[key] = structuredClone(present[0]);
  }
  return { messages, conflict };
}

export interface NodeReplFallback extends NodeReplPolicy { review_messages: Row }
/** Any guardian value other than null, including one that is not an object. */
const guarded = (row: Row) => row.guardian !== undefined && row.guardian !== null;

/**
 * The node_repl policy for a row with no native counterpart (Claude, Copilot, Qwen, API, or a Codex
 * row whose upstream is missing). Review is always required, the strictest policy, because these rows
 * carry no guardian and their model has no native policy. node_repl is on only if the reviewer runs,
 * every native row plainly enables node_repl, no native row sets a guardian, and the native rows agree
 * on the shared review texts. A fallback row cannot mirror a guardian (its computer-use mode, scoring
 * or other scopes), so a guardian on any native row turns node_repl off here: the stricter choice.
 * requires_sandboxed_review is carried when a native row sets it, as data only: neither the pinned
 * SDK nor ChatGPT 26.1007's codex reads it. The reviewer is the default one, which is OpenAI's, so
 * the actions it reviews and their context leave the chat's own provider, as for every Auto-review
 * approval in a gateway executor (Edi's decision; see src/auto-review.ts). With no native rows node_repl is off.
 */
export function nodeReplFallback(native: readonly Row[], reviewers: ReadonlySet<string> = noReviewers): NodeReplFallback {
  const { messages, conflict } = sharedReviewMessages(native);
  return {
    node_repl_disabled: !native.length || native.some(rawOff) || native.some(guarded) || !reviewRuns({}, native, reviewers) || conflict,
    node_repl_auto_review_required: true,
    review_messages: conflict ? {} : messages,
    ...(native.some(entry => entry.requires_sandboxed_review === true) ? { requires_sandboxed_review: true as const } : {}),
  };
}

/** Applies a fallback to a gateway row: the policy fields, and the shared review texts next to its own messages. */
export function withFallback(model: Row, fallback: NodeReplFallback): Row {
  const { review_messages, ...policy } = fallback;
  const messages = plain(model.model_messages);
  return { ...model, ...policy, ...(Object.keys(review_messages).length ? { model_messages: { ...messages, ...structuredClone(review_messages) } } : {}) };
}

/**
 * A native row carried into the executor catalog keeps its own values apart from the two node_repl
 * fields, which follow nodeReplPolicy as the Codex 2 row for the same model does. A row with a plain
 * policy and a reviewer that runs keeps both; one that states no policy gets node_repl off here,
 * never the SDK default. `supports_search_tool` is also carried off on every row, as a Codex 2 row
 * has it: Codex would add its `tool_search` tool to a request on a row that says search is on, and
 * the gateway rejects that tool (see src/protocol/request.ts), so every sub-agent naming such a
 * model failed with `unsupported_tool`. A row whose policy matches and that does not plainly turn
 * search on is returned unchanged. The native engine's own catalog is unchanged.
 */
export function executorNativeRow(model: Row, native: readonly Row[], reviewers: ReadonlySet<string> = noReviewers): Row {
  const policy = nodeReplPolicy(model, native, reviewers);
  const search: Row | undefined = model.supports_search_tool === true ? { supports_search_tool: false } : undefined;
  return policy.node_repl_disabled === model.node_repl_disabled && policy.node_repl_auto_review_required === model.node_repl_auto_review_required && !search
    ? model : { ...model, ...policy, ...search };
}
