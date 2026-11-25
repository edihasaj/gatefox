import type { ProviderConfig } from "./config.js";

// Type-only config import: config.ts imports this module, so a value import would form a cycle.
export const maximumPoolMembers = 8;

function local(provider: ProviderConfig): boolean {
  if (!provider.baseUrl) return false;
  if (provider.tailnet === true) return true;
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(provider.baseUrl).hostname); } catch { return false; }
}
const endpoint = (provider: ProviderConfig): string => { const url = new URL(provider.baseUrl!); return url.origin + url.pathname.replace(/\/+$/, ""); };

/**
 * Checks every `pool` against the already validated providers. A pool spreads one model over interchangeable machines the
 * operator owns, so it is limited to self-hosted chat providers: it can never move a conversation to a subscription or to
 * a paid API. Every member must serve every pooled model with at least the window, effort levels and modalities the pool
 * advertises, so a conversation means the same thing on whichever member it lands.
 */
export function validateProviderPools(providers: readonly ProviderConfig[]): void {
  const claimed = new Map<string, string>();
  for (const owner of providers) {
    if (owner.pool === undefined) continue;
    const label = `${owner.id}: pool`;
    if (!Array.isArray(owner.pool) || owner.pool.length < 2 || owner.pool.length > maximumPoolMembers
      || owner.pool.some(id => typeof id !== "string") || new Set(owner.pool).size !== owner.pool.length) throw new Error(`${label} must list 2 to ${maximumPoolMembers} different provider IDs`);
    if (owner.type !== "chat-completions-api" || owner.selfHosted !== true || !local(owner)) throw new Error(`${label} is only valid on a self-hosted chat-completions-api provider`);
    const endpoints = new Set<string>();
    for (const id of owner.pool) {
      const member = providers.find(provider => provider.id === id);
      if (!member || member === owner) throw new Error(`${label} member ${id} must be another configured provider`);
      if (member.pool !== undefined) throw new Error(`${label} member ${id} must not be a pool itself`);
      if (claimed.has(id)) throw new Error(`${label} member ${id} already belongs to pool ${claimed.get(id)}`);
      claimed.set(id, owner.id);
      if (member.type !== "chat-completions-api" || member.selfHosted !== true || !local(member)) throw new Error(`${label} member ${id} must be a self-hosted chat-completions-api provider`);
      if ((member.chatTemplateReasoningEffort === true) !== (owner.chatTemplateReasoningEffort === true)) throw new Error(`${label} member ${id} must send reasoning effort the same way`);
      // Two members behind one address would count the same machine's capacity twice.
      if (endpoints.has(endpoint(member))) throw new Error(`${label} members must have different base URLs`);
      endpoints.add(endpoint(member));
      for (const [alias, upstream] of Object.entries(owner.models)) {
        const own = Object.keys(member.models).find(name => member.models[name] === upstream);
        if (!own) throw new Error(`${label} member ${id} does not serve ${upstream}`);
        const offered = owner.modelMetadata?.[alias] ?? {}; const served = member.modelMetadata?.[own] ?? {};
        if (offered.reasoningEfforts?.some(effort => !served.reasoningEfforts?.includes(effort))) throw new Error(`${label} member ${id} lacks a reasoning effort the pool offers`);
        if (offered.inputModalities?.some(kind => !(served.inputModalities ?? ["text"]).includes(kind))) throw new Error(`${label} member ${id} lacks an input modality the pool offers`);
        const capped = (value: typeof offered): number | undefined => value.contextWindow === undefined ? undefined : Math.min(value.contextWindow, value.contextWindowCap ?? Infinity);
        if ((capped(offered) ?? 0) > (capped(served) ?? 0)) throw new Error(`${label} member ${id} has a smaller context window than the pool offers`);
      }
    }
  }
}
