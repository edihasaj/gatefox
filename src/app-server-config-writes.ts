/**
 * Decides what the desktop adapter may do with a Codex configuration write.
 *
 * The adapter owns only its own default selections and display settings, which live in a
 * private file. Every other key is the caller's native configuration and reaches the native
 * engine unchanged, exactly as it would without the gateway. The one thing that must never
 * happen is a native file that remembers a gateway model, the gateway provider, or the
 * gateway's catalog file: those rows exist only while the adapter is running, so a write that
 * stores one is refused before anything is written or forwarded. Key paths are judged on the
 * segments the engine parses, never on the raw spelling, and a path it cannot parse is refused.
 * A file path is judged the same way: on the file it names, whichever spelling reached it.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { isDesktopPreferenceKey } from "./desktop-preferences.js";
import { parseKeyPath } from "./app-server-config-writes-key-path.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const plain = (value: unknown): value is ObjectValue => object(value) === value && value !== null && !Array.isArray(value);

/** Keys the adapter keeps in its private preference file; they never reach native configuration. */
export const gatewayPreferenceKeys = new Set(["model", "model_reasoning_effort", "model_reasoning_summary", "service_tier"]);

/** How many objects or arrays below the written value a search still reads; a deeper container is refused. */
const identitySearchDepth = 64;

export const gatewayProfileMessage = "Gateway defaults cannot be saved into a native Codex profile";
export const gatewayIdentityMessage = "Gateway models and the gateway provider cannot be saved into native Codex configuration";
export const gatewayTargetMessage = "Native configuration changes cannot target the gateway preference file";
export const gatewayCatalogMessage = "The gateway catalog cannot be saved into native Codex configuration";
export const invalidKeyPathMessage = "This configuration key is not valid";
export const gatewayPreferenceSpellingMessage = "Gateway defaults must be written with their plain key";

/** What counts as gateway identity, supplied by the router. Paths are compared as files, so a
 * spelling that leads to one through a symlink is recognized as the file it reaches. */
export type GatewayIdentity = {
  /** The native provider id the gateway registers itself under. */
  provider: string;
  /** True for a model name only the gateway catalog offers. */
  isGatewayModel: (value: unknown) => boolean;
  /** The gateway's resolved state directory; every file inside it belongs to the gateway. */
  stateDirectory: string;
  /** The catalog file config/read overlays onto chat settings; it must never land in a native file. */
  catalogPath: string;
  /** The user's home directory, which the engine expands a lone `~` and `~/rest` against. */
  homeDirectory: string;
  /** The native home the engine resolves a relative path against, spelled lexically. A link that
   * leads elsewhere is that same home to the engine, so the guard reads both of its spellings. */
  nativeHome: string;
};

/** The edits a configuration write carries in their original form: the request itself for a
 * value write, the batch list otherwise; a batch without a list carries none. */
export const configEdits = (method: string, params: ObjectValue): unknown[] =>
  method === "config/value/write" ? [params] : Array.isArray(params.edits) ? params.edits : [];

/** The path the adapter keeps private, judged on the segments the engine parses: one private key,
 * or a supported `desktop.*` display key. A quoted spelling of one of these is still this path. */
const isGatewayPreferencePath = (segments: string[]): boolean =>
  segments.length === 1 ? gatewayPreferenceKeys.has(segments[0]!)
  : segments.length === 2 && segments[0] === "desktop" && isDesktopPreferenceKey(segments.join("."));

/** The dotted spelling this parsed path would have carried unquoted; anything else is quoted or escaped. */
const plainSpelling = (keyPath: unknown, segments: string[]): boolean => keyPath === segments.join(".");

/** An edit the adapter answers itself, from its private preference file. A value it cannot read,
 * including `null` or a bare string in a batch, belongs to the native engine and is forwarded as sent.
 * A private key spelled another way (for example `"model"`) is not one: it reaches the native guard,
 * which refuses it rather than saving a key the engine would apply somewhere else. */
export const isGatewayPreferenceEdit = (edit: unknown): boolean => {
  if (!plain(edit) || typeof (edit as ObjectValue).keyPath !== "string") return false;
  const segments = parseKeyPath((edit as ObjectValue).keyPath);
  return segments !== undefined && isGatewayPreferencePath(segments) && plainSpelling((edit as ObjectValue).keyPath, segments);
};

/** Splits a request by index into what the adapter saves and what only the native engine may apply.
 * Native entries stay the caller's own objects, in the caller's own order, so dropping the private
 * part of a batch cannot rewrite or reorder the rest of it. */
export const partitionConfigEdits = (edits: unknown[]): { privateEdits: ObjectValue[]; nativeEdits: unknown[] } => ({
  privateEdits: edits.filter(isGatewayPreferenceEdit).map(object),
  nativeEdits: edits.filter(edit => !isGatewayPreferenceEdit(edit)),
});

// A provider row only identifies the gateway while it holds something; a cleared row is a deletion.
const holdsGatewayProviderRow = (value: unknown, provider: string): boolean =>
  plain(value) && Object.hasOwn(value, provider) && value[provider] !== null;

/** The path the engine reads a string as, resolving anything merely relative to it against `base`: a
 * lone `~` is the home directory; `~/rest` is home with `rest` below it, where only a slash is the
 * separator after the tilde (Windows reads `~\rest` the same way, and trims backslashes there); an
 * absolute path is used as sent; and every other value, `~rest` included, resolves below the base. */
const expandEnginePath = (value: string, identity: GatewayIdentity, base: string): string => {
  // A tilde the engine does not expand is just a character in a relative name, so it stays below the
  // base, and `..` is read lexically: it climbs the path as spelled, following no links of its own.
  if (value === "~") return resolve(identity.homeDirectory);
  if (value.startsWith("~/")) return resolve(identity.homeDirectory, value.slice(2).replace(/^\/+/, ""));
  if (process.platform === "win32" && value.startsWith("~\\")) return resolve(identity.homeDirectory, value.slice(2).replace(/^\\+/, ""));
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
};

const tryRealpath = (path: string): string | undefined => { try { return realpathSync(path); } catch { return undefined; } };

/** The file a path names once the links along it are followed: its deepest existing ancestor resolved,
 * with the components below it — a file that is not written yet — kept as spelled. Where no ancestor
 * resolves, the lexical path is the answer; a path that does not exist is never an error here. */
const realForm = (target: string): string => {
  const missing: string[] = [];
  for (let current = target; ; ) {
    const real = tryRealpath(current);
    if (real !== undefined) return resolve(real, ...missing);
    const parent = dirname(current);
    if (parent === current) return target;
    missing.unshift(basename(current));
    current = parent;
  }
};

/** A path in both spellings it can carry: the one written, and the one the file system reads it as. */
const pathForms = (value: string): string[] => {
  const lexical = resolve(value);
  const real = realForm(lexical);
  return real === lexical ? [lexical] : [lexical, real];
};

/** True when a string names the gateway catalog or anything inside the gateway's state directory.
 * The engine opens a file, not a spelling, so a link that leads there is there: each base a relative
 * value can read against is tried, and the path it lands on is judged in both of its forms. */
const holdsGatewayCatalogPath = (value: unknown, identity: GatewayIdentity): boolean => {
  if (typeof value !== "string") return false;
  const catalog = pathForms(identity.catalogPath);
  const stateDirectories = pathForms(identity.stateDirectory).map(dir => dir.endsWith(sep) ? dir : dir + sep);
  for (const base of pathForms(identity.nativeHome)) {
    for (const target of pathForms(expandEnginePath(value, identity, base))) {
      if (catalog.some(path => target === path)) return true;
      if (stateDirectories.some(dir => target.startsWith(dir))) return true;
    }
  }
  return false;
};

/** A key that carries the model a profile or block runs: `model` itself, or a `*_model` variant such as `review_model`. */
const isModelBearingKey = (key: string): boolean => key === "model" || key.endsWith("_model");

/** The keys that name the provider a profile or block runs on; both can point at the gateway. */
const isProviderKey = (key: string): boolean => key === "model_provider" || key === "oss_provider";

const isProviderRowPath = (segments: string[], provider: string): boolean =>
  segments.some((segment, index) => segment === "model_providers" && segments[index + 1] === provider);

type Finding = "clear" | "identity" | "catalog" | "too-deep";
// A profile or plugin block can carry its own model settings; search it the way the engine reads it back.
const scanValue = (value: unknown, identity: GatewayIdentity, depth: number): Finding => {
  if (value === null || typeof value !== "object") return "clear";
  if (depth > identitySearchDepth) return "too-deep";
  if (Array.isArray(value)) {
    for (const item of value) { const found = scanValue(item, identity, depth + 1); if (found !== "clear") return found; }
    return "clear";
  }
  for (const [key, item] of Object.entries(value as ObjectValue)) {
    if (isModelBearingKey(key) && identity.isGatewayModel(item)) return "identity";
    if (isProviderKey(key) && item === identity.provider) return "identity";
    if (key === "model_providers" && holdsGatewayProviderRow(item, identity.provider)) return "identity";
    if (key === "model_catalog_json" && holdsGatewayCatalogPath(item, identity)) return "catalog";
  }
  for (const item of Object.values(value as ObjectValue)) { const found = scanValue(item, identity, depth + 1); if (found !== "clear") return found; }
  return "clear";
};

/** Why a single native edit must be refused, or undefined when the native engine may apply it. */
export const nativeEditViolation = (edit: unknown, identity: GatewayIdentity): string | undefined => {
  if (!plain(edit)) return undefined; // forwarded to the engine as sent; it is not an edit this module can read
  const { keyPath, value } = edit;
  const segments = parseKeyPath(keyPath);
  if (!segments) return invalidKeyPathMessage;
  // A gateway default the engine would apply as a native key: refuse the spelling, not just the value.
  if (isGatewayPreferencePath(segments) && !plainSpelling(keyPath, segments)) return gatewayPreferenceSpellingMessage;
  const last = segments[segments.length - 1]!;
  if (isModelBearingKey(last) && identity.isGatewayModel(value)) return last === "model" ? gatewayProfileMessage : gatewayIdentityMessage;
  if (isProviderKey(last) && value === identity.provider) return gatewayIdentityMessage;
  // Saving any row of the gateway provider is refused; clearing one with null must stay possible.
  if (value !== null && isProviderRowPath(segments, identity.provider)) return gatewayIdentityMessage;
  if (last === "model_providers" && holdsGatewayProviderRow(value, identity.provider)) return gatewayIdentityMessage;
  if (last === "model_catalog_json" && holdsGatewayCatalogPath(value, identity)) return gatewayCatalogMessage;
  const found = scanValue(value, identity, 0);
  return found === "clear" ? undefined : found === "catalog" ? gatewayCatalogMessage : gatewayIdentityMessage;
};

/** The first refusal a batch of native edits earns, or undefined when all of them may be forwarded. */
export const nativeWritesViolation = (edits: unknown[], identity: GatewayIdentity): string | undefined => {
  for (const edit of edits) { const refusal = nativeEditViolation(edit, identity); if (refusal) return refusal; }
  return undefined;
};
