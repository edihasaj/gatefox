/**
 * ChatGPT app engines (the signed Codex CLI inside ChatGPT.app) this release has verified, newest first, per use.
 *
 * The native relay (`native-relay/src/cli_version.rs`) runs its remote-control transport beside `relayAcceptedAppEngines`;
 * a test holds the two lists equal. The relay never shares the host's engine: each phone stream reaches the gateway router,
 * whose adapter runs the app's engine privately when the host offers no native sharing.
 *
 * The shared host shares only `hostVerifiedAppEngines` as the native engine. An engine is added here only after the
 * shared-native end-to-end check (scripts/e2e-shared-native.mjs) passes against it, because a shared host depends on the
 * engine's unload and listener behaviour, not only on its protocol.
 *
 * Gateway chats are a separate pin: they run this release's gateway SDK (`gatewayEngineVersions`), whatever the app ships.
 */
export const relayAcceptedAppEngines: readonly string[] = ["0.163.0-alpha.10.2", "0.162.0-alpha.17.2"];
export const hostVerifiedAppEngines: readonly string[] = ["0.163.0-alpha.10.2", "0.162.0-alpha.17.2"];
