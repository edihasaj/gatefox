import { resolve } from "node:path";
import { ExecutionHostClient, type NativeFallbackReason } from "./execution-host-client.js";
import { executionHostHome } from "./execution-host-storage.js";
import { claimPrivateNativeHome, type PrivateNativeLease } from "./native-execution-host-storage.js";
import { telemetry } from "./telemetry.js";

/**
 * What a desktop adapter needs before it spawns its own native engine. Every private engine gets the verdict a host's claim
 * gets (a live or unconfirmed native owner keeps it out). When the adapter shares native chats but the host stayed down, it
 * also takes the native-home lease, before the spawn, and holds it until the engine exits: a host that comes back meanwhile
 * then finds a live owner and does not become a second native writer. A fallback is recorded only once it is allowed.
 */
export async function privateNativeOwnership(configPath: string | undefined, nativeHome: string, codex: string, fallback?: NativeFallbackReason): Promise<PrivateNativeLease | undefined> {
  await ExecutionHostClient.assertNativeUnowned(configPath, nativeHome);
  let lease: PrivateNativeLease | undefined;
  if (fallback === "host_unavailable") {
    if (!configPath) throw new Error("A private native fallback requires this adapter's configuration path");
    lease = await claimPrivateNativeHome({ configPath: resolve(configPath), nativeHome, codex }, executionHostHome(configPath, nativeHome));
  }
  if (fallback) telemetry("native_sharing_fallback", { reason: fallback });
  return lease;
}
