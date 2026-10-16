import type { Message } from "./app-server-connection.js";
import { record } from "./codex-feature-compat.js";
import { featureSchema, type TableSchema } from "./gateway-feature-fields.js";
import { isTable, readValue, writeInline } from "./gateway-feature-toml.js";
import { telemetry } from "./telemetry.js";

export type TrimSite = "request" | "spawn" | "home" | "retry";
export interface TrimStats { count: number }
/** `strict` is the retry form: every feature is a boolean, nothing structured survives. */
interface Context { stats: TrimStats; strict: boolean }
const entries = (list: [string, unknown][]): Message => Object.fromEntries(list);

/** Keep only the fields (and nested fields) the table accepts. Returns the same object when nothing changed. */
function trimFields(schema: TableSchema, value: Message): Message {
  let changed = false; const kept: [string, unknown][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (schema.fields && !schema.fields.has(key)) { changed = true; continue; }
    const child = schema.nested.get(key) ?? (schema.fields ? undefined : schema.values);
    if (child && isTable(entry)) { const inner = trimFields(child, entry); if (inner !== entry) changed = true; kept.push([key, inner]); } else kept.push([key, entry]);
  }
  return changed ? entries(kept) : value;
}

/** Check a dotted field path below a structured feature; the value is trimmed when the path ends at a nested table. */
function trimFieldPath(schema: TableSchema, path: string[], value: unknown): { value: unknown } | undefined {
  const [head, ...tail] = path;
  if (schema.fields && !schema.fields.has(head)) return;
  const child = schema.nested.get(head) ?? (schema.fields ? undefined : schema.values);
  // Below a field the SDK reads as a scalar, array or free-form map there is nothing left to check.
  if (!child) return { value };
  if (!tail.length) return { value: isTable(value) ? trimFields(child, value) : value };
  return trimFieldPath(child, tail, value);
}

/** Apply the pinned schema to a whole feature entry `K = value`. Returns undefined when it is dropped. */
function trimFeature(ctx: Context, name: string, value: unknown): { value: unknown } | undefined {
  const spec = featureSchema(name);
  // The SDK reads tool_registry as a plain table: a boolean there is an error, not a toggle.
  if (spec?.tableOnly) {
    if (ctx.strict || !isTable(value)) { ctx.stats.count++; return; }
    const kept = trimFields(spec, value); if (kept !== value) ctx.stats.count++;
    return { value: kept };
  }
  if (typeof value === "boolean") return { value };
  if (isTable(value)) {
    if (spec && !ctx.strict) { const kept = trimFields(spec, value); if (kept !== value) ctx.stats.count++; return { value: kept }; }
    ctx.stats.count++;
    return typeof value.enabled === "boolean" ? { value: value.enabled } : undefined;
  }
  ctx.stats.count++;
}

/** Apply the schema to `K.F...` below `features`. `collapsed` means the key becomes plain `K`. */
function trimDotted(ctx: Context, names: string[], value: unknown): { collapsed: boolean; value: unknown } | undefined {
  const [feature, ...rest] = names;
  if (!rest.length) { const result = trimFeature(ctx, feature, value); return result && { collapsed: false, value: result.value }; }
  const spec = featureSchema(feature);
  if (spec && !ctx.strict) {
    const result = trimFieldPath(spec, rest, value);
    if (!result) { ctx.stats.count++; return; }
    if (result.value !== value) ctx.stats.count++;
    return { collapsed: false, value: result.value };
  }
  ctx.stats.count++;
  return !spec?.tableOnly && rest.length === 1 && rest[0] === "enabled" && typeof value === "boolean" ? { collapsed: true, value } : undefined;
}

/** A `features` table: its keys are literal feature names, so a dot inside one is part of the name. */
function trimContainer(ctx: Context, input: Message): Message {
  const kept: [string, unknown][] = [];
  for (const [name, value] of Object.entries(input)) { const result = trimFeature(ctx, name, value); if (result) kept.push([name, result.value]); }
  return entries(kept);
}

/** Where the feature name starts in a key path: 1 for `features...`, 3 for `profiles.<name>.features...`, else 0. */
function featureOffset(segments: string[]): number {
  return segments[0] === "features" ? 1 : segments[0] === "profiles" && segments[2] === "features" ? 3 : 0;
}

/**
 * One profile's table. Only an override key is a dotted path; inside a value the SDK converts a JSON object into a TOML table
 * whose keys stay literal, so here only the key `features` itself is the profile's feature table.
 */
function trimProfile(ctx: Context, profile: Message): Message {
  if (!Object.hasOwn(profile, "features")) return profile;
  const before = ctx.stats.count; const kept: [string, unknown][] = [];
  for (const [key, value] of Object.entries(profile)) {
    if (key !== "features") kept.push([key, value]);
    else if (isTable(value)) kept.push([key, trimContainer(ctx, value)]);
    else ctx.stats.count++; // The SDK reads a profile's `features` only as a table.
  }
  return ctx.stats.count === before ? profile : entries(kept);
}

function trimConfig(ctx: Context, input: Message): Message {
  const kept: [string, unknown][] = [];
  for (const [key, value] of Object.entries(input)) {
    // The pinned SDK applies every override key with `path.split('.')` (codex-rs/config/src/overrides.rs) and never unquotes a
    // segment, so the key is split the same way: a quoted segment keeps its quote characters and names an unknown setting.
    const segments = key.split("."); const offset = featureOffset(segments);
    if (offset && segments.length === offset) {
      if (isTable(value)) kept.push([key, trimContainer(ctx, value)]); else ctx.stats.count++;
    } else if (offset) {
      const result = trimDotted(ctx, segments.slice(offset), value);
      if (!result) continue;
      kept.push([result.collapsed ? segments.slice(0, offset + 1).join(".") : key, result.value]);
    } else if (segments[0] === "profiles" && segments.length <= 2 && record(value)) {
      // `profiles` holds every profile; the flat form `profiles.<name>` holds one profile's settings.
      kept.push([key, segments.length === 1 ? entries(Object.entries(value).map(([name, profile]) => [name, record(profile) ? trimProfile(ctx, profile) : profile]))
        : trimProfile(ctx, value)]);
    } else kept.push([key, value]);
  }
  return entries(kept);
}

/** Trim a flat or nested config map (thread overrides or a settings snapshot) to the pinned gateway schema. */
export function trimGatewayFeatureConfig(input: Message, stats: TrimStats = { count: 0 }, strict = false): Message {
  const before = stats.count; const trimmed = trimConfig({ stats, strict }, input);
  // Untouched input comes back as the same object.
  return stats.count === before ? input : trimmed;
}

function withConfig(method: string, params: Message, strict: boolean, stats: TrimStats): Message {
  // experimentalFeature/enablement/set carries no thread id, so it is routed to the native engine and never reaches here.
  if (!["thread/start", "thread/resume", "thread/fork"].includes(method) || !record(params.config)) return params;
  const config = trimGatewayFeatureConfig(params.config, stats, strict);
  return config === params.config ? params : { ...params, config };
}

/** Trim the request parameters that carry feature settings; every other request is returned unchanged. */
export function trimGatewayFeatureRequest(method: string, params: Message, stats: TrimStats = { count: 0 }): Message {
  return withConfig(method, params, false, stats);
}

/** The retry form of a request: every feature table becomes its boolean `enabled` or is removed, and `tool_registry` is removed. */
export function strictGatewayFeatureRequest(method: string, params: Message, stats: TrimStats = { count: 0 }): Message {
  return withConfig(method, params, true, stats);
}

function trimOverride(ctx: Context, text: string): string | undefined {
  // The SDK splits a `-c` override at its first `=`, trims the key and splits it on every dot, as above.
  const at = text.indexOf("="); if (at < 0) return text;
  const name = text.slice(0, at).trim(); const segments = name.split(".");
  // Only keys that can hold features, or a profile that can, are read; every other override is left exactly as it was.
  if (!featureOffset(segments) && !(segments[0] === "profiles" && segments.length <= 2)) return text;
  const before = ctx.stats.count;
  const trimmed = trimConfig(ctx, { [name]: readValue(text.slice(at + 1)) });
  if (ctx.stats.count === before) return text;
  const result = Object.entries(trimmed)[0];
  return result && `${result[0]}=${writeInline(result[1])}`;
}

/** Trim `-c key=value` overrides (JSON or inline TOML values, in every CLI spelling) to the pinned gateway schema. Tables are written as TOML. */
export function trimGatewayFeatureArgs(input: string[], stats: TrimStats = { count: 0 }): string[] {
  const ctx: Context = { stats, strict: false };
  const result: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const arg = input[index]; const separate = arg === "-c" || arg === "--config"; const joined = arg.startsWith("--config=");
    const value = separate ? input[index + 1] : joined ? arg.slice("--config=".length) : undefined;
    if (value === undefined) { result.push(arg); continue; }
    if (separate) index++;
    const trimmed = trimOverride(ctx, value);
    if (trimmed !== undefined) result.push(...(separate ? [arg, trimmed] : ["--config=" + trimmed]));
  }
  return result;
}

/** Record how many entries a site changed, never which ones or their values. */
export function reportGatewayFeatureTrim(site: TrimSite, stats: TrimStats): void {
  if (stats.count > 0) telemetry("gateway_features_trimmed", { site, count: stats.count });
}

export function trimmedGatewayFeatures<T>(site: TrimSite, trim: (stats: TrimStats) => T): T {
  const stats: TrimStats = { count: 0 }; const result = trim(stats);
  reportGatewayFeatureTrim(site, stats); return result;
}
