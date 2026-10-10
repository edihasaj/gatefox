import type { ProviderConfig } from "../config.js";
import type { DiscoveredModel } from "../catalog.js";
import { openCopilot } from "./copilot-client.js";
import { record } from "./copilot-rpc.js";

/** Keep explicitly selectable models; never advertise automatic account routing. */
export function nativeCopilotModels(value: unknown): DiscoveredModel[] {
  if (!Array.isArray(value)) throw new Error("Copilot returned an invalid model catalog");
  const ids = new Set<string>();
  return value.flatMap(raw => {
    const model = record(raw); const policy = record(model.policy);
    if (model.id === "auto" || (policy.state && policy.state !== "enabled")) return [];
    if (typeof model.id !== "string" || !model.id || ids.has(model.id) || typeof model.name !== "string") throw new Error("Copilot returned an invalid or duplicate model");
    ids.add(model.id);
    const limits = record(record(model.capabilities).limits);
    const billing = record(record(model.billing).tokenPrices);
    // SDK sessions use the default context tier. Do not advertise long-context
    // capacity when the default tier has a smaller public limit.
    const context = Math.min(...[limits.max_context_window_tokens, limits.max_prompt_tokens, billing.contextMax].filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1024));
    const efforts = model.supportedReasoningEfforts ?? [];
    if (!Array.isArray(efforts) || efforts.some(effort => !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort))) throw new Error("Copilot returned unsupported reasoning metadata");
    // CLI 1.0.95 advertises "none" for Sol 6.1, but the actual Copilot
    // subscription endpoint rejects it. Preserve only its verified wire levels.
    const supported = model.id === "gpt-6.1-sol" ? efforts.filter(effort => effort !== "none") : efforts;
    return [{ model: model.id, metadata: { displayName: model.name, ...(Number.isFinite(context) ? { contextWindow: context } : {}), reasoningEfforts: supported as string[] } }];
  });
}

export async function discoverCopilotModels(config: ProviderConfig): Promise<DiscoveredModel[]> {
  const client = await openCopilot(config);
  try { return nativeCopilotModels((await client.rpc.request("models.list")).models); }
  finally { await client.close(); }
}
