/**
 * Bare vendor model names to subscription routes. The SDK sends a sub-agent a bare model name
 * (`gpt-5.6-terra`, `claude-opus-5-5`) with no account qualifier, and it never sends its parent
 * thread's account, so the gateway decides which subscription alias serves the name. An operator
 * designates that account with `defaultForBareModels: true` on one provider of a type — this is an
 * operator-selected default, not automatic inheritance of the parent chat's account.
 */
import type { GatewayConfig, ProviderConfig } from "./config.js";
import { isAutoReviewModel } from "./auto-review.js";

/** The subscription types whose bare vendor names an operator can route with a designated default. */
export type BareModelVendor = "claude-subscription" | "codex-subscription";

/** Which subscription type a bare vendor name belongs to, if any. */
const vendorType = (model: string): BareModelVendor | undefined =>
  /^claude-/.test(model) ? "claude-subscription" : /^(gpt-|o\d|codex-)/.test(model) ? "codex-subscription" : undefined;

/** The provider the operator designated for its type's bare names; validation allows at most one per type. */
export const designatedDefault = (config: GatewayConfig, type: BareModelVendor): ProviderConfig | undefined =>
  config.providers.find(provider => provider.type === type && provider.defaultForBareModels === true);

/** Sorted alias names in one provider whose upstream equals a bare model; undefined when it offers none. */
const aliasesFor = (provider: ProviderConfig, model: string): string | undefined =>
  Object.entries(provider.models).filter(([, upstream]) => upstream === model).map(([alias]) => alias).sort()[0];

/**
 * The subscription alias that serves a bare vendor model name. A designated default account for the
 * name's vendor resolves the alias only within that account, so a model it does not offer fails
 * `model_not_found` instead of falling back onto another subscription account; within an account the
 * lexically first alias decides, so configuration order never matters. Without a designation the name
 * resolves only when exactly one account of its vendor offers it, and zero or several stay ambiguous.
 */
export function nativeModelAlias(config: GatewayConfig, model: string): string | undefined {
  const vendor = vendorType(model);
  if (!vendor) return;
  const designated = designatedDefault(config, vendor);
  if (designated) return aliasesFor(designated, model);
  const matches = config.providers.filter(provider => provider.type === vendor).flatMap(provider => (aliasesFor(provider, model) === undefined ? [] : [provider]));
  return matches.length === 1 ? aliasesFor(matches[0]!, model) : undefined;
}

/**
 * The subscription provider that serves an unnamed reviewer: the designated default Codex account, or
 * otherwise the one Codex subscription when it is the only one. Two accounts with no designation are
 * ambiguous and fail closed, as does no Codex account at all.
 */
export function autoReviewProvider(config: GatewayConfig, slug: string): ProviderConfig | undefined {
  if (!isAutoReviewModel(slug)) return;
  const codex = config.providers.filter(provider => provider.type === "codex-subscription");
  return designatedDefault(config, "codex-subscription") ?? (codex.length === 1 ? codex[0] : undefined);
}
/** Where a reviewer slug goes: an exact alias for it keeps precedence, then a bare-name alias, then the account rule. */
export function autoReviewTarget(config: GatewayConfig, slug: string): ProviderConfig | undefined {
  if (!isAutoReviewModel(slug)) return;
  const alias = config.providers.some(provider => Object.hasOwn(provider.models, slug)) ? slug : nativeModelAlias(config, slug);
  return (alias ? config.providers.find(provider => Object.hasOwn(provider.models, alias)) : undefined) ?? autoReviewProvider(config, slug);
}
