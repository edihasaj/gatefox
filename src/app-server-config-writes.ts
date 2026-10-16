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

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, parse, resolve, sep } from "node:path";
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
 * spelling that leads to one through a symlink, a firmlink, or another case of the same name is
 * recognized as the file it reaches. See `GatewayPathGuard` for how a path is judged. */
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

/** A path longer than this is judged on its spelling alone; walking it would cost more than it can tell. */
const inspectPathBytes = 1024;
/** How many paths one prepared guard remembers; a batch that names more recomputes rather than grows. */
const guardMemoLimit = 4096;

/** What makes one file itself: the volume and the node the file system reads it as. A path that
 * reaches the same {dev, ino} through another spelling — a link, a firmlink, or another casing of a
 * directory on a case-insensitive volume — names the same file. */
type FileId = { dev: number; ino: number };
const sameFileId = (left: FileId | undefined, right: FileId | undefined): boolean =>
  left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;

/** The identity of the file a path names, or undefined where it cannot be read: nothing there, no
 * permission, or the path itself is unwalkable. Every failure means "not a match" here. */
const fileIdOf = (guard: GatewayPathGuard, path: string): FileId | undefined => {
  if (!guard.ids.has(path)) {
    let id: FileId | undefined;
    try { const stat = statSync(path); id = { dev: stat.dev, ino: stat.ino }; } catch { id = undefined; }
    if (guard.ids.size < guardMemoLimit) guard.ids.set(path, id);
  }
  return guard.ids.get(path);
};

/** The prefixes a resolved absolute path passes through, from the root down, one `stat` per component:
 * the ones that exist, whether or not the path itself does, and where the walk stopped. Reading down
 * instead of climbing up costs one call per component even when nothing below the root exists. */
const walkExisting = (guard: GatewayPathGuard, target: string): { ancestors: string[]; deepest: string; missing: string[] } => {
  const root = parse(target).root;
  const components = target.slice(root.length).split(sep).filter(component => component.length > 0);
  const ancestors: string[] = [];
  let current = root;
  for (let index = 0; index < components.length; index++) {
    const next = current === root ? root + components[index] : current + sep + components[index];
    if (fileIdOf(guard, next) === undefined) return { ancestors, deepest: current, missing: components.slice(index) };
    if (index < components.length - 1) ancestors.push(next);
    current = next;
  }
  return { ancestors, deepest: current, missing: [] };
};

/** The file a path names once the links along it are followed: its deepest existing ancestor resolved,
 * with the components below it — a file that is not written yet — kept as spelled. Where no ancestor
 * resolves, the lexical path is the answer; a path that does not exist is never an error here. */
const realFormOf = (guard: GatewayPathGuard, lexical: string): string => {
  const cached = guard.real.get(lexical);
  if (cached !== undefined) return cached;
  const { deepest, missing } = walkExisting(guard, lexical);
  const real = tryRealpath(deepest);
  const form = real === undefined ? lexical : resolve(real, ...missing);
  if (guard.real.size < guardMemoLimit) guard.real.set(lexical, form);
  return form;
};

/** A path in both spellings it can carry: the one written, and the one the file system reads it as.
 * A path too long to walk keeps only its spelling, and touching the file system stays off the table. */
const pathFormsOf = (guard: GatewayPathGuard, lexical: string): string[] => {
  if (Buffer.byteLength(lexical) > inspectPathBytes) return [lexical];
  const real = realFormOf(guard, lexical);
  return real === lexical ? [lexical] : [lexical, real];
};

/** The gateway's own paths for one batch of edits, judged once and remembered: both spellings of the
 * catalog, the state directory and the native home, the identity of the files that already exist, and
 * what each path the batch names turned out to be. The router builds this per call, so 20k edits that
 * repeat one path read the file system once. */
export type GatewayPathGuard = {
  identity: GatewayIdentity;
  /** Both spellings of the catalog file. */
  catalog: string[];
  /** The catalog file's identity, where it exists. */
  catalogId: FileId | undefined;
  /** Both spellings of the state directory, each carrying a trailing separator. */
  state: string[];
  /** The state directory's identity, where it exists. */
  stateId: FileId | undefined;
  /** Both spellings of the native home, the base a relative value reads against. */
  homes: string[];
  /** Per-path reads, kept so one call answers the same question the same way without repeating it. */
  real: Map<string, string>;
  ids: Map<string, FileId | undefined>;
  found: Map<string, boolean>;
};

const prepareGatewayPaths = (identity: GatewayIdentity): GatewayPathGuard => {
  const guard: GatewayPathGuard = {
    identity, catalog: [], catalogId: undefined, state: [], stateId: undefined, homes: [],
    real: new Map(), ids: new Map(), found: new Map(),
  };
  const catalog = resolve(identity.catalogPath);
  const state = resolve(identity.stateDirectory);
  guard.catalog = pathFormsOf(guard, catalog);
  guard.catalogId = fileIdOf(guard, catalog);
  guard.state = pathFormsOf(guard, state).map(dir => dir.endsWith(sep) ? dir : dir + sep);
  guard.stateId = fileIdOf(guard, state);
  guard.homes = pathFormsOf(guard, resolve(identity.nativeHome));
  return guard;
};

/** The spellings a target shares with the gateway's files: the catalog named outright, or the state
 * directory as a prefix. These decide a path the file system cannot answer, and back up identity checks. */
const spelledAsGateway = (guard: GatewayPathGuard, target: string): boolean =>
  guard.catalog.some(catalog => target === catalog) || guard.state.some(dir => target.startsWith(dir));

/** Whether the file a target names is one of the gateway's, read off the volume rather than the
 * spelling: the catalog itself, or anything under the state directory, whichever link or casing reached it. */
const isGatewayFile = (guard: GatewayPathGuard, target: string): boolean => {
  const cached = guard.found.get(target);
  if (cached !== undefined) return cached;
  const found = sameFileId(fileIdOf(guard, target), guard.catalogId)
    || (guard.stateId !== undefined && walkExisting(guard, target).ancestors.some(dir => sameFileId(fileIdOf(guard, dir), guard.stateId)));
  if (guard.found.size < guardMemoLimit) guard.found.set(target, found);
  return found;
};

/** True when a string names the gateway catalog or anything inside the gateway's state directory.
 * The engine opens a file, not a spelling, so the guard reads the file a path reaches: every base a
 * relative value can read against is tried, and each spelling it lands on is judged both as a path and,
 * where it exists, by identity. A path too long to walk is judged on its spelling alone. */
const holdsGatewayCatalogPath = (value: unknown, guard: GatewayPathGuard): boolean => {
  if (typeof value !== "string") return false;
  for (const base of guard.homes) {
    const lexical = resolve(expandEnginePath(value, guard.identity, base));
    if (Buffer.byteLength(lexical) > inspectPathBytes) { if (spelledAsGateway(guard, lexical)) return true; continue; }
    for (const target of pathFormsOf(guard, lexical)) {
      if (spelledAsGateway(guard, target) || isGatewayFile(guard, target)) return true;
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
const scanValue = (value: unknown, guard: GatewayPathGuard, depth: number): Finding => {
  const identity = guard.identity;
  if (value === null || typeof value !== "object") return "clear";
  if (depth > identitySearchDepth) return "too-deep";
  if (Array.isArray(value)) {
    for (const item of value) { const found = scanValue(item, guard, depth + 1); if (found !== "clear") return found; }
    return "clear";
  }
  for (const [key, item] of Object.entries(value as ObjectValue)) {
    if (isModelBearingKey(key) && identity.isGatewayModel(item)) return "identity";
    if (isProviderKey(key) && item === identity.provider) return "identity";
    if (key === "model_providers" && holdsGatewayProviderRow(item, identity.provider)) return "identity";
    if (key === "model_catalog_json" && holdsGatewayCatalogPath(item, guard)) return "catalog";
  }
  for (const item of Object.values(value as ObjectValue)) { const found = scanValue(item, guard, depth + 1); if (found !== "clear") return found; }
  return "clear";
};

/** Why a single native edit must be refused, or undefined when the native engine may apply it. */
export const nativeEditViolation = (edit: unknown, identity: GatewayIdentity, prepared?: GatewayPathGuard): string | undefined => {
  if (!plain(edit)) return undefined; // forwarded to the engine as sent; it is not an edit this module can read
  const guard = prepared ?? prepareGatewayPaths(identity);
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
  if (last === "model_catalog_json" && holdsGatewayCatalogPath(value, guard)) return gatewayCatalogMessage;
  const found = scanValue(value, guard, 0);
  return found === "clear" ? undefined : found === "catalog" ? gatewayCatalogMessage : gatewayIdentityMessage;
};

/** The first refusal a batch of native edits earns, or undefined when all of them may be forwarded.
 * The gateway's paths are read once for the batch and handed to every edit in it. */
export const nativeWritesViolation = (edits: unknown[], identity: GatewayIdentity): string | undefined => {
  const guard = prepareGatewayPaths(identity);
  for (const edit of edits) { const refusal = nativeEditViolation(edit, identity, guard); if (refusal) return refusal; }
  return undefined;
};
