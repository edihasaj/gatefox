import type { GatewayConfig } from "./config.js";
/** Conservative common capabilities; no selected provider or caller instruction is invented. */
export function managedCatalog(config: GatewayConfig): Array<Record<string, unknown>> {
  return Object.entries(config.managedRouting?.routes ?? {}).map(([alias, policy]) => {
    const metadata = policy.candidates.map(candidate => config.providers.find(p => Object.hasOwn(p.models, candidate))?.modelMetadata?.[candidate]);
    const efforts = (metadata[0]?.reasoningEfforts ?? []).filter(effort => metadata.every(row => row?.reasoningEfforts?.includes(effort)));
    return {
      slug: alias, display_name: `Managed · ${policy.purpose}`, description: "Opt-in capacity-aware worker route; persistent provider affinity and bounded caller context",
      priority: 0, visibility: "hide", supported_in_api: true, availability_nux: null, upgrade: null,
      supported_reasoning_levels: efforts.map(effort => ({ effort, description: `${effort} reasoning effort` })),
      default_reasoning_level: efforts.includes("medium") ? "medium" : efforts[0] ?? null,
      default_reasoning_summary: efforts.length ? "auto" : "none", supports_reasoning_summary_parameter: efforts.length > 0,
      shell_type: "unified_exec", apply_patch_tool_type: "freeform", tool_mode: "direct", model_messages: { instructions_template: "" },
      include_skills_usage_instructions: true, include_plugin_usage_instructions: true, include_apps_usage_instructions: true,
      support_verbosity: false, default_verbosity: null, truncation_policy: { mode: "bytes", limit: Math.min(12000, policy.maxContextBytes) },
      experimental_supported_tools: [], input_modalities: ["text"], context_window: policy.contextWindow,
      max_context_window: policy.contextWindow, effective_context_window_percent: 90,
      supports_search_tool: false, supports_experimental_context: false, node_repl_disabled: true, node_repl_auto_review_required: true,
      // This is the managed interface's client-side tool protocol, not an
      // upstream model claim. Every candidate uses the same Gateway translator.
      multi_agent_version: "v2",
    };
  });
}
