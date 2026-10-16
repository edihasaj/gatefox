import type { Message } from "./app-server-connection.js";
import { featureContainer, featurePath, inlineFields, record } from "./codex-feature-compat.js";
import { telemetry } from "./telemetry.js";

/**
 * Structured `[features]` entries of the pinned gateway SDK (codex 0.162.0-alpha.17.2) and the fields each
 * accepts. Source: openai/codex revision 740e5af, codex-rs/features/src/lib.rs (`FeaturesToml`) and
 * codex-rs/features/src/feature_configs.rs. Every other feature key must be a plain boolean there, and each
 * structured table denies unknown fields. ChatGPT picks the features it sends from the NATIVE engine's
 * version, which can be newer than this SDK, so gateway-only paths trim settings to this schema.
 */
const structured = new Map<string, ReadonlySet<string>>(Object.entries({
  tool_registry: ["error_on_tool_collisions", "turn_metadata_includes_tool_info"],
  code_mode: ["enabled", "default_exec_yield_time_ms", "experimental_show_cell_overhead", "tool_input_schema_max_bytes", "excluded_tool_namespaces", "direct_only_tool_namespaces"],
  code_mode_host: ["enabled", "disable_in_process_fallback"],
  non_prefixed_mcp_tool_names: ["enabled", "server_names"],
  guardianv2: ["async_classifier_mode", "async_classifier_conversation_token_limit", "enabled", "free_guardian", "thread_context", "persist_scores", "classifier_instructions",
    "review_threshold", "max_tool_call_lag", "reasoning_effort", "max_action_tokens", "max_classifier_instruction_tokens", "reuse_parent_compaction", "max_parent_compaction_tokens",
    "review_scope", "transcript"],
  multi_agent_v2: ["enabled", "max_concurrent_threads_per_session", "min_wait_timeout_ms", "max_wait_timeout_ms", "default_wait_timeout_ms", "usage_hint_enabled", "usage_hint_text",
    "root_agent_usage_hint_text", "subagent_usage_hint_text", "subagent_developer_instructions", "multi_agent_mode_hint_text", "tool_namespace", "hide_spawn_agent_metadata",
    "expose_spawn_agent_model_overrides", "wait_agent_enabled", "disable_direct_message", "message_board_in_memory", "message_board_remote", "non_code_mode_only"],
  token_budget: ["enabled", "use_history_notes_extension", "reminder_threshold_tokens", "reminder_message_template", "guidance_message", "auto_compact_fallback_prompt", "auto_compact_fallback_buffer_tokens"],
  context_management: ["experimental_mode"],
  rollout_budget: ["enabled", "limit_tokens", "reminder_at_remaining_tokens", "sampling_token_weight", "prefill_token_weight"],
  current_time_reminder: ["enabled", "reminder_interval_seconds", "clock_source", "delivery_mode", "sleep_tool"],
  sleep_tool: ["enabled", "mode"],
  network_proxy: ["enabled", "proxy_url", "enable_socks5", "socks_url", "enable_socks5_udp", "allow_upstream_proxy", "dangerously_allow_non_loopback_proxy",
    "dangerously_allow_all_unix_sockets", "mode", "domains", "unix_sockets", "allow_local_binding", "credential_broker", "credentials"],
}).map(([name, fields]) => [name, new Set(fields)] as const));
/** The SDK reads and discards this key, so its value is never trimmed. */
const passthrough = new Set(["apps_mcp_path_override"]);

export type TrimSite = "request" | "spawn" | "home";
export interface TrimStats { count: number }

/** Text of a TOML value this module does not interpret; kept verbatim. */
class Raw { constructor(readonly text: string) {} }
const table = (value: unknown): value is Message => record(value) && !(value instanceof Raw);

function readInline(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const fields = inlineFields(trimmed);
  return fields ? Object.fromEntries(fields.map(field => [field.key, readInline(field.value)])) : new Raw(trimmed);
}

/** A `-c` value is JSON, else inline TOML; anything else cannot be trimmed safely. */
function readValue(raw: string): { value: unknown; json: boolean } | undefined {
  try { return { value: JSON.parse(raw), json: true }; } catch { /* Inline TOML is read below. */ }
  const value = readInline(raw);
  return value instanceof Raw ? undefined : { value, json: false };
}

function writeInline(value: unknown): string {
  if (value instanceof Raw) return value.text;
  if (typeof value === "boolean") return String(value);
  if (!table(value)) return JSON.stringify(value);
  const entries = Object.entries(value).map(([key, entry]) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)} = ${writeInline(entry)}`);
  return entries.length ? `{ ${entries.join(", ")} }` : "{}";
}

const split = (name: string): { feature: string; field?: string } => {
  const dot = name.indexOf(".");
  return dot < 0 ? { feature: name } : { feature: name.slice(0, dot), field: name.slice(dot + 1) };
};

/** True when the entry's fate depends on its value, not only on its name. */
function needsValue(name: string): boolean {
  const { feature, field } = split(name);
  if (passthrough.has(feature)) return false;
  return field === undefined || (!structured.has(feature) && field === "enabled");
}

/** Apply the pinned schema to one feature entry; `name` is `K` or `K.F`. Returns undefined when it is dropped. */
function trimEntry(name: string, value: unknown, stats: TrimStats): { name: string; value: unknown } | undefined {
  const { feature, field } = split(name); const allowed = structured.get(feature);
  if (passthrough.has(feature)) return { name, value };
  if (field !== undefined) {
    if (allowed) { if (allowed.has(field.split(".")[0])) return { name, value }; stats.count++; return; }
    stats.count++;
    return field === "enabled" && typeof value === "boolean" ? { name: feature, value } : undefined;
  }
  if (typeof value === "boolean") return { name, value };
  if (table(value)) {
    if (allowed) {
      const kept = Object.entries(value).filter(([key]) => allowed.has(key));
      if (kept.length === Object.keys(value).length) return { name, value };
      stats.count++; return { name, value: Object.fromEntries(kept) };
    }
    stats.count++;
    return typeof value.enabled === "boolean" ? { name, value: value.enabled } : undefined;
  }
  stats.count++;
}

function trimTable(input: Message, stats: TrimStats): Message {
  const result: Message = {};
  for (const [name, value] of Object.entries(input)) {
    const entry = trimEntry(name, value, stats);
    if (entry) result[entry.name] = entry.value;
  }
  return result;
}

function trimConfig(input: Message, stats: TrimStats, base = ""): Message {
  const result: Message = {};
  for (const [key, value] of Object.entries(input)) {
    const full = base + key; const path = featurePath(full);
    if (featureContainer(full) && record(value)) result[key] = trimTable(value, stats);
    else if (path) {
      const entry = trimEntry(path.name, value, stats);
      if (entry) result[key.slice(0, Math.max(0, key.length - path.name.length)) + entry.name] = entry.value;
    } else if (key === "profiles" && record(value)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, profile]) => [name, record(profile) ? trimConfig(profile, stats, base + `profiles.${JSON.stringify(name)}.`) : profile]));
    } else result[key] = value;
  }
  return result;
}

/** Trim a flat or nested config map (thread overrides or a settings snapshot) to the pinned gateway schema. */
export function trimGatewayFeatureConfig(input: Message, stats: TrimStats = { count: 0 }): Message {
  const before = stats.count; const trimmed = trimConfig(input, stats);
  return stats.count === before ? input : trimmed;
}

/** Trim the request parameters that carry feature settings; every other request is returned unchanged. */
export function trimGatewayFeatureRequest(method: string, params: Message, stats: TrimStats = { count: 0 }): Message {
  const before = stats.count;
  if (["thread/start", "thread/resume", "thread/fork"].includes(method) && record(params.config)) {
    const config = trimConfig(params.config, stats);
    return stats.count === before ? params : { ...params, config };
  }
  if (method === "experimentalFeature/enablement/set" && record(params.enablement)) {
    const enablement = trimTable(params.enablement, stats);
    return stats.count === before ? params : { ...params, enablement };
  }
  return params;
}

function trimOverride(value: string, stats: TrimStats): string | undefined {
  const at = value.indexOf("="); if (at < 0) return value;
  const key = value.slice(0, at).trim(); const raw = value.slice(at + 1); const before = stats.count;
  if (featureContainer(key)) {
    const parsed = readValue(raw);
    if (!parsed || !table(parsed.value)) { stats.count++; return; }
    const trimmed = trimTable(parsed.value, stats);
    return stats.count === before ? value : `${key}=${parsed.json ? JSON.stringify(trimmed) : writeInline(trimmed)}`;
  }
  const path = featurePath(key); if (!path) return value;
  const parsed = needsValue(path.name) ? readValue(raw) : undefined;
  if (needsValue(path.name) && !parsed) { stats.count++; return; }
  const entry = trimEntry(path.name, parsed?.value, stats);
  if (!entry) return;
  if (stats.count === before) return value;
  return `${key.slice(0, key.length - path.name.length)}${entry.name}=${parsed?.json === false ? writeInline(entry.value) : JSON.stringify(entry.value)}`;
}

/** Trim `-c key=value` overrides (JSON or inline TOML, in every CLI spelling) to the pinned gateway schema. */
export function trimGatewayFeatureArgs(input: string[], stats: TrimStats = { count: 0 }): string[] {
  const result: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const arg = input[index]; const separate = arg === "-c" || arg === "--config"; const joined = arg.startsWith("--config=");
    const value = separate ? input[index + 1] : joined ? arg.slice("--config=".length) : undefined;
    if (value === undefined) { result.push(arg); continue; }
    if (separate) index++;
    const trimmed = trimOverride(value, stats);
    if (trimmed !== undefined) result.push(...(separate ? [arg, trimmed] : ["--config=" + trimmed]));
  }
  return result;
}

/** Record how many entries a site changed, never which ones or their values. */
export function reportGatewayFeatureTrim(site: TrimSite, stats: TrimStats): void {
  if (stats.count > 0) telemetry("gateway_features_trimmed", { site, count: stats.count });
}

export function trimmedGatewayFeatures<T>(site: TrimSite, run: (stats: TrimStats) => T): T {
  const stats: TrimStats = { count: 0 }; const result = run(stats);
  reportGatewayFeatureTrim(site, stats); return result;
}
