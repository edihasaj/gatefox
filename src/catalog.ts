import { accessToken } from "./auth/chatgpt.js";
import { discoverClaudeModels } from "./providers/claude-models.js";
import { discoverCopilotModels } from "./providers/copilot-models.js";
import { apiCredential, type GatewayConfig, type ProviderConfig, type ModelMetadata } from "./config.js";
import { publicServiceTierFields, readPublicServiceTierMetadata, readServiceTierMetadata } from "./model-service-tiers.js";

/** Honest startup metadata for Codex's native model picker and reasoning control. */
export function modelCatalog(config: GatewayConfig): { models: Array<Record<string, unknown>> } {
  const groups = new Map<string, number>();
  const models = config.providers.flatMap((provider, providerIndex) => Object.keys(provider.models).map((alias, modelIndex) => {
    groups.set(alias, providerIndex);
    const metadata = provider.modelMetadata?.[alias];
    const efforts = metadata?.reasoningEfforts || [];
    return {
      slug: alias, display_name: `${provider.label || provider.id} · ${metadata?.displayName || provider.models[alias]}`,
      description: `${provider.type}; account route ${provider.id}`, priority: metadata?.priority ?? modelIndex,
      visibility: "list", supported_in_api: true, availability_nux: null, upgrade: null,
      ...publicServiceTierFields(readServiceTierMetadata(metadata)),
      supported_reasoning_levels: efforts.map(effort => ({ effort, description: `${effort} reasoning effort` })),
      default_reasoning_level: efforts.includes("medium") ? "medium" : efforts[0] || null,
      default_reasoning_summary: efforts.length ? "auto" : "none", supports_reasoning_summary_parameter: efforts.length > 0,
      shell_type: "unified_exec", apply_patch_tool_type: "freeform", tool_mode: "direct",
      model_messages: { instructions_template: "You are a coding agent. Follow user instructions and repository guidance. Use the supplied tools for file access, commands and edits. Never claim a tool action succeeded without its result. Preserve working code, verify changes, and report outcomes clearly. The desktop app owns automatic chat naming. Use gateway_chat_title only when the user explicitly requests reading or changing this chat's title. Preserve deliberate user titles." },
      include_skills_usage_instructions: true, include_plugin_usage_instructions: true, include_apps_usage_instructions: true,
      support_verbosity: false, default_verbosity: null,
      truncation_policy: { mode: "tokens", limit: 12000 }, experimental_supported_tools: [], input_modalities: metadata?.inputModalities || ["text"],
      context_window: metadata?.contextWindow || 32768, effective_context_window_percent: 90,
      supports_search_tool: false, supports_experimental_context: false, node_repl_disabled: true,
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
      ...(Array.isArray(model.input_modalities) ? { inputModalities: ["text" as const, ...(model.input_modalities.includes("image") ? ["image" as const] : [])] } : {}),
    } };
  });
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
