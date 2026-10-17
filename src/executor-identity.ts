import type { Message } from "./app-server-connection.js";
import type { GatewayConfig } from "./config.js";
import type { GatewaySdkRuntime } from "./gateway-sdk-runtime.js";
import { legacyGatewayProvider } from "./chat-identity.js";

/** The provider id of the native engine, the phone and every stock Codex client. It is the native identity of a gateway chat. */
export const nativeIdentityProvider = "openai";
/**
 * Every gateway executor runs with this variable set to 1. The gateway SDK's patch keys its gateway behavior on it: `openai`
 * names the gateway's own loopback provider, and compaction stays on the selected model. A stock Codex never reads it.
 */
export const gatewayExecutorMarker = "HARNESS_GATEWAY_EXECUTOR";
/** The provider ids a gateway executor serves: the legacy one and, through the SDK's alias, the native identity. */
export const gatewayProviderIds: ReadonlySet<string> = new Set([legacyGatewayProvider, nativeIdentityProvider]);

/**
 * The provider id this adapter's new gateway chats are recorded with. The default is the legacy `subscription_gateway`: the
 * phone reaches gateway chats through the native relay, which lists and continues them on the gateway. `openai` is an opt-in
 * per Mac (`chatIdentity: "openai"`), for a Mac whose relay is verified, and needs a gateway SDK that serves that id: a stock
 * Codex (a checkout without the artifact) would send `openai` to OpenAI's own provider. See docs/harness-identity.md.
 */
export function newChatProvider(config: Pick<GatewayConfig, "chatIdentity">, runtime: GatewaySdkRuntime | undefined): string {
  return config.chatIdentity === "openai" && runtime?.executorIdentity === true ? nativeIdentityProvider : legacyGatewayProvider;
}

/**
 * The provider id a gateway chat resumes with: the one it was saved with, so no rollout or SQLite row is ever rewritten. An id
 * the executor cannot serve falls back to the legacy one, as before the native identity.
 */
export function savedChatProvider(saved: unknown): string {
  return typeof saved === "string" && gatewayProviderIds.has(saved) ? saved : legacyGatewayProvider;
}

/**
 * The `-c` settings of a gateway executor launch, besides the model and features. `provider` is the default for new chats.
 * The gateway's own provider is always registered, so a legacy chat still resumes, and the SDK aliases `openai` to it inside the
 * executor. `openai_base_url` points the built-in `openai` at the gateway too, so an executor that is not a gateway SDK sends a
 * native-identity chat to the loopback gateway, which refuses it, never to OpenAI. Analytics stay off: an executor has no
 * ChatGPT account, and its events would otherwise carry whatever credential the SDK found. The marker is set to `0` for the
 * commands, hooks and shells the executor starts, so nothing a chat runs (another Codex among them) counts as an executor.
 */
export function executorOverrides(provider: string, providerOverrides: Message): Message {
  return {
    model_provider: provider,
    "analytics.enabled": false,
    [`shell_environment_policy.set.${gatewayExecutorMarker}`]: "0",
    ...(typeof providerOverrides.base_url === "string" ? { openai_base_url: providerOverrides.base_url } : {}),
    ...Object.fromEntries(Object.entries(providerOverrides).map(([key, value]) => [`model_providers.${legacyGatewayProvider}.${key}`, value])),
  };
}

/** A native engine's environment: the caller's, without the executor marker, so no native engine ever serves `openai` as the gateway. */
export function nativeEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!Object.hasOwn(env, gatewayExecutorMarker)) return env;
  const copy = { ...env }; delete copy[gatewayExecutorMarker]; return copy;
}
