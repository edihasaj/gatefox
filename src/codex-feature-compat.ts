import { object, type Message } from "./app-server-connection.js";

const removed = new Set(["code_mode_tool_description_first", "guardianv2.thread_context"]);
const record = (value: unknown): value is Message => !!value && typeof value === "object" && !Array.isArray(value);
const owns = (value: Message, key: string) => Object.hasOwn(value, key);
const featurePath = (key: string): { prefix: string; name: string } | undefined => {
  const match = /^(features|profiles\..+\.features)\.(.+)$/.exec(key);
  return match ? { prefix: match[1], name: match[2] } : undefined;
};
const featureContainer = (key: string) => key === "features" || /^profiles\..+\.features$/.test(key);
function featureScope(prefix: string): string {
  if (prefix === "features") return prefix;
  let profile = prefix.slice("profiles.".length, -".features".length);
  if (profile.startsWith('"')) { try { profile = JSON.parse(profile) as string; } catch { return prefix; } }
  else if (profile.startsWith("'") && profile.endsWith("'")) profile = profile.slice(1, -1);
  return `profiles.${JSON.stringify(profile)}.features`;
}

function canonicalHooks(input: Message, base = "", result = new Set<string>()): Set<string> {
  for (const [key, value] of Object.entries(input)) {
    const full = base + key; const path = featurePath(full);
    if (path?.name === "hooks") result.add(featureScope(path.prefix));
    if (featureContainer(full) && record(value) && owns(value, "hooks")) result.add(featureScope(full));
    if (key === "profiles" && record(value)) for (const [name, profile] of Object.entries(value)) if (record(profile)) canonicalHooks(profile, base + `profiles.${JSON.stringify(name)}.`, result);
  }
  return result;
}

function normalizeFeatures(input: Message, explicitHooks: boolean): Message {
  const result = { ...input };
  if (owns(input, "codex_hooks") && !explicitHooks) result.hooks = input.codex_hooks;
  delete result.codex_hooks;
  for (const key of removed) delete result[key];
  if (record(result.guardianv2)) { result.guardianv2 = { ...result.guardianv2 }; delete (result.guardianv2 as Message).thread_context; }
  return result;
}

function normalizeConfig(input: Message, canonical: Set<string>, base = ""): Message {
  const result: Message = {};
  for (const [key, value] of Object.entries(input)) {
    const full = base + key; const path = featurePath(full);
    if (path && removed.has(path.name)) continue;
    if (path?.name === "codex_hooks") {
      if (!canonical.has(featureScope(path.prefix))) result[key.slice(0, -"codex_hooks".length) + "hooks"] = value;
      continue;
    }
    if (featureContainer(full) && record(value)) result[key] = normalizeFeatures(value, canonical.has(featureScope(full)));
    else if (path?.name === "guardianv2" && record(value)) { const guardian = { ...value }; delete guardian.thread_context; result[key] = guardian; }
    else if (key === "profiles" && record(value)) result[key] = Object.fromEntries(Object.entries(value).map(([name, profile]) => [name, record(profile) ? normalizeConfig(profile, canonical, base + `profiles.${JSON.stringify(name)}.`) : profile]));
    else result[key] = value;
  }
  return result;
}

/** Normalize three obsolete feature keys without changing other SDK settings. */
export function normalizeCodexFeatureConfig(input: Message, base: Message = {}): Message { return normalizeConfig(input, new Set([...canonicalHooks(base), ...canonicalHooks(input)])); }

export function normalizeCodexFeatureRequest(method: string, params: Message, base: Message = {}): Message {
  if (["thread/start", "thread/resume", "thread/fork"].includes(method) && record(params.config)) return { ...params, config: normalizeCodexFeatureConfig(params.config, base) };
  if (method === "experimentalFeature/enablement/set" && record(params.enablement)) return { ...params, enablement: normalizeFeatures(params.enablement, owns(params.enablement, "hooks") || canonicalHooks(base).has("features")) };
  return params;
}

interface InlineField { key: string; value: string; original: string; rawKey: string }
/** Split only a complete inline table; quoted values and nested tables/arrays stay intact. */
function inlineFields(value: string): InlineField[] | undefined {
  const text = value.trim(); if (!text.startsWith("{") || !text.endsWith("}")) return;
  const body = text.slice(1, -1); const parts: string[] = []; let from = 0; let depth = 0; let quote = ""; let escaped = false;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (quote) { if (escaped) escaped = false; else if (quote === '"' && char === "\\") escaped = true; else if (char === quote) quote = ""; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") { if (--depth < 0) return; }
    else if (char === "," && depth === 0) { parts.push(body.slice(from, index)); from = index + 1; }
  }
  if (quote || depth) return;
  parts.push(body.slice(from)); const fields: InlineField[] = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    const match = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*([\s\S]+?)\s*$/.exec(part);
    if (!match) return;
    let key = match[1];
    if (key.startsWith('"')) { try { key = JSON.parse(key) as string; } catch { return; } }
    else if (key.startsWith("'")) key = key.slice(1, -1);
    fields.push({ key, value: match[2], original: part.trim(), rawKey: match[1] });
  }
  return fields;
}

function normalizeInline(value: string, guardian: boolean, explicitHooks: boolean): string {
  const fields = inlineFields(value); if (!fields) return value;
  const canonical = explicitHooks || fields.some(field => field.key === "hooks"); let changed = false; const parts: string[] = [];
  for (const field of fields) {
    if (guardian ? field.key === "thread_context" : removed.has(field.key)) { changed = true; continue; }
    if (!guardian && field.key === "codex_hooks") { changed = true; if (!canonical) parts.push(`hooks = ${field.value}`); continue; }
    if (!guardian && field.key === "guardianv2") {
      const nested = normalizeInline(field.value, true, false);
      if (nested !== field.value) { changed = true; parts.push(`${field.rawKey} = ${nested}`); continue; }
    }
    parts.push(field.original);
  }
  return changed ? `{ ${parts.join(", ")} }` : value;
}

function normalizeOverride(value: string, canonical: Set<string>): string | undefined {
  const index = value.indexOf("="); if (index < 0) return value;
  const key = value.slice(0, index).trim(); const raw = value.slice(index + 1); const path = featurePath(key);
  if (path && removed.has(path.name)) return;
  if (path?.name === "codex_hooks") return canonical.has(featureScope(path.prefix)) ? undefined : key.slice(0, -"codex_hooks".length) + "hooks=" + raw;
  if (!featureContainer(key) && path?.name !== "guardianv2") return value;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return key + "=" + normalizeInline(raw, path?.name === "guardianv2", canonical.has(featureScope(key))); }
  if (!record(parsed)) return value;
  const normalized = path?.name === "guardianv2" ? { ...parsed } : normalizeFeatures(parsed, canonical.has(featureScope(key)));
  if (path?.name === "guardianv2") delete normalized.thread_context;
  return JSON.stringify(normalized) === JSON.stringify(parsed) ? value : key + "=" + JSON.stringify(normalized);
}

/** Apply the same feature compatibility to known app-server CLI override forms. */
export function normalizeCodexFeatureArgs(input: string[], base: Message = {}): string[] {
  const canonical = canonicalHooks(base);
  const override = (arg: string, next?: string) => ["-c", "--config"].includes(arg) ? next : arg.startsWith("--config=") ? arg.slice(9) : undefined;
  const feature = (arg: string, next?: string) => ["--enable", "--disable"].includes(arg) ? next : /^(--enable|--disable)=/.test(arg) ? arg.slice(arg.indexOf("=") + 1) : undefined;
  for (let index = 0; index < input.length; index++) {
    const flags = feature(input[index], input[index + 1]); if (flags === "hooks") canonical.add("features");
    const value = override(input[index], input[index + 1]); if (!value) continue;
    const at = value.indexOf("="); const key = value.slice(0, at).trim(); const path = featurePath(key);
    if (path?.name === "hooks") canonical.add(featureScope(path.prefix));
    if (featureContainer(key)) {
      const raw = value.slice(at + 1); let parsed: unknown; try { parsed = JSON.parse(raw); } catch { /* Inline TOML is inspected below. */ }
      if (record(parsed) && owns(parsed, "hooks") || inlineFields(raw)?.some(field => field.key === "hooks")) canonical.add(featureScope(key));
    }
  }
  const result: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const arg = input[index]; const value = override(arg, input[index + 1]); const flags = feature(arg, input[index + 1]);
    if (value !== undefined) {
      const normalized = normalizeOverride(value, canonical);
      if (["-c", "--config"].includes(arg)) { index++; if (normalized !== undefined) result.push(arg, normalized); }
      else if (normalized !== undefined) result.push("--config=" + normalized);
    } else if (flags !== undefined) {
      const name = removed.has(flags) || flags === "codex_hooks" && canonical.has("features") ? undefined : flags === "codex_hooks" ? "hooks" : flags;
      if (["--enable", "--disable"].includes(arg)) { index++; if (name !== undefined) result.push(arg, name); }
      else if (name !== undefined) result.push(arg.slice(0, arg.indexOf("=") + 1) + name);
    } else result.push(arg);
  }
  return result;
}

function hookValues(input: Message, legacy: boolean, base = "", result = new Map<string, unknown>()): Map<string, unknown> {
  const name = legacy ? "codex_hooks" : "hooks";
  for (const [key, value] of Object.entries(input)) {
    const full = base + key; const path = featurePath(full);
    if (path?.name === name) result.set(featureScope(path.prefix), value);
    if (featureContainer(full) && record(value) && owns(value, name)) result.set(featureScope(full), value[name]);
    if (key === "profiles" && record(value)) for (const [profile, settings] of Object.entries(value)) if (record(settings)) hookValues(settings, legacy, base + `profiles.${JSON.stringify(profile)}.`, result);
  }
  return result;
}

export function hasLegacyCodexHookConfig(input: Message): boolean { return hookValues(input, true).size > 0; }

/** Record only which CLI scopes acquire a synthetic canonical key, never raw arguments. */
export function rewrittenCodexHookScopes(input: string[], base: Message): Set<string> {
  const config: Message = {};
  for (let index = 0; index < input.length; index++) {
    const arg = input[index];
    if (["--enable", "--disable"].includes(arg) || /^(--enable|--disable)=/.test(arg)) {
      const names = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : input[++index];
      if (names && ["hooks", "codex_hooks"].includes(names)) config[`features.${names}`] = true;
    } else if (["-c", "--config"].includes(arg) || arg.startsWith("--config=")) {
      const value = arg.startsWith("--config=") ? arg.slice(9) : input[++index]; if (!value) continue;
      const at = value.indexOf("="); if (at < 0) continue; const key = value.slice(0, at).trim(); const raw = value.slice(at + 1);
      const path = featurePath(key);
      if (path && ["hooks", "codex_hooks"].includes(path.name)) config[key] = true;
      else if (featureContainer(key)) {
        let parsed: unknown; try { parsed = JSON.parse(raw); } catch { parsed = Object.fromEntries((inlineFields(raw) || []).filter(field => ["hooks", "codex_hooks"].includes(field.key)).map(field => [field.key, true])); }
        if (record(parsed)) config[key] = parsed;
      }
    }
  }
  const canonical = new Set([...canonicalHooks(base), ...canonicalHooks(config)]);
  return new Set([...hookValues(config, true).keys()].filter(scope => !canonical.has(scope)));
}

/** Resolve canonical lower-layer values hidden by an adapter-created CLI alias rewrite. */
export function scopedCodexFeatureBase(response: Message, rewritten: Set<string>): { base: Message; corrections: Message } {
  if (!record(response.config)) throw Object.assign(new Error("Codex feature settings are unavailable; retry when configuration loading completes."), { code: -32001 });
  const base = { ...response.config }; const corrections: Message = {};
  if (!rewritten.size) return { base, corrections };
  if (!Array.isArray(response.layers)) throw Object.assign(new Error("Codex feature layers are unavailable; deprecated hooks settings were not applied."), { code: -32001 });
  const found = new Set<string>(); const canonical = hookValues(base, false);
  for (const scope of rewritten) canonical.delete(scope);
  for (const value of response.layers) {
    const layer = object(value); if (layer.disabledReason != null || object(layer.name).type === "sessionFlags") continue;
    for (const [scope, enabled] of hookValues(object(layer.config), false)) if (rewritten.has(scope) && !found.has(scope)) {
      if (typeof enabled !== "boolean") throw Object.assign(new Error("Codex hooks settings must be boolean; the deprecated override was not applied."), { code: -32001 });
      found.add(scope); canonical.set(scope, enabled); corrections[`${scope}.hooks`] = enabled;
    }
  }
  // Return only canonical presence needed by this compatibility rule.
  return { base: Object.fromEntries([...canonical].map(([scope, enabled]) => [`${scope}.hooks`, enabled])), corrections };
}

export function applyCodexHookCorrections(config: Message, corrections: Message): Message {
  const result = { ...config }; const explicit = canonicalHooks(config);
  for (const [key, value] of Object.entries(corrections)) {
    const path = featurePath(key); if (path && !explicit.has(featureScope(path.prefix))) result[key] = value;
  }
  return result;
}
