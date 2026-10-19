/**
 * Structured `[features]` entries of the pinned gateway SDK (codex 0.162.0-alpha.17.2) and the fields each
 * accepts. Source: openai/codex revision 740e5af, codex-rs/features/src/lib.rs (`FeaturesToml`),
 * codex-rs/features/src/feature_configs.rs and codex-rs/network-proxy/src/credential_broker/provider_config.rs.
 * Every other feature key must be a plain boolean there, and each structured table (and each nested table
 * below it) denies unknown fields. ChatGPT picks the features it sends from the NATIVE engine's version,
 * which can be newer than this SDK, so gateway-only paths trim settings to this schema.
 */
export interface TableSchema {
  /** Accepted field names; undefined means a map whose keys are free and whose values follow `values`. */
  fields?: ReadonlySet<string>;
  /** Strict sub-tables by field name. */
  nested: ReadonlyMap<string, TableSchema>;
  values?: TableSchema;
}
export interface FeatureSchema extends TableSchema {
  /** The SDK field is a plain table, not a boolean-or-table `FeatureToml`. */
  tableOnly?: boolean;
}

const table = (fields: string[], nested: Record<string, TableSchema> = {}): TableSchema =>
  ({ fields: new Set(fields), nested: new Map(Object.entries(nested)) });
const mapOf = (values: TableSchema): TableSchema => ({ nested: new Map(), values });

const guardianTranscript = table(["sources", "include_images", "max_message_entry_tokens", "max_tool_entry_tokens", "max_message_transcript_tokens",
  "max_tool_transcript_tokens", "max_recent_non_user_entries"]);
const guardianReviewScope = table(["computer_use_only", "sandboxed_exec_commands"]);
const messageBoardRemote = table(["url", "bearer_token", "bearer_token_env_var"]);
const credentialProvider = table(["env", "patterns", "url_prefixes", "url_prefix_from_env", "auth", "header", "prefix"]);

const features: Record<string, FeatureSchema> = {
  tool_registry: { ...table(["error_on_tool_collisions", "turn_metadata_includes_tool_info"]), tableOnly: true },
  code_mode: table(["enabled", "default_exec_yield_time_ms", "experimental_show_cell_overhead", "tool_input_schema_max_bytes", "excluded_tool_namespaces", "direct_only_tool_namespaces"]),
  code_mode_host: table(["enabled", "disable_in_process_fallback"]),
  non_prefixed_mcp_tool_names: table(["enabled", "server_names"]),
  guardianv2: table(["async_classifier_mode", "async_classifier_conversation_token_limit", "enabled", "free_guardian", "thread_context", "persist_scores", "classifier_instructions",
    "review_threshold", "max_tool_call_lag", "reasoning_effort", "max_action_tokens", "max_classifier_instruction_tokens", "reuse_parent_compaction", "max_parent_compaction_tokens",
    "review_scope", "transcript"], { transcript: guardianTranscript, review_scope: guardianReviewScope }),
  multi_agent_v2: table(["enabled", "max_concurrent_threads_per_session", "min_wait_timeout_ms", "max_wait_timeout_ms", "default_wait_timeout_ms", "usage_hint_enabled", "usage_hint_text",
    "root_agent_usage_hint_text", "subagent_usage_hint_text", "subagent_developer_instructions", "multi_agent_mode_hint_text", "tool_namespace", "hide_spawn_agent_metadata",
    "expose_spawn_agent_model_overrides", "wait_agent_enabled", "disable_direct_message", "message_board_in_memory", "message_board_remote", "non_code_mode_only"],
  { message_board_remote: messageBoardRemote }),
  token_budget: table(["enabled", "use_history_notes_extension", "reminder_threshold_tokens", "reminder_message_template", "guidance_message", "auto_compact_fallback_prompt", "auto_compact_fallback_buffer_tokens"]),
  context_management: table(["experimental_mode"]),
  rollout_budget: table(["enabled", "limit_tokens", "reminder_at_remaining_tokens", "sampling_token_weight", "prefill_token_weight"]),
  current_time_reminder: table(["enabled", "reminder_interval_seconds", "clock_source", "delivery_mode", "sleep_tool"]),
  sleep_tool: table(["enabled", "mode"]),
  // The SDK reads and discards this removed key, but still parses it as a boolean or an `enabled`/`path` table.
  apps_mcp_path_override: table(["enabled", "path"]),
  network_proxy: table(["enabled", "proxy_url", "enable_socks5", "socks_url", "enable_socks5_udp", "allow_upstream_proxy", "dangerously_allow_non_loopback_proxy",
    "dangerously_allow_all_unix_sockets", "mode", "domains", "unix_sockets", "allow_local_binding", "credential_broker", "credentials"],
  { credentials: mapOf(credentialProvider) }),
};

export const featureSchema = (name: string): FeatureSchema | undefined => Object.hasOwn(features, name) ? features[name] : undefined;
