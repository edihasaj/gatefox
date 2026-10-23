import { hostname } from "node:os";
import type { GatewayConfig, ProviderConfig } from "./config.js";
import { pickerHidden } from "./model-auto-latest/metadata.js";

/** Read-only catalog disclosure served by `GET /v1/gateway-info`: provider labels, types, and model IDs only. */
export interface GatewayInfoModel { id: string; label: string }
export interface GatewayInfoProvider { id: string; label: string; type: string; models: GatewayInfoModel[] }
export interface GatewayInfoPayload { version: 1; hostname: string; providers: GatewayInfoProvider[] }

export const gatewayInfoPath = "/v1/gateway-info";
/** One catalog read is capped at 1 MiB; a larger body is refused, never truncated. */
export const maximumGatewayInfoBytes = 1024 * 1024;
export const gatewayInfoTimeoutMs = 3000;
/** Protocol bounds, not a display preference: a catalog past them is refused whole, so a listing is never incomplete. */
export const maximumGatewayInfoProviders = 32;
export const maximumGatewayInfoModels = 256;

const providerId = /^[a-z][a-z0-9_-]{0,63}$/;
const kinds = new Set(["claude-subscription", "codex-subscription", "copilot-subscription", "grok-subscription", "responses-api", "anthropic-api", "chat-completions-api"]);
/** Human-readable text: letters, digits, marks, punctuation, symbols and plain spaces; trimmed, bounded, no control or separator characters. */
const text = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim() && /^[\p{L}\p{N}\p{M}\p{P}\p{S} ]+$/u.test(value);
/** An identifier: printable text with no whitespace of any kind. */
const identifier = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\p{C}\p{Z}]/u.test(value);

/** This gateway's public catalog. `undefined` means it does not fit the protocol bounds, so nothing is listed. */
export function gatewayInfoPayload(config: GatewayConfig, name = hostname()): GatewayInfoPayload | undefined {
  if (!text(name, 253) || config.providers.length > maximumGatewayInfoProviders) return undefined;
  const providers: GatewayInfoProvider[] = []; const aliases = new Set<string>(); const ids = new Set<string>();
  for (const provider of config.providers) {
    const entry = gatewayProviderInfo(provider);
    if (!entry || ids.has(entry.id)) return undefined;
    ids.add(entry.id);
    // Configured aliases are globally unique; a catalog that repeats one is refused rather than guessed at.
    for (const model of entry.models) { if (aliases.has(model.id)) return undefined; aliases.add(model.id); }
    providers.push(entry);
  }
  return { version: 1, hostname: name, providers };
}

function gatewayProviderInfo(provider: ProviderConfig): GatewayInfoProvider | undefined {
  if (!providerId.test(provider.id) || !kinds.has(provider.type)) return undefined;
  const models: GatewayInfoModel[] = []; const seen = new Set<string>();
  for (const [alias, upstream] of Object.entries(provider.models)) {
    if (!identifier(alias, 128) || seen.has(alias) || !identifier(upstream, 256)) return undefined;
    seen.add(alias);
    // A model the picker hides stays routable but is not disclosed; the bound counts only what is listed.
    if (pickerHidden(provider.modelMetadata?.[alias])) continue;
    const displayName = provider.modelMetadata?.[alias]?.displayName;
    models.push({ id: alias, label: text(displayName, 256) ? displayName : upstream });
  }
  if (models.length > maximumGatewayInfoModels) return undefined;
  return { id: provider.id, label: text(provider.label, 96) ? provider.label : provider.id, type: provider.type, models };
}

/** Strict read of a peer's disclosure. Any shape, bound, duplicate, or unlisted kind fails closed to `undefined`. */
export function parseGatewayInfo(value: unknown): GatewayInfoPayload | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !text(candidate.hostname, 253)) return undefined;
  if (!Array.isArray(candidate.providers) || candidate.providers.length > maximumGatewayInfoProviders) return undefined;
  const providers: GatewayInfoProvider[] = []; const used = new Set<string>(); const aliases = new Set<string>();
  for (const item of candidate.providers) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const provider = item as Record<string, unknown>;
    if (typeof provider.id !== "string" || !providerId.test(provider.id) || used.has(provider.id)) return undefined;
    if (typeof provider.type !== "string" || !kinds.has(provider.type) || !text(provider.label, 96)) return undefined;
    if (!Array.isArray(provider.models) || provider.models.length > maximumGatewayInfoModels) return undefined;
    const models: GatewayInfoModel[] = []; const seen = new Set<string>();
    for (const entry of provider.models) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
      const model = entry as Record<string, unknown>;
      if (!identifier(model.id, 128) || seen.has(model.id) || aliases.has(model.id) || !text(model.label, 256)) return undefined;
      seen.add(model.id); aliases.add(model.id);
      models.push({ id: model.id, label: model.label });
    }
    used.add(provider.id);
    providers.push({ id: provider.id, label: provider.label, type: provider.type, models });
  }
  return { version: 1, hostname: candidate.hostname, providers };
}
