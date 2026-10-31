import type { ProviderConfig } from "./config.js";

// Type-only config import: config.ts imports this module, so a value import would form a cycle.
export type ManagedCandidateKind = "local" | "subscription" | "paid-flash";
export interface ManagedRoutePolicy {
  purpose: "routine" | "strong";
  candidates: string[];
  maxContextBytes: number;
  contextWindow: number;
  minRemainingPercent: number;
  allowPaid: boolean;
  candidateReasoningEfforts?: Record<string, string>;
  autoCompactTokenLimit?: number;
  preferPaidFlash?: boolean;
}
export interface ManagedRoutingSettings { routes: Record<string, ManagedRoutePolicy> }

const aliasPattern = /^managed\/[a-z][a-z0-9-]{0,31}$/;
const candidatePattern = /^[A-Za-z0-9_:/.-]{1,160}$/;
const flashPattern = /^deepseek\/deepseek-v4(?:\.\d+)?-flash((?:[:.-][a-z0-9-]+)?)$/i;
const forbiddenSuffix = /(?:^|[:.-])(?:pro|glm)(?=$|[:.-])/i;
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const rank: Record<ManagedCandidateKind, number> = { local: 0, subscription: 1, "paid-flash": 2 };
const routeKeys = ["purpose", "candidates", "maxContextBytes", "contextWindow", "minRemainingPercent", "allowPaid", "candidateReasoningEfforts", "autoCompactTokenLimit", "preferPaidFlash"];

function url(value: string | undefined): URL | undefined {
  try { return value ? new URL(value) : undefined; } catch { return undefined; }
}

/**
 * Classifies a candidate by what it can prove about cost and location. Anything else is not a managed candidate:
 * local is a chat-completions endpoint on loopback or the tailnet, subscription is Claude or Codex, and the only
 * paid candidate is DeepSeek V4 Flash on OpenRouter over HTTPS (never a Pro, GLM or other model).
 */
export function managedCandidateKind(provider: Pick<ProviderConfig, "type" | "baseUrl" | "tailnet">, upstream: string): ManagedCandidateKind | undefined {
  if (provider.type === "claude-subscription" || provider.type === "codex-subscription") return "subscription";
  if (provider.type !== "chat-completions-api" && provider.type !== "responses-api") return undefined;
  const base = url(provider.baseUrl);
  if (!base || base.username || base.password) return undefined;
  if (base.protocol === "https:" && base.hostname === "openrouter.ai" && base.port === "") {
    const match = typeof upstream === "string" ? flashPattern.exec(upstream) : null;
    if (!match) return undefined;
    const suffix = match[1]!;
    return forbiddenSuffix.test(suffix) ? undefined : "paid-flash";
  }
  if (provider.type !== "chat-completions-api") return undefined;
  if (loopbackHosts.has(base.hostname) && (base.protocol === "http:" || base.protocol === "https:")) return "local";
  return provider.tailnet === true && base.protocol === "http:" ? "local" : undefined;
}

function plain(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function strict(row: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(row)) if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}`);
}
function integerField(row: Record<string, unknown>, key: string, fallback: number, min: number, max: number, label: string): number {
  const value = row[key] === undefined ? fallback : row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}: ${key} must be an integer from ${min} through ${max}`);
  return value;
}

/** Strictly validates the optional `managedRouting` configuration against the already validated providers. */
export function validateManagedRouting(value: unknown, providers: ProviderConfig[]): ManagedRoutingSettings {
  const settings = plain(value, "managedRouting");
  strict(settings, ["routes"], "managedRouting");
  const routes = plain(settings.routes, "managedRouting.routes");
  const names = Object.keys(routes);
  if (names.length < 1 || names.length > 8) throw new Error("managedRouting.routes needs 1 to 8 managed aliases");
  const result: Record<string, ManagedRoutePolicy> = {};
  for (const name of names) {
    const label = `managed route ${name}`;
    if (!aliasPattern.test(name)) throw new Error("Managed aliases must look like managed/name: lowercase letters, digits and hyphens, 1 to 32 characters after the slash");
    if (providers.some(provider => Object.hasOwn(provider.models, name))) throw new Error(`${label}: alias collides with a provider model alias`);
    const row = plain(routes[name], label);
    strict(row, routeKeys, label);
    if (row.purpose !== "routine" && row.purpose !== "strong") throw new Error(`${label}: purpose must be routine or strong`);
    const list = row.candidates;
    if (!Array.isArray(list) || list.length < 1 || list.length > 12) throw new Error(`${label}: candidates needs 1 to 12 aliases`);
    const candidates = list.map(alias => {
      if (typeof alias !== "string" || !candidatePattern.test(alias)) throw new Error(`${label}: candidates must be model alias strings`);
      return alias;
    });
    if (new Set(candidates).size !== candidates.length) throw new Error(`${label}: candidates must be unique`);
    const maxContextBytes = integerField(row, "maxContextBytes", 262144, 4096, 4194304, label);
    const contextWindow = integerField(row, "contextWindow", 32768, 4096, 262144, label);
    const autoCompactTokenLimit = row.autoCompactTokenLimit === undefined ? undefined
      : integerField(row, "autoCompactTokenLimit", 0, 1024, Math.floor(contextWindow * 0.9), label);
    const minRemainingPercent = integerField(row, "minRemainingPercent", 2, 1, 50, label);
    if (row.allowPaid !== undefined && typeof row.allowPaid !== "boolean") throw new Error(`${label}: allowPaid must be boolean`);
    const allowPaid = row.allowPaid === true;
    if (row.preferPaidFlash !== undefined && typeof row.preferPaidFlash !== "boolean") throw new Error(`${label}: preferPaidFlash must be boolean`);
    const preferPaidFlash = row.preferPaidFlash === true;
    if (preferPaidFlash && (row.purpose !== "routine" || !allowPaid)) throw new Error(`${label}: preferPaidFlash requires a routine route with allowPaid`);
    const candidateRank = preferPaidFlash ? { local: 0, "paid-flash": 1, subscription: 2 } : rank;
    const candidateReasoningEfforts: Record<string, string> = Object.create(null);
    if (row.candidateReasoningEfforts !== undefined) {
      const efforts = plain(row.candidateReasoningEfforts, `${label}.candidateReasoningEfforts`);
      for (const [alias, effort] of Object.entries(efforts)) {
        const owner = providers.find(provider => Object.hasOwn(provider.models, alias));
        if (!candidates.includes(alias) || typeof effort !== "string" || !owner?.modelMetadata?.[alias]?.reasoningEfforts?.includes(effort))
          throw new Error(`${label}: candidate reasoning effort must name a supported effort on a configured candidate`);
        candidateReasoningEfforts[alias] = effort;
      }
    }
    let previous = -1, subscriptions = 0, paid = 0;
    for (const alias of candidates) {
      const owners = providers.filter(provider => Object.hasOwn(provider.models, alias));
      if (owners.length !== 1) throw new Error(`${label}: candidate ${alias} must name exactly one existing model alias`);
      const provider = owners[0]!, upstream = provider.models[alias]!;
      const kind = managedCandidateKind(provider, upstream);
      if (!kind) throw new Error(`${label}: candidate ${alias} is not a supported local, subscription or paid-flash route`);
      if (candidateRank[kind] < previous) throw new Error(`${label}: candidates must be ordered ${preferPaidFlash ? "local, then paid Flash, then subscriptions" : "local, then subscriptions, then paid"}`);
      previous = candidateRank[kind];
      if (kind === "local" && row.purpose === "strong") throw new Error(`${label}: strong routes cannot use local candidates`);
      if (kind === "paid-flash" && !allowPaid) throw new Error(`${label}: paid candidate ${alias} requires allowPaid`);
      if (kind === "paid-flash") paid += 1;
      if (kind === "subscription") subscriptions += 1;
      const metadata = Object.hasOwn(provider.modelMetadata ?? {}, alias) ? provider.modelMetadata![alias] : undefined;
      let window = metadata?.contextWindow;
      if (typeof window !== "number" || !Number.isFinite(window)) throw new Error(`${label}: candidate ${alias} has no known context window`);
      const cap = metadata?.contextWindowCap;
      if (typeof cap === "number" && window > cap) window = cap;
      if (window < contextWindow) throw new Error(`${label}: candidate ${alias} context window is below the route's ${contextWindow}`);
    }
    if (subscriptions < 1) throw new Error(`${label}: at least one subscription candidate is required`);
    if (preferPaidFlash && paid < 1) throw new Error(`${label}: preferPaidFlash requires a paid Flash candidate`);
    result[name] = { purpose: row.purpose, candidates, maxContextBytes, contextWindow, minRemainingPercent, allowPaid,
      ...(row.candidateReasoningEfforts === undefined ? {} : { candidateReasoningEfforts }),
      ...(autoCompactTokenLimit === undefined ? {} : { autoCompactTokenLimit }) };
    if (row.preferPaidFlash !== undefined) result[name]!.preferPaidFlash = preferPaidFlash;
  }
  return { routes: result };
}
