import { accessToken } from "./auth/chatgpt.js";
import { discoverClaudeModels } from "./providers/claude-models.js";
import { discoverCopilotModels } from "./providers/copilot-models.js";
import { apiCredential, type GatewayConfig, type ProviderConfig, type ModelMetadata } from "./config.js";
import { publicServiceTierFields, readPublicServiceTierMetadata, readServiceTierMetadata } from "./model-service-tiers.js";
import { upstreamSlugField } from "./codex-native-rows.js";
import { webSearchBackend } from "./web-search.js";

/** Honest startup metadata for Codex's native model picker and reasoning control. */
export function modelCatalog(config: GatewayConfig): { models: Array<Record<string, unknown>> } {
  const groups = new Map<string, number>();
  const models = config.providers.flatMap((provider, providerIndex) => Object.keys(provider.models).map((alias, modelIndex) => {
    groups.set(alias, providerIndex);
    const metadata = provider.modelMetadata?.[alias];
    const efforts = metadata?.reasoningEfforts || [];
    // The provider's own default (Claude: the CLI's per-model level); otherwise medium.
    const preferred = metadata?.defaultReasoningEffort && efforts.includes(metadata.defaultReasoningEffort) ? metadata.defaultReasoningEffort : "medium";
    // Codex 2 rows default to native Codex's truncation and usable window share.
    const codex = provider.type === "codex-subscription"; const truncation = metadata?.truncationPolicy;
    const searchBackend = webSearchBackend(provider.type);
    return {
      slug: alias, display_name: `${provider.label || provider.id} · ${metadata?.displayName || provider.models[alias]}`,
      description: `${provider.type}; account route ${provider.id}`, priority: metadata?.priority ?? modelIndex,
      // The desktop adapter copies the native row for this slug; Codex ignores the extra key.
      ...(codex ? { [upstreamSlugField]: provider.models[alias] } : {}),
      visibility: "list", supported_in_api: true, availability_nux: null, upgrade: null,
      ...publicServiceTierFields(readServiceTierMetadata(metadata)),
      supported_reasoning_levels: efforts.map(effort => ({ effort, description: `${effort} reasoning effort` })),
      default_reasoning_level: efforts.includes(preferred) ? preferred : efforts[0] || null,
      default_reasoning_summary: efforts.length ? "auto" : "none", supports_reasoning_summary_parameter: efforts.length > 0,
      shell_type: "unified_exec", apply_patch_tool_type: "freeform", tool_mode: "direct",
      // The SDK requires a string template; empty adds no gateway instructions.
      model_messages: { instructions_template: "" },
      include_skills_usage_instructions: true, include_plugin_usage_instructions: true, include_apps_usage_instructions: true,
      support_verbosity: false, default_verbosity: null,
      truncation_policy: truncation ? { mode: truncation.mode, limit: truncation.limit } : { mode: "tokens", limit: codex ? 10000 : 12000 },
      experimental_supported_tools: [], input_modalities: metadata?.inputModalities || ["text"],
      context_window: metadata?.contextWindow || 32768, effective_context_window_percent: metadata?.effectiveContextWindowPercent ?? (codex ? 95 : 90),
      // Without its own maximum a row would inherit Codex's global cap (872K), which cuts Claude's 1M.
      max_context_window: metadata?.maxContextWindow ?? (metadata?.contextWindow || 32768),
      ...(metadata?.autoCompactTokenLimit !== undefined ? { auto_compact_token_limit: metadata.autoCompactTokenLimit } : {}),
      supports_search_tool: false, supports_experimental_context: false, node_repl_disabled: true,
      // Codex 2 and Claude may run their own provider's hosted web search; other routes have none.
      ...(searchBackend ? { gateway_web_search: true, ...(searchBackend === "anthropic" ? { web_search_tool_type: "text" } : {}) } : {}),
      ...(metadata?.multiAgentVersion ? { multi_agent_version: metadata.multiAgentVersion } : {}),
      ...(metadata?.multiAgentReasoningEffort ? { multi_agent_reasoning_effort: metadata.multiAgentReasoningEffort } : {}),
      ...(metadata?.useResponsesLite ? { use_responses_lite: true } : {}),
      ...(metadata?.supportsReasoningEffortUpdates ? { supports_reasoning_effort_updates: true } : {}),
    };
  }));
  return { models: models.sort((a, b) => groups.get(a.slug)! - groups.get(b.slug)! || a.priority - b.priority || a.slug.localeCompare(b.slug)).map((model, priority) => ({ ...model, priority })) };
}

export interface DiscoveredModel { model: string; metadata: ModelMetadata }
export async function discoverModels(provider: ProviderConfig): Promise<DiscoveredModel[]> {
  if (provider.type === "claude-subscription") return discoverClaudeModels(provider);
  if (provider.type === "copilot-subscription") return discoverCopilotModels(provider);
  if (provider.type !== "codex-subscription" && provider.type !== "responses-api" && provider.type !== "chat-completions-api") throw new Error("This provider does not expose a verified model-discovery endpoint; declare its models explicitly");
  const token = provider.type === "codex-subscription" ? await accessToken(provider.credentialFile!) : await apiCredential(provider);
  if (!token) throw new Error("Provider requires login or an API credential");
  const base = provider.type === "codex-subscription" ? "https://api.openai.com/v1" : provider.baseUrl!.replace(/\/$/, "");
  const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}`);
  const body = await response.json() as { models?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>> };
  const models = body.models || body.data;
  if (!Array.isArray(models)) throw new Error("Provider returned an invalid model catalog");
  return models.filter(model => !model.visibility || model.visibility === "list").map(model => {
    const id = model.slug || model.id;
    if (typeof id !== "string" || !id) throw new Error("Provider returned an invalid model ID");
    const levels = model.supported_reasoning_levels as Array<{ effort: string }> | undefined;
    return { model: id, metadata: {
      ...readPublicServiceTierMetadata(model),
      ...(typeof model.display_name === "string" ? { displayName: model.display_name } : {}),
      ...(typeof (model.context_window ?? model.max_model_len) === "number" ? { contextWindow: (model.context_window ?? model.max_model_len) as number } : {}),
      ...(typeof model.priority === "number" ? { priority: model.priority } : {}),
      ...(Array.isArray(levels) ? { reasoningEfforts: levels.map(level => level.effort) } : {}),
      // Ultra's delegation comes from these catalog fields; the client runs it.
      ...(typeof model.multi_agent_version === "string" && /^v[0-9]{1,3}$/.test(model.multi_agent_version) ? { multiAgentVersion: model.multi_agent_version } : {}),
      ...(typeof model.use_responses_lite === "boolean" ? { useResponsesLite: model.use_responses_lite } : {}),
      ...(typeof model.supports_reasoning_effort_updates === "boolean" ? { supportsReasoningEffortUpdates: model.supports_reasoning_effort_updates } : {}),
      ...(typeof model.multi_agent_reasoning_effort === "string" && ["low", "medium", "high", "xhigh", "max"].includes(model.multi_agent_reasoning_effort) ? { multiAgentReasoningEffort: model.multi_agent_reasoning_effort } : {}),
      ...(Array.isArray(model.input_modalities) ? { inputModalities: ["text" as const, ...(model.input_modalities.includes("image") ? ["image" as const] : [])] } : {}),
      ...parityMetadata(model),
    } };
  });
}

const integerIn = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
/** Codex window and truncation fields, within the configuration bounds. comp_hash is never copied: gateway compaction rejects hashed rows. */
function parityMetadata(model: Record<string, unknown>): ModelMetadata {
  const policy = model.truncation_policy && typeof model.truncation_policy === "object" ? model.truncation_policy as Record<string, unknown> : {};
  const window = model.context_window ?? model.max_model_len;
  return {
    ...((policy.mode === "tokens" || policy.mode === "bytes") && integerIn(policy.limit, 1000, 1000000) ? { truncationPolicy: { mode: policy.mode, limit: policy.limit } } : {}),
    ...(integerIn(model.effective_context_window_percent, 50, 100) ? { effectiveContextWindowPercent: model.effective_context_window_percent } : {}),
    ...(integerIn(model.auto_compact_token_limit, 1024) ? { autoCompactTokenLimit: model.auto_compact_token_limit } : {}),
    ...(integerIn(model.max_context_window, Math.max(1024, typeof window === "number" ? window : 0)) ? { maxContextWindow: model.max_context_window } : {}),
  };
}

/** Retain public aliases so existing chats survive catalog refreshes. */
export function loadDiscoveredModels(provider: ProviderConfig, discovered: DiscoveredModel[]): void {
  const existing = new Map<string, string[]>();
  for (const [alias, model] of Object.entries(provider.models)) existing.set(model, [...(existing.get(model) || []), alias]);
  const entries = discovered.flatMap(entry => (existing.get(entry.model) || [`${provider.id}/${entry.model}`]).map(alias => ({
    alias, model: entry.model, metadata: { ...provider.modelMetadata?.[alias], ...entry.metadata },
  })));
  provider.models = Object.fromEntries(entries.map(entry => [entry.alias, entry.model]));
  provider.modelMetadata = Object.fromEntries(entries.map(entry => [entry.alias, entry.metadata]));
}
