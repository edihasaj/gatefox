import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { writePrivateJson, type GatewayConfig } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { ProviderError } from "./providers/provider.js";
import { telemetry } from "./telemetry.js";

export interface LoginKeychainStatus {
  state: "unlocked" | "locked" | "cancelled" | "failed" | "unknown";
  graphic: boolean; session: number; boot: string;
}
const execute = promisify(execFile);
export const lockedKeychainMessage = "The macOS login Keychain is locked on the inference Mac. Unlock it in Keychain Access on that Mac, then retry before signing in to Claude again.";

/** Only the helper beside our own app-owned Node; no PATH search or unsigned fallback. */
export function loginKeychainHelper(executable = process.execPath, platform = process.platform): string | undefined {
  const suffix = "/Contents/Resources/backend/runtime/bin/node";
  if (platform !== "darwin" || !executable.endsWith(suffix)) return;
  return resolve(dirname(executable), "../../../../MacOS/GatewayService");
}

export async function readLoginKeychain(unlock = false): Promise<LoginKeychainStatus | undefined> {
  const helper = loginKeychainHelper();
  if (!helper) return;
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (unlock) { process.once("SIGTERM", stop); process.once("SIGINT", stop); }
  try {
    const { stdout } = await execute(helper, [unlock ? "--unlock-login-keychain" : "--login-keychain-status"],
      { timeout: unlock ? 120_000 : 3000, maxBuffer: 4096, signal: controller.signal });
    const value = JSON.parse(stdout) as LoginKeychainStatus;
    if (!["unlocked", "locked", "cancelled", "failed", "unknown"].includes(value.state) ||
      typeof value.graphic !== "boolean" || !Number.isSafeInteger(value.session) || value.session < 0 ||
      typeof value.boot !== "string" || !/^(?:[a-f0-9-]{36})?$/i.test(value.boot)) return;
    return value;
  } catch { /* Older apps, non-macOS hosts and unavailable sessions remain unknown. */ }
  finally { if (unlock) { process.off("SIGTERM", stop); process.off("SIGINT", stop); } }
}

/** One native prompt per GUI security session, even if launchd restarts the daemon. */
export async function offerLoginKeychainUnlock(config: Pick<GatewayConfig, "providers" | "stateDirectory" | "clientOnly">,
  read = readLoginKeychain): Promise<void> {
  if (config.clientOnly || !config.providers.some(provider => provider.type === "claude-subscription")) return;
  const status = await read();
  telemetry("login_keychain", { outcome: status?.state ?? "unavailable", graphic: status?.graphic });
  if (status?.state !== "locked" || !status.graphic || !status.boot || !status.session) return;
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const receipt = join(config.stateDirectory, "login-keychain-prompt.json");
  const claimed = await withPrivateFileLock(receipt, async () => {
    let previous: Partial<LoginKeychainStatus> = {};
    try {
      const value: unknown = JSON.parse(await readFile(receipt, "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) previous = value;
    } catch { /* First prompt. */ }
    if (previous.boot === status.boot && previous.session === status.session) return false;
    // Claim before showing UI: cancellation, timeout and process death never cause a prompt loop.
    await writePrivateJson(receipt, { boot: status.boot, session: status.session });
    return true;
  });
  if (claimed) telemetry("login_keychain", { outcome: (await read(true))?.state ?? "unavailable", prompted: true });
}

/** A failed Claude request stays final; diagnosing local access never replays inference. */
export async function explainClaudeKeychainFailure(error: unknown, read = readLoginKeychain): Promise<unknown> {
  if (!(error instanceof ProviderError) || error.upstream?.code !== "authentication_failed" ||
    error.upstream.reason !== "login_unavailable") return error;
  if ((await read())?.state !== "locked") return error;
  return new ProviderError(error.code, lockedKeychainMessage, error.status, { ...error.upstream, reason: "keychain_locked" });
}
