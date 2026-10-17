/**
 * The ChatGPT app engines (the signed Codex CLI inside ChatGPT.app) this release has verified, newest first. The shared host
 * shares only these as the native engine, and the native relay (`native-relay/src/cli_version.rs`) runs its remote-control
 * transport only beside them; a test holds the two lists equal. The relay links the newest one's SDK. An older entry stays
 * so a Mac whose app has not updated yet keeps working.
 *
 * Gateway chats are a separate pin: they run this release's gateway SDK (`gatewayEngineVersions`), whatever the app ships.
 */
export const verifiedAppEngines: readonly string[] = ["0.163.0-alpha.10.2", "0.162.0-alpha.17.2"];
