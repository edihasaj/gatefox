import { gatewayEngineHome } from "./gateway-engine-home.js";
import { trimGatewayFeatureArgs, trimmedGatewayFeatures } from "./gateway-feature-schema.js";
import { normalizeCodexFeatureArgs } from "./codex-feature-compat.js";

/**
 * The forward contract: what an older execution host calls when it runs a generation on this release's gateway SDK (the
 * per-chat rollout, docs/services.md). The older host imports this module from the installed release and uses it only when
 * `forwardContract` equals its own, so this release prepares its own engines: its engine-home writer and its spawn-argument
 * trim, cut to its own feature schema. That lets a release change any preparation code without an older host refusing it.
 *
 * Bump `forwardContract` whenever the shape or meaning of `forwardPreparation` changes (a parameter, an option, a return value
 * or what the host must do with it). An older host with another number keeps the release skew refusal, and the pre-publish
 * forward check (scripts/check-forward-compat.mjs) then refuses to publish until the deployed release can forward it.
 */
export const forwardContract = 1;

export interface ForwardPreparation {
  engineHome: (state: string, settings: Record<string, unknown>, options: { nativeHome?: string; sharedWriterLocks?: boolean; preserveConfig?: boolean }) => Promise<string>;
  trimArgs: (input: string[], settings: Record<string, unknown>) => string[];
}

export const forwardPreparation: ForwardPreparation = {
  engineHome: (state, settings, options) => gatewayEngineHome(state, settings, options),
  trimArgs: (input, settings) => trimmedGatewayFeatures("spawn", stats => trimGatewayFeatureArgs(normalizeCodexFeatureArgs(input, settings), stats)),
};
