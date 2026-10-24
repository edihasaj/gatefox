import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

export const claudeDesktopProfileName = "Harness Gateway";
const primaryProviderType = "claude-subscription";
const defaultModelName = "claude-fable-5-1";
const defaultAdapterPort = 3467;
/** Claude Desktop accepts at most this many rows in the profile's model list (visible picker rows only). */
const maxProfileModelRows = 200;
/** Fail-closed bound on hidden compatibility aliases in the adapter configuration; they never appear in the picker. */
const maxHiddenVariantAliases = 1000;
/** Only these efforts are offered as variants; ultra, none and minimal have no Claude request equivalent. */
const variantEffortOrder = ["low", "medium", "high", "xhigh", "max"] as const;
type VariantEffort = typeof variantEffortOrder[number];
const effortLabels: Record<VariantEffort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" };
/** Transports that honor an explicit service tier. */
const tierProviderTypes = new Set(["claude-subscription", "codex-subscription", "responses-api"]);
const standardTier: VariantTier = { id: "default", name: "Standard" };

export interface ClaudeDesktopProvider {
  id: string;
  type: string;
  label?: string;
  models: Record<string, string>;
}

export interface ClaudeDesktopGatewaySource {
  port: number;
  stateDirectory: string;
  providers: ClaudeDesktopProvider[];
}

export interface ClaudeDesktopCatalogModel {
  slug: string;
  display_name: string;
  context_window?: number;
  supported_reasoning_levels?: Array<string | { effort?: string }>;
  service_tiers?: Array<{ id?: string; name?: string }>;
}

export interface ClaudeDesktopCatalog {
  models: ClaudeDesktopCatalogModel[];
}

export interface CredentialHelper {
  command: string;
  args: string[];
}

export interface ClaudeDesktopProfileOptions {
  tokenFile: string;
  adapterRoot: string;
  primaryClaudeProvider?: string;
  defaultModel?: string;
  adapterPort?: number;
  upstream?: string;
  credentialHelper?: CredentialHelper;
}

export interface ClaudeDesktopAdapterModel {
  id: string;
  upstream: string;
  displayName: string;
  contextWindow?: number;
  reasoningEffort?: VariantEffort;
  serviceTier?: string;
  preserveOptionalToolArguments?: true;
}

export interface ClaudeDesktopAdapterConfig {
  listenPort: number;
  endpoint: string;
  upstream: string;
  tokenFile: string;
  auditFile: string;
  models: ClaudeDesktopAdapterModel[];
}

export interface ClaudeDesktopProfileBuild {
  profile: Record<string, unknown>;
  adapterConfig: ClaudeDesktopAdapterConfig;
}

type AliasOwner = { providerId: string; providerType: string; native: string };
type VariantTier = { id: string; name: string };
type VariantSpec = { effort?: VariantEffort; tier?: VariantTier };
interface VariantBase {
  alias: string;
  row: ClaudeDesktopCatalogModel;
  keepOptionalToolArguments: boolean;
  /** A primary Claude native route: Standard uses Claude Desktop's own effort control. */
  primary: boolean;
  efforts: VariantEffort[];
  tiers: VariantTier[];
}

function fail(message: string): never { throw new Error(message); }

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validPort(port: number, description: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`${description} must be a valid TCP port`);
}

function stableRouteId(alias: string): string {
  const number = createHash("sha256").update(alias, "utf8").digest().readBigUInt64BE(0);
  return `claude-hg-route-${number}`;
}

function catalogByAlias(catalog: ClaudeDesktopCatalog): Map<string, ClaudeDesktopCatalogModel> {
  if (!Array.isArray(catalog.models)) fail("Gateway catalog must contain a models array");
  const result = new Map<string, ClaudeDesktopCatalogModel>();
  for (const row of catalog.models) {
    if (!row || !nonEmptyString(row.slug) || !nonEmptyString(row.display_name)) fail("Every gateway catalog model needs non-empty slug and display_name");
    if (result.has(row.slug)) fail(`Gateway catalog alias ${row.slug} is not unique`);
    result.set(row.slug, row);
  }
  return result;
}

function sourceAliases(source: ClaudeDesktopGatewaySource, primaryId: string): { aliases: Map<string, AliasOwner>; primary: Map<string, string> } {
  if (!Array.isArray(source.providers)) fail("gateway.providers must be an array");
  const aliases = new Map<string, AliasOwner>();
  const primary = new Map<string, string>();
  let primaryCount = 0;
  const providerIds = new Set<string>();
  for (const provider of source.providers) {
    if (!provider || !nonEmptyString(provider.id) || !nonEmptyString(provider.type) || !provider.models || typeof provider.models !== "object" || Array.isArray(provider.models)) {
      fail("Every gateway provider needs id, type, and a models object");
    }
    if (providerIds.has(provider.id)) fail(`Gateway provider ${provider.id} is not unique`);
    providerIds.add(provider.id);
    const isPrimary = provider.id === primaryId;
    if (isPrimary) {
      if (provider.type !== primaryProviderType) fail(`Primary provider ${primaryId} must be a ${primaryProviderType}`);
      primaryCount++;
    }
    for (const [alias, native] of Object.entries(provider.models)) {
      if (!nonEmptyString(alias) || !nonEmptyString(native)) fail(`Provider ${provider.id} models must map non-empty strings`);
      if (aliases.has(alias)) fail(`Gateway alias ${alias} is owned by more than one provider`);
      aliases.set(alias, { providerId: provider.id, providerType: provider.type, native });
      if (isPrimary) primary.set(alias, native);
    }
  }
  if (primaryCount !== 1) fail(`Exactly one primary ${primaryProviderType} provider named ${primaryId} is required`);
  if (!primary.size) fail("The primary Claude subscription has no models");
  return { aliases, primary };
}

function primaryRoutes(primary: Map<string, string>): Array<{ native: string; alias: string }> {
  const aliasesByNative = new Map<string, string[]>();
  for (const [alias, native] of primary) {
    const aliases = aliasesByNative.get(native) ?? [];
    aliases.push(alias);
    aliasesByNative.set(native, aliases);
  }
  const result: Array<{ native: string; alias: string }> = [];
  for (const [native, aliases] of aliasesByNative) {
    const exact = aliases.filter(alias => alias === native);
    if (exact.length > 1) fail(`Primary Claude native model ${native} has duplicate exact routes`);
    result.push({ native, alias: exact[0] ?? [...aliases].sort()[0]! });
  }
  return result;
}

function supportsHigh(row: ClaudeDesktopCatalogModel): boolean {
  return Array.isArray(row.supported_reasoning_levels) && row.supported_reasoning_levels.some(level => level === "high" || (typeof level === "object" && level !== null && level.effort === "high"));
}

function variantRouteId(alias: string, effort: string | undefined, tier: string | undefined): string {
  const number = createHash("sha256").update(JSON.stringify(["variant", alias, effort ?? null, tier ?? null]), "utf8").digest().readBigUInt64BE(0);
  return `claude-hg-route-${number}`;
}

function variantEfforts(row: ClaudeDesktopCatalogModel): VariantEffort[] {
  if (!Array.isArray(row.supported_reasoning_levels)) return [];
  const present = new Set<string>();
  for (const level of row.supported_reasoning_levels) {
    const effort = typeof level === "string" ? level : level && typeof level === "object" ? level.effort : undefined;
    if (typeof effort === "string") present.add(effort);
  }
  return variantEffortOrder.filter(effort => present.has(effort));
}

/** Advertised non-standard tiers of a transport that honors them; Standard is added explicitly as `default`. */
function variantTiers(row: ClaudeDesktopCatalogModel, providerType: string): VariantTier[] {
  if (!tierProviderTypes.has(providerType) || !Array.isArray(row.service_tiers)) return [];
  const seen = new Set<string>();
  const result: VariantTier[] = [];
  for (const tier of row.service_tiers) {
    if (!tier || typeof tier.id !== "string" || !/^[a-z][a-z0-9_-]{0,127}$/.test(tier.id) || tier.id === "default" || seen.has(tier.id)) continue;
    if (!nonEmptyString(tier.name) || tier.name.length > 1024 || tier.name.includes("\0")) continue;
    seen.add(tier.id);
    result.push({ id: tier.id, name: tier.name });
  }
  return result;
}

/**
 * A primary Claude native route keeps Claude Desktop's own effort control for Standard, so
 * it only gets explicit variants for each advertised non-standard tier (Fast) x each effort.
 * Every other route gets the effort x speed cross product with Standard explicit as `default`.
 */
function variantSpecs(base: VariantBase): VariantSpec[] {
  const efforts: Array<VariantEffort | undefined> = base.efforts.length ? base.efforts : [undefined];
  if (base.primary) return base.tiers.flatMap(tier => efforts.map(effort => ({ ...(effort === undefined ? {} : { effort }), tier })));
  const speeds: Array<VariantTier | undefined> = base.tiers.length ? [standardTier, ...base.tiers] : [undefined];
  const result: VariantSpec[] = [];
  for (const effort of efforts) for (const tier of speeds) {
    if (effort === undefined && tier === undefined) continue;
    result.push({ ...(effort === undefined ? {} : { effort }), ...(tier === undefined ? {} : { tier }) });
  }
  return result;
}

/**
 * Hidden compatibility aliases for chats saved while explicit variants were offered. They are
 * adapter-only. Exceeding the bound is refused with the count; no alias is ever evicted, because
 * a dropped alias would silently break a saved chat.
 */
function selectVariants(bases: VariantBase[]): Array<{ base: VariantBase; spec: VariantSpec }> {
  const result = bases.flatMap(base => variantSpecs(base).map(spec => ({ base, spec })));
  if (result.length > maxHiddenVariantAliases) {
    fail(`Claude Desktop adapter would need ${result.length} hidden effort/speed compatibility aliases, above the limit of ${maxHiddenVariantAliases}; remove models or service tiers from the gateway configuration`);
  }
  return result;
}

/** The highest effort the model supports, bounded by a cap already in the profile. */
function boundedMaxEffort(prior: unknown, efforts: VariantEffort[]): unknown {
  const top = efforts[efforts.length - 1];
  if (top === undefined) return prior;
  if (prior === undefined) return top;
  const priorRank = variantEffortOrder.indexOf(prior as VariantEffort);
  if (priorRank < 0) return prior;
  return priorRank < variantEffortOrder.indexOf(top) ? prior : top;
}

/** Efforts at or below the native row's bounded cap, so a Fast variant cannot exceed what Standard allows. */
function effortsWithin(cap: unknown, efforts: VariantEffort[]): VariantEffort[] {
  const rank = variantEffortOrder.indexOf(cap as VariantEffort);
  return rank < 0 ? efforts : efforts.filter(effort => variantEffortOrder.indexOf(effort) <= rank);
}

function adapterModel(id: string, upstream: string, row: ClaudeDesktopCatalogModel, keepOptionalToolArguments: boolean): ClaudeDesktopAdapterModel {
  const result: ClaudeDesktopAdapterModel = { id, upstream, displayName: row.display_name };
  if (Number.isInteger(row.context_window) && row.context_window! > 0) result.contextWindow = row.context_window;
  if (keepOptionalToolArguments) result.preserveOptionalToolArguments = true;
  return result;
}

function existingModelMetadata(profile: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const models = profile.inferenceModels;
  if (models === undefined) return new Map();
  if (!Array.isArray(models)) fail("Existing Harness Gateway profile inferenceModels must be an array");
  const result = new Map<string, Record<string, unknown>>();
  for (const row of models) {
    if (!row || typeof row !== "object" || Array.isArray(row)) fail("Existing Harness Gateway profile has an invalid model entry");
    const entry = row as Record<string, unknown>;
    if (nonEmptyString(entry.name)) result.set(entry.name, entry);
  }
  return result;
}

function safeLoopbackUpstream(value: string, adapterPort: number): string {
  let url: URL;
  try { url = new URL(value); } catch { fail("Adapter upstream must be a valid URL"); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "http:" && url.protocol !== "https:")) fail("Adapter upstream must not contain credentials, query, or fragment");
  const normalized = url.href.replace(/\/$/, "");
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && Number(url.port || (url.protocol === "https:" ? 443 : 80)) === adapterPort) {
    fail("Gateway upstream conflicts with the private desktop adapter port");
  }
  return normalized;
}

function credentialHelperArgs(args: string[], tokenFile: string): string[] {
  const result: string[] = [];
  let replaced = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--file" || argument === "--token-file") {
      result.push(argument, tokenFile);
      index++;
      replaced = true;
      continue;
    }
    if (argument.startsWith("--file=") || argument.startsWith("--token-file=")) {
      result.push(`${argument.slice(0, argument.indexOf("=") + 1)}${tokenFile}`);
      replaced = true;
      continue;
    }
    result.push(argument);
  }
  return replaced ? result : [...result, "--file", tokenFile];
}

/**
 * Builds the isolated Claude Desktop profile and adapter configuration without
 * reading or writing a client configuration file.
 */
export function buildClaudeDesktopProfile(
  source: ClaudeDesktopGatewaySource,
  catalog: ClaudeDesktopCatalog,
  existingProfile: Record<string, unknown>,
  options: ClaudeDesktopProfileOptions,
): ClaudeDesktopProfileBuild {
  validPort(source.port, "gateway.port");
  if (!nonEmptyString(source.stateDirectory) || !isAbsolute(source.stateDirectory)) fail("gateway.stateDirectory must be an absolute path");
  if (!isAbsolute(options.tokenFile) || !isAbsolute(options.adapterRoot)) fail("Claude Desktop tokenFile and adapterRoot must be absolute paths");
  const adapterPort = options.adapterPort ?? defaultAdapterPort;
  validPort(adapterPort, "adapterPort");
  if (source.port === adapterPort) fail("Existing gateway port conflicts with the private desktop adapter port");
  const upstream = safeLoopbackUpstream(options.upstream ?? `http://127.0.0.1:${source.port}`, adapterPort);
  const primaryId = options.primaryClaudeProvider ?? "claude";
  const modelDefault = options.defaultModel ?? defaultModelName;
  const catalogModels = catalogByAlias(catalog);
  const { aliases, primary } = sourceAliases(source, primaryId);
  for (const alias of catalogModels.keys()) if (!aliases.has(alias)) fail(`Gateway catalog alias ${alias} is not owned by a configured provider`);
  for (const alias of aliases.keys()) if (!catalogModels.has(alias)) fail(`Configured gateway alias ${alias} is absent from the model catalog`);

  const routes = primaryRoutes(primary);
  if (!routes.some(route => route.native === modelDefault)) fail(`Primary Claude subscription must explicitly provide ${modelDefault}`);
  const orderedRoutes = [...routes].sort((left, right) => Number(left.native !== modelDefault) - Number(right.native !== modelDefault) || left.native.localeCompare(right.native));
  const oldMetadata = existingModelMetadata(existingProfile);
  const primaryEntries = orderedRoutes.map(route => {
    const prior = oldMetadata.get(route.native);
    const entry: Record<string, unknown> = { name: route.native, labelOverride: catalogModels.get(route.alias)!.display_name };
    for (const key of ["anthropicFamilyTier", "isFamilyDefault"]) if (prior && Object.hasOwn(prior, key)) entry[key] = prior[key];
    const maxEffort = boundedMaxEffort(prior && Object.hasOwn(prior, "maxEffort") ? prior.maxEffort : undefined, variantEfforts(catalogModels.get(route.alias)!));
    if (maxEffort !== undefined) entry.maxEffort = maxEffort;
    return entry;
  });

  const adapterModels: ClaudeDesktopAdapterModel[] = orderedRoutes.map(route => adapterModel(route.native, route.alias, catalogModels.get(route.alias)!, false));
  const variantBases: VariantBase[] = orderedRoutes.map((route, index) => {
    const row = catalogModels.get(route.alias)!;
    // The native row's bounded cap also bounds its explicit Fast variants.
    const efforts = effortsWithin(primaryEntries[index]!.maxEffort, variantEfforts(row));
    return { alias: route.alias, row, keepOptionalToolArguments: false, primary: true, efforts, tiers: variantTiers(row, aliases.get(route.alias)!.providerType) };
  });
  const usedIds = new Set(primaryEntries.map(entry => String(entry.name)));
  const extras: Record<string, unknown>[] = [];
  for (const alias of [...aliases.keys()].filter(alias => !primary.has(alias)).sort()) {
    const routeId = stableRouteId(alias);
    if (usedIds.has(routeId)) fail(`Compatibility route ID collision for ${alias}: ${routeId}`);
    usedIds.add(routeId);
    const row = catalogModels.get(alias)!;
    const entry: Record<string, unknown> = { name: routeId, labelOverride: row.display_name };
    if (supportsHigh(row)) entry.maxEffort = "high";
    extras.push(entry);
    const owner = aliases.get(alias)!;
    const keepOptional = owner.providerType === "codex-subscription" || owner.providerType === "responses-api";
    adapterModels.push(adapterModel(routeId, alias, row, keepOptional));
    variantBases.push({ alias, row, keepOptionalToolArguments: keepOptional, primary: false, efforts: variantEfforts(row), tiers: variantTiers(row, owner.providerType) });
  }

  // The picker lists one row per model, so only these rows count toward Claude Desktop's limit.
  if (usedIds.size > maxProfileModelRows) {
    fail(`Claude Desktop allows at most ${maxProfileModelRows} model rows, but this gateway needs ${usedIds.size}; remove models from the gateway configuration`);
  }

  // Backend-only aliases, appended after every original adapter route and never written to the
  // profile. Each carries an explicit effort and/or tier and no family identity.
  for (const { base, spec } of selectVariants(variantBases)) {
    const routeId = variantRouteId(base.alias, spec.effort, spec.tier?.id);
    if (usedIds.has(routeId)) fail(`Variant route ID collision for ${base.alias}: ${routeId}`);
    usedIds.add(routeId);
    const label = [base.row.display_name, spec.effort === undefined ? undefined : effortLabels[spec.effort], spec.tier?.name].filter(part => part !== undefined).join(" · ");
    adapterModels.push({
      ...adapterModel(routeId, base.alias, base.row, base.keepOptionalToolArguments), displayName: label,
      ...(spec.effort === undefined ? {} : { reasoningEffort: spec.effort }),
      ...(spec.tier === undefined ? {} : { serviceTier: spec.tier.id }),
    });
  }

  const profile: Record<string, unknown> = structuredClone(existingProfile);
  profile.inferenceGatewayBaseUrl = `http://127.0.0.1:${adapterPort}`;
  profile.modelDiscoveryEnabled = false;
  profile.alwaysStartWithDefaultModel = true;
  profile.inferenceModels = [...primaryEntries, ...extras];
  if (options.credentialHelper) {
    if (!nonEmptyString(options.credentialHelper.command) || !Array.isArray(options.credentialHelper.args) || options.credentialHelper.args.some(argument => typeof argument !== "string")) fail("credentialHelper must contain a command and string args");
    profile.inferenceCredentialHelper = options.credentialHelper.command;
    profile.inferenceCredentialHelperArgs = credentialHelperArgs(options.credentialHelper.args, options.tokenFile);
  }
  const adapterConfig: ClaudeDesktopAdapterConfig = {
    listenPort: adapterPort, endpoint: upstream, upstream, tokenFile: options.tokenFile,
    auditFile: join(options.adapterRoot, "route-audit.jsonl"), models: adapterModels,
  };
  return { profile, adapterConfig };
}
