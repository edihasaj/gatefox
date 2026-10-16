/**
 * Decides what the desktop adapter may do with a Codex configuration write.
 *
 * The adapter owns only its own default selections and display settings, which live in a
 * private file. Every other key is the caller's native configuration and reaches the native
 * engine unchanged, exactly as it would without the gateway. The one thing that must never
 * happen is a native file that remembers a gateway model or the gateway provider: those rows
 * exist only while the adapter is running, so a write that stores one is refused before
 * anything is written or forwarded.
 */

import { isDesktopPreferenceKey } from "./desktop-preferences.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};

/** Keys the adapter keeps in its private preference file; they never reach native configuration. */
export const gatewayPreferenceKeys = new Set(["model", "model_reasoning_effort", "model_reasoning_summary", "service_tier"]);

/** How deep a written value is searched for gateway identity; anything deeper is refused. */
const identitySearchDepth = 64;

export const gatewayProfileMessage = "Gateway defaults cannot be saved into a native Codex profile";
export const gatewayIdentityMessage = "Gateway models and the gateway provider cannot be saved into native Codex configuration";
export const gatewayTargetMessage = "Native configuration changes cannot target the gateway preference file";

/** What counts as gateway identity, supplied by the router so this module stays pure. */
export type GatewayIdentity = {
  /** The native provider id the gateway registers itself under. */
  provider: string;
  /** True for a model name only the gateway catalog offers. */
  isGatewayModel: (value: unknown) => boolean;
};

/** The edits a configuration write carries: one for a value write, the batch list otherwise. */
export const configEdits = (method: string, params: ObjectValue): ObjectValue[] =>
  method === "config/value/write" ? [params] : Array.isArray(params.edits) ? params.edits.map(object) : [];

/** An edit the adapter answers itself, from its private preference file. */
export const isGatewayPreferenceEdit = (edit: ObjectValue): boolean =>
  gatewayPreferenceKeys.has(String(edit.keyPath)) || isDesktopPreferenceKey(edit.keyPath);

/** Splits a request into what the adapter saves and what only the native engine may apply. */
export const partitionConfigEdits = (edits: ObjectValue[]): { privateEdits: ObjectValue[]; nativeEdits: ObjectValue[] } => ({
  privateEdits: edits.filter(isGatewayPreferenceEdit),
  nativeEdits: edits.filter(edit => !isGatewayPreferenceEdit(edit)),
});

const holdsGatewayProvider = (value: unknown, provider: string): boolean =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value as ObjectValue, provider);

type Finding = "clear" | "identity" | "too-deep";
// A profile or plugin block can carry its own model settings; search it the way the engine reads it back.
const scanValue = (value: unknown, identity: GatewayIdentity, depth: number): Finding => {
  if (value === null || typeof value !== "object") return "clear";
  if (depth > identitySearchDepth) return "too-deep";
  if (Array.isArray(value)) {
    for (const item of value) { const found = scanValue(item, identity, depth + 1); if (found !== "clear") return found; }
    return "clear";
  }
  const record = value as ObjectValue;
  if (identity.isGatewayModel(record.model) || record.model_provider === identity.provider || holdsGatewayProvider(record.model_providers, identity.provider)) return "identity";
  for (const item of Object.values(record)) { const found = scanValue(item, identity, depth + 1); if (found !== "clear") return found; }
  return "clear";
};

/** Why a single native edit must be refused, or undefined when the native engine may apply it. */
export const nativeEditViolation = (edit: ObjectValue, identity: GatewayIdentity): string | undefined => {
  const keyPath = typeof edit.keyPath === "string" ? edit.keyPath : "";
  if (keyPath.endsWith(".model") && typeof edit.value === "string" && identity.isGatewayModel(edit.value)) return gatewayProfileMessage;
  const providerPath = `model_providers.${identity.provider}`;
  if ((keyPath === "model_provider" || keyPath.endsWith(".model_provider")) && edit.value === identity.provider) return gatewayIdentityMessage;
  if (keyPath === providerPath || keyPath.startsWith(`${providerPath}.`)) return gatewayIdentityMessage;
  // A whole provider map already names the gateway's row, even with no provider field inside it.
  if (keyPath === "model_providers" && holdsGatewayProvider(edit.value, identity.provider)) return gatewayIdentityMessage;
  return scanValue(edit.value, identity, 0) === "clear" ? undefined : gatewayIdentityMessage;
};

/** The first refusal a batch of native edits earns, or undefined when all of them may be forwarded. */
export const nativeWritesViolation = (edits: ObjectValue[], identity: GatewayIdentity): string | undefined => {
  for (const edit of edits) { const refusal = nativeEditViolation(edit, identity); if (refusal) return refusal; }
  return undefined;
};
