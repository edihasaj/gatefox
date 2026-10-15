/**
 * The model the SDK asks for when a gateway executor reviews a node_repl action. It is the SDK's
 * DEFAULT_APPROVAL_REVIEW_PREFERRED_MODEL (model-provider/src/provider.rs). A provider returns the
 * API-key reviewer only when auth is cached on the turn provider, and an executor's provider authenticates
 * with a command, whose AuthManager never caches auth there, so executors always ask for this slug.
 * Only slugs listed here are ever served as a reviewer; the SDK writes the review text itself.
 */
export const autoReviewModels = ["codex-auto-review"] as const;
const allowed: ReadonlySet<string> = new Set(autoReviewModels);
/** The fixed number of slugs an advertisement may list. */
const maxAdvertised = 8;

export const isAutoReviewModel = (model: unknown): model is (typeof autoReviewModels)[number] => typeof model === "string" && allowed.has(model);

/**
 * The desktop adapter's reading of the inference host's `auto_review` field in /v1/model-catalog:
 * a plain object whose `models` array has at most eight strings. Only allowlisted slugs are kept;
 * anything else (an older host, another shape, too many entries) gives the empty set.
 */
export function readAutoReviewAdvertisement(value: unknown): ReadonlySet<string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return new Set();
  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models) || models.length > maxAdvertised || models.some(model => typeof model !== "string")) return new Set();
  return new Set(models.filter(isAutoReviewModel));
}
