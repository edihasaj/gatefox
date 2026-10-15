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
 * off until tool_search passes through. comp_hash is never copied. The node_repl policy (both
 * fields, see nodeReplPolicy) and the review fields (guardian, auto_review_model_override,
 * requires_sandboxed_review) follow the native row too. Without a marker or a native row for that
 * slug the row stays as the gateway published it here; snapshot() then gives it nodeReplFallback().
 * The route says which reviewer models the executor's provider can serve; without one none can be.
 */
export function withNativeRow(model: Row, native: readonly Row[], codeMode = true, route: ReviewRoute = noReviewRoute): Row {
  const { [upstreamSlugField]: upstream, ...row } = model;
  const source = typeof upstream === "string" ? native.find(entry => entry.slug === upstream) : undefined;
  if (!source) return row;
  // Both node_repl fields come from the native row's policy; the review fields shape the same review,
  // so they are copied with it. Only plainly typed values are copied.
  const copy: Row = { ...nodeReplPolicy(source, route) };
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
 * The SDK reviews a node_repl action with a reviewer model that it requests from the executor's own
 * provider, which is the gateway. Gateway executors authenticate with a provider command, which the
 * SDK treats as API-key auth, and under that auth the preferred reviewer is "gpt-5.6-luna" (the
 * model-provider's API_KEY_APPROVAL_REVIEW_PREFERRED_MODEL), not "codex-auto-review". A row's own
 * auto_review_model_override replaces it. The reviewer must be in the executor's catalog, because
 * its row supplies the review text, and the gateway must be able to serve it.
 */
export const apiKeyReviewModel = "gpt-5.6-luna";
/** The reviewer row native Codex uses with ChatGPT auth; it carries the review text for node_repl. */
export const nativeReviewModel = "codex-auto-review";

/** Whether a model name is one the executor's catalog offers and the gateway serves. */
export type ReviewRoute = (model: string) => boolean;
/** The strict route: no reviewer can run, so every row that needs review keeps node_repl off. */
export const noReviewRoute: ReviewRoute = () => false;

/**
 * The reviewers an executor can use, from the native rows its catalog carries and the rows the
 * gateway published. The gateway serves a bare OpenAI model name (what the SDK requests) like
 * nativeModelAlias in server.ts: as an alias with that exact name, or as the one Codex subscription
 * alias whose upstream model it is. Only Codex rows publish upstream_slug. Two accounts serving the
 * same model make the name ambiguous, and an ambiguous name is not served.
 */
export function reviewRoute(native: readonly Row[], published: readonly Row[]): ReviewRoute {
  return model => {
    const offered = [...native, ...published].some(row => row.slug === model && row.supported_in_api !== false);
    const vendor = /^(gpt-|o\d|codex-)/.test(model);
    return offered && (published.some(row => row.slug === model) || (vendor && published.filter(row => row[upstreamSlugField] === model).length === 1));
  };
}

/**
 * Whether the reviewer the SDK would pick for a row can run: the row's auto_review_model_override
 * when one is set, otherwise the API-key reviewer. An override that is not a string cannot be shown
 * to name a model, so it counts as unable. When the reviewer is not offered the SDK would fall back to
 * the parent model, whose messages carry no reviewer policy; that counts as unable too.
 */
export function reviewerCanRun(row: Row, route: ReviewRoute): boolean {
  const override = row.auto_review_model_override;
  if (override === undefined || override === null) return route(apiKeyReviewModel);
  return typeof override === "string" && route(override);
}

const nodeReplText = (row: Row) => {
  const text = plain(plain(plain(row.model_messages)?.auto_review))?.node_repl_policy;
  return typeof text === "string" ? text : undefined;
};

/**
 * The reviewer row supplies the node_repl review text. Native Codex with ChatGPT auth reviews with
 * the hidden "codex-auto-review" row, which carries it; a catalog can leave the same text off the
 * API-key reviewer, and the SDK would then review with its bundled default instead. A reviewer row
 * that lacks the text gets the native reviewer's. Nothing else on any row changes, and a row that
 * states its own text, even an empty one, keeps it.
 */
export function withReviewerPolicy(native: readonly Row[]): Row[] {
  const donor = native.find(row => row.slug === nativeReviewModel);
  const text = donor ? nodeReplText(donor) : undefined;
  if (!text) return [...native];
  const reviewers = new Set([apiKeyReviewModel, ...native.map(row => row.auto_review_model_override).filter((name): name is string => typeof name === "string")]);
  return native.map(row => {
    const messages = plain(row.model_messages);
    const review = messages?.auto_review === undefined ? {} : plain(messages.auto_review);
    if (!messages || !review || typeof row.slug !== "string" || !reviewers.has(row.slug) || nodeReplText(row) !== undefined) return row;
    return { ...row, model_messages: { ...messages, auto_review: { ...review, node_repl_policy: text } } };
  });
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
const turnsNodeReplOff = (row: Row) => typeof row.node_repl_disabled === "boolean" ? row.node_repl_disabled : true;

/**
 * One row's node_repl policy in a gateway executor. Codex 2 rows and the native rows the executor
 * catalog carries for sub-agents both use it, so one upstream model gets one policy there, as the
 * native row has it. Each field is copied; one that is not plainly a boolean gets the stricter value.
 * Two things are stricter than a copy. node_repl is also off when the row needs review and its
 * reviewer cannot run in this executor, so no action waits on a reviewer that fails. And a guardian
 * that is not an object is never copied to a Codex 2 row, so the flag alone must then require review.
 */
export function nodeReplPolicy(row: Row, route: ReviewRoute = noReviewRoute): NodeReplPolicy {
  const flag = typeof row.node_repl_auto_review_required === "boolean" ? row.node_repl_auto_review_required : true;
  const unreadable = row.guardian !== undefined && row.guardian !== null && !plain(row.guardian);
  return {
    node_repl_disabled: turnsNodeReplOff(row) || (computerUseReviewRequired(row) && !reviewerCanRun(row, route)),
    node_repl_auto_review_required: flag || unreadable,
  };
}

/**
 * The node_repl policy for a row with no native counterpart (Claude, Copilot, API, or a Codex row whose
 * upstream is missing). It is never weaker than any native row. Auto review is required when any
 * native row needs review or has a flag that is not plainly false, even where that row's guardian skips
 * computer-use review, because these rows carry no guardian. node_repl is off when any native row turns
 * it off and whenever review is required. These rows are not given a reviewer: a native row's reviewer
 * is chosen for that model, and for a Claude, Copilot or API chat it would be an OpenAI model that
 * receives the transcript. A sandboxed-review requirement carries over. With no native rows both are
 * true. With node_repl off these rows have no action to review, so they need neither a native row's
 * model messages nor its guardian settings.
 */
export function nodeReplFallback(native: readonly Row[]): NodeReplPolicy {
  const review = !native.length || native.some(row => computerUseReviewRequired(row) || nodeReplPolicy(row).node_repl_auto_review_required);
  return {
    node_repl_disabled: review || native.some(turnsNodeReplOff),
    node_repl_auto_review_required: review,
    ...(native.some(entry => entry.requires_sandboxed_review === true) ? { requires_sandboxed_review: true as const } : {}),
  };
}

/**
 * A native row carried into the executor catalog keeps its own values apart from the two node_repl
 * fields, which follow nodeReplPolicy as the Codex 2 row for the same model does. A row with a plain
 * policy and a reviewer that runs keeps both; one that states no policy gets node_repl off here,
 * never the SDK default. The native engine's own catalog is unchanged.
 */
export function executorNativeRow(model: Row, route: ReviewRoute = noReviewRoute): Row {
  const policy = nodeReplPolicy(model, route);
  return policy.node_repl_disabled === model.node_repl_disabled && policy.node_repl_auto_review_required === model.node_repl_auto_review_required ? model : { ...model, ...policy };
}
