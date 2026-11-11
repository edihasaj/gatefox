/**
 * Claude Desktop served by the gateway itself, with no adapter process in between. The app refuses a
 * model ID that names GPT or Qwen, so every alias outside the primary Claude account also answers to
 * Claude-safe IDs derived from the alias alone: `claude-hg-route-<n>`, and for a route with reasoning
 * levels `claude-opus-5[hg-route-<n>]`. The same derivation writes the picker rows, so a row always
 * names an ID this gateway resolves. Routing, accounts and permissions are unchanged: an ID is another
 * spelling of one fixed alias.
 */
import { knownContextWindows, modelCatalog } from "./catalog.js";
import type { GatewayConfig, ProviderConfig } from "./config.js";
import { designatedDefault } from "./model-routing.js";
import { buildClaudeDesktopRoutes, bridgeRouteBase, variantEffortOrder,
  type ClaudeDesktopAdapterModel, type ClaudeDesktopCatalogModel, type ClaudeDesktopRoutes, type VariantEffort } from "./claude-desktop-profile.js";
import type { OpenAIToolCall } from "./protocol/types.js";

const createdAt = "2026-01-01T00:00:00Z";
const opaquePattern = /^claude-hg-route-[0-9]{1,20}$/;
const bridgePattern = /^claude-opus-5\[hg-route-[0-9]{1,20}\]$/;
type Data = Record<string, unknown>;
const record = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);

/** One model as Claude Desktop lists it. */
export interface ClaudeDirectRow {
  /** The ID a profile row names: a native Claude model, or the opaque route ID. */
  id: string;
  alias: string;
  displayName: string;
  contextWindow?: number;
  /** Reasoning efforts the route accepts, lowest first. */
  efforts: VariantEffort[];
  /** A model of the primary Claude account under its own ID. */
  native: boolean;
  /** The ID that makes an app without `behavesAs` show its effort control for this route. */
  bridgeId?: string;
  /** False for a row the gateway's catalog hides from pickers; its IDs still resolve. */
  listed: boolean;
}

export interface ClaudeDirectSurface {
  rows: ClaudeDirectRow[];
  /** Every Claude-safe route ID. Native Claude IDs are absent: the gateway's bare-name routing serves them. */
  routes: ReadonlyMap<string, ClaudeDesktopAdapterModel>;
  /** What was left out to keep the surface available, if anything. */
  degraded?: "variants" | "primary" | "unavailable";
}

/** The account whose models keep their own Claude IDs: the designated default, or the only Claude subscription. */
export function claudeDirectPrimary(config: Pick<GatewayConfig, "providers">): ProviderConfig | undefined {
  const claude = config.providers.filter(provider => provider.type === "claude-subscription");
  return designatedDefault(config as GatewayConfig, "claude-subscription") ?? (claude.length === 1 ? claude[0] : undefined);
}

function derive(config: GatewayConfig): ClaudeDirectSurface {
  const owned = new Set(config.providers.flatMap(provider => Object.keys(provider.models)));
  const known = knownContextWindows(config);
  // Managed aliases have no provider of their own, and an unknown window is a placeholder, not a fact to advertise.
  const catalogRows = modelCatalog(config).models.filter(row => owned.has(row.slug as string));
  const order = new Map(catalogRows.map((row, index) => [row.slug as string, index]));
  const hidden = new Set(catalogRows.filter(row => row.visibility === "hide").map(row => row.slug as string));
  const catalog = { models: catalogRows.map(row => ({
    slug: row.slug, display_name: row.display_name, supported_reasoning_levels: row.supported_reasoning_levels, service_tiers: row.service_tiers,
    ...(known.has(row.slug as string) ? { context_window: row.context_window } : {}),
  }) as ClaudeDesktopCatalogModel) };
  const providers = config.providers.map(provider => ({ id: provider.id, type: provider.type, models: provider.models }));
  const primary = claudeDirectPrimary(config);
  const build = (primaryId: string | null, variants: boolean): [ClaudeDesktopRoutes, ClaudeDesktopRoutes] => [true, false].map(nativeModelMetadata =>
    buildClaudeDesktopRoutes(providers, catalog, {}, { primaryClaudeProvider: primaryId, defaultModel: null, nativeModelMetadata, rowLimit: false, variants })) as [ClaudeDesktopRoutes, ClaudeDesktopRoutes];
  let built: [ClaudeDesktopRoutes, ClaudeDesktopRoutes] | undefined; let degraded: ClaudeDirectSurface["degraded"];
  // A catalog too large for the hidden aliases, or a primary account with no models, must not take the picker away.
  for (const [primaryId, variants, mark] of [[primary?.id ?? null, true, undefined], [primary?.id ?? null, false, "variants"], [null, false, "primary"]] as const) {
    try { built = build(primaryId, variants); degraded = mark; break; } catch { /* Try the next, smaller surface. */ }
  }
  if (!built) return { rows: [], routes: new Map(), degraded: "unavailable" };
  const [opaque, bridged] = built;
  const routes = new Map<string, ClaudeDesktopAdapterModel>();
  for (const model of [...opaque.models, ...bridged.models]) if (opaquePattern.test(model.id) || bridgePattern.test(model.id)) routes.set(model.id, model);
  const details = new Map(opaque.models.map(model => [model.id, model] as const));
  const primaryAliases = primary ? Object.entries(primary.models) : [];
  // A Claude client lists its own accounts first: the primary Claude account, the other Claude accounts in configuration
  // order, then every other provider in catalog order.
  const providerOf = new Map(config.providers.flatMap((provider, index) => Object.keys(provider.models).map(alias => [alias, { provider, index }] as const)));
  const rank = (alias: string): number => {
    const owner = providerOf.get(alias);
    if (!owner || owner.provider.type !== "claude-subscription") return 2;
    return owner.provider === primary ? 0 : 1;
  };
  const rows = opaque.rows.map((row): ClaudeDirectRow => {
    const id = String(row.entry.name); const detail = details.get(id);
    // A native row stands for every alias of that model, so one visible alias keeps it listed.
    const upstream = row.native ? primary!.models[row.alias] : undefined;
    const listed = row.native ? primaryAliases.some(([alias, model]) => model === upstream && !hidden.has(alias)) : !hidden.has(row.alias);
    return { id, alias: row.alias, displayName: String(row.entry.labelOverride), efforts: row.efforts, native: row.native, listed,
      ...(detail?.contextWindow === undefined ? {} : { contextWindow: detail.contextWindow }),
      ...(row.compatId && bridgePattern.test(row.compatId) ? { bridgeId: row.compatId } : {}) };
  }).sort((left, right) => rank(left.alias) - rank(right.alias) || (order.get(left.alias) ?? 0) - (order.get(right.alias) ?? 0));
  return { rows, routes, ...(degraded ? { degraded } : {}) };
}

const surfaces = new WeakMap<GatewayConfig, ClaudeDirectSurface>();
/** Derived once per loaded configuration; a reload yields a new configuration object and a new surface. */
export function claudeDirectSurface(config: GatewayConfig): ClaudeDirectSurface {
  let surface = surfaces.get(config);
  if (!surface) { surface = derive(config); surfaces.set(config, surface); }
  return surface;
}

function modelObject(id: string, displayName: string, contextWindow: number | undefined, extra?: Data): Data {
  return { id, type: "model", display_name: displayName, created_at: createdAt, ...(contextWindow === undefined ? {} : { context_window: contextWindow }), ...(extra ? { gatefox: extra } : {}) };
}
const rowObject = (row: ClaudeDirectRow): Data => modelObject(row.id, row.displayName, row.contextWindow,
  { alias: row.alias, native: row.native, efforts: row.efforts, ...(row.bridgeId ? { bridge_id: row.bridgeId } : {}) });

/** The Anthropic model list: one row per model the catalog shows. `gatefox` carries what a profile row needs. */
export function claudeDirectModelList(surface: ClaudeDirectSurface): Data {
  const data = surface.rows.filter(row => row.listed).map(rowObject);
  return { type: "list", data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
}

/** One model by any ID a chat may name: a row, its bridge ID, or a hidden compatibility alias. */
export function claudeDirectModelDetail(surface: ClaudeDirectSurface, id: string): Data | undefined {
  const row = surface.rows.find(entry => entry.id === id);
  if (row) return rowObject(row);
  const route = surface.routes.get(id);
  return route ? modelObject(route.id, route.displayName, route.contextWindow) : undefined;
}

/** The highest supported effort below the requested one, else the lowest supported effort. */
function clampEffort(requested: string, supported: readonly VariantEffort[]): VariantEffort {
  if ((supported as readonly string[]).includes(requested)) return requested as VariantEffort;
  const rank = (variantEffortOrder as readonly string[]).indexOf(requested);
  const below = rank < 0 ? [] : supported.filter(effort => variantEffortOrder.indexOf(effort) < rank);
  return below.at(-1) ?? supported[0]!;
}

/** Rewrites every effort the client sent, including those a tool continuation keeps in its system messages. */
function withEfforts(payload: Data, effort: (sent: string) => string, always: boolean): Data {
  const result = { ...payload };
  const config = record(payload.output_config) ? payload.output_config : undefined;
  if (always || typeof config?.effort === "string") result.output_config = { ...config, effort: effort(typeof config?.effort === "string" ? config.effort : "") };
  if (Array.isArray(payload.messages)) result.messages = payload.messages.map(message => {
    if (!record(message) || message.role !== "system" || !record(message.output_config)) return message;
    const sent = message.output_config.effort;
    if (always ? sent === undefined : typeof sent !== "string") return message;
    return { ...message, output_config: { ...message.output_config, effort: effort(typeof sent === "string" ? sent : "") } };
  });
  return result;
}

export interface ClaudeDirectRequest {
  /** The request as the alias's own route gets it. */
  wire: Data;
  /** The ID the client named, which its reply must carry. */
  exposedModel: string;
  route: ClaudeDesktopAdapterModel;
}

/**
 * Resolves a Claude-safe ID to its alias. A bridge row shows the app's own effort control, whose stops come from
 * Claude's catalog and can exceed the route's, so a sent effort is clamped; an effort the client never chose is never
 * added. A hidden variant alias carries its explicit effort and speed. An auxiliary review keeps its own controls.
 */
export function claudeDirectRequest(surface: ClaudeDirectSurface, wire: unknown, isNativeClassifierRequest?: (payload: unknown) => boolean): ClaudeDirectRequest | undefined {
  if (!record(wire) || typeof wire.model !== "string") return;
  const route = surface.routes.get(wire.model);
  if (!route) return;
  // The app drops a bridge row's bracketed suffix for its own checks, so the review is recognized under that ID.
  const auxiliary = isNativeClassifierRequest?.(bridgePattern.test(route.id) ? { ...wire, model: bridgeRouteBase } : wire) === true;
  let payload: Data = { ...wire, model: route.upstream };
  if (!auxiliary && route.reasoningEffort !== undefined) {
    const effort = route.reasoningEffort;
    payload = withEfforts(payload, () => effort, true);
    // An unknown alias inherits the client's no-thinking default; an explicit effort selects adaptive thinking.
    if (record(payload.thinking) && payload.thinking.type === "disabled" && Object.keys(payload.thinking).length === 1) payload.thinking = { type: "adaptive" };
  } else if (!auxiliary && route.supportedEfforts !== undefined) {
    const supported = route.supportedEfforts;
    payload = withEfforts(payload, sent => clampEffort(sent, supported), false);
  }
  if (!auxiliary && route.serviceTier !== undefined) payload.service_tier = route.serviceTier;
  return { wire: payload, exposedModel: route.id, route };
}

/** The schema conversion the Claude adapter applies for routes that require a value for every optional tool property. */
export interface OptionalToolsRuntime {
  prepareOptionalToolArguments(payload: Data): { payload: Data; plans: Map<string, unknown> };
  normalizeOptionalToolResponse(response: Data, plans: Map<string, unknown>): Data;
}
let optionalTools: Promise<OptionalToolsRuntime> | undefined;
export function optionalToolsRuntime(): Promise<OptionalToolsRuntime> {
  return optionalTools ??= import(new URL("../scripts/claude-desktop-optional-tools.mjs", import.meta.url).href) as Promise<OptionalToolsRuntime>;
}

/** Removes only the nulls the conversion introduced from one returned tool call; anything unreadable passes unchanged. */
export function restoreOptionalToolCall(call: OpenAIToolCall, plans: Map<string, unknown>, runtime: OptionalToolsRuntime): OpenAIToolCall {
  const name = call.responseTool?.name || call.function.name;
  if (!plans.has(name)) return call;
  let input: unknown;
  try { input = JSON.parse(call.function.arguments); } catch { return call; }
  const block = { type: "tool_use", name, input };
  const content = runtime.normalizeOptionalToolResponse({ content: [block] }, plans).content;
  const restored = Array.isArray(content) && record(content[0]) ? content[0].input : input;
  return restored === input ? call : { ...call, function: { ...call.function, arguments: JSON.stringify(restored) } };
}
