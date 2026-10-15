import { lstat, readFile, readdir, readlink, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { macService } from "./mac-service.js";
import { macTunnel } from "./mac-tunnel.js";
import { macDesktop, planDesktopUnregister } from "./mac-desktop.js";
import { macSsh } from "./mac-ssh.js";
import { macNative } from "./mac-native.js";

/**
 * The commands the uninstaller runs. Injectable so a test can walk the whole uninstall path, including the
 * kept-legacy warning, with fakes that record calls instead of touching launchctl, the Trash, or the network.
 */
export type UninstallDeps = {
  macService: typeof macService;
  macNative: typeof macNative;
  macDesktop: typeof macDesktop;
  planDesktopUnregister: typeof planDesktopUnregister;
  macSsh: typeof macSsh;
  macTunnel: typeof macTunnel;
};

const defaultDeps: UninstallDeps = { macService, macNative, macDesktop, planDesktopUnregister, macSsh, macTunnel };

/** Where a desktop step failed, which is also what the install still holds at that point. */
const failureStage = {
  preflight: "Desktop unregister preflight failed before anything was removed",
  unregister: "Desktop unregister failed after the service and native components were already removed",
} as const;
/**
 * What a desktop step failed on, in one line the operator can act on. A JSON parse error is named rather than
 * quoted, because its message carries a snippet of the file it read and an uninstall never echoes file contents.
 */
export function uninstallFailure(error: unknown, stage: keyof typeof failureStage): Error {
  const reason = error instanceof SyntaxError ? "Invalid JSON data"
    : error instanceof Error ? error.message : "The desktop registration could not be removed";
  return new Error(`${failureStage[stage]}: ${reason}. Resolve that cause, then rerun \`gateway uninstall\`.`, { cause: error });
}

export async function uninstallGateway(configPath: string, deps: UninstallDeps = defaultDeps): Promise<Record<string, unknown>> {
  const command = process.env.GATEWAY_COMMAND;
  if (process.env.GATEWAY_INSTALLED !== "1" || !command) throw new Error("Uninstall requires an installed gateway command");
  const root = resolve(dirname(command), "../share/subscription-gateway");
  if (await readFile(resolve(root, ".gateway-installation"), "utf8") !== "subscription-gateway\n" || !(await readFile(command, "utf8")).includes("# Managed by subscription-gateway installer")) throw new Error("Installation is not managed by this installer");
  // Plan the desktop unregister first, and write nothing: the plan reads the config, the receipt, the desktop
  // LaunchAgent and its managed marker, and the GUI session, so an unmanaged plist, an unreadable registration,
  // or an unreachable session fails here, while the service and native components are still there to clean up,
  // rather than halfway through the removal below. macOS owns that session; on any other host this install has no
  // desktop registration to plan, so the preflight is skipped and the service step below gives its own answer.
  // serviceRemovedFirst tells the plan that the step right after it removes the unified service plan along with
  // the service, so a plan file on disk is not a reason to refuse this removal.
  if (process.platform === "darwin") {
    await deps.planDesktopUnregister(configPath, undefined, { serviceRemovedFirst: true })
      .catch((error: unknown) => { throw uninstallFailure(error, "preflight"); });
  }
  await deps.macService("uninstall", configPath);
  await deps.macNative("uninstall", configPath);
  // Unregister reports legacyForceCliKept when it cleared our CODEX_CLI_PATH but a legacy FORCE_CLI=1 stayed
  // behind it for lack of a receipt; the uninstaller passes that warning through so the operator can clear it.
  // A failure here is mid-removal, so the message says what is already gone and what to do next.
  const desktop = await deps.macDesktop("unregister", configPath).catch((error: unknown) => { throw uninstallFailure(error, "unregister"); });
  await deps.macSsh("unregister", configPath);
  const directory = resolve(homedir(), "Library/LaunchAgents");
  for (const file of await readdir(directory)) {
    const match = /^com\.edihasaj\.subscription-gateway\.tunnel\.([a-z][a-z0-9-]{0,63})\.plist$/.exec(file);
    if (match) await deps.macTunnel("uninstall", { id: match[1] }, dirname(configPath));
  }
  const trash = resolve(homedir(), ".Trash"); await mkdir(trash, { recursive: true }); const suffix = Date.now();
  // The product-name alias goes too, but only when it is the installer's own link.
  const alias = resolve(dirname(command), "harness-gateway");
  if ((await lstat(alias).catch(() => undefined))?.isSymbolicLink() && await readlink(alias) === "gateway") await rename(alias, resolve(trash, `harness-gateway.${suffix}`));
  await rename(command, resolve(trash, `gateway.${suffix}`)); await rename(root, resolve(trash, `subscription-gateway.${suffix}`));
  return uninstallResult(desktop);
}

/**
 * The uninstall contract. Pure so a test can prove the legacy FORCE_CLI warning passes through
 * without running the installer's launchctl, trash, or filesystem work.
 */
export function uninstallResult(desktop: Record<string, unknown>): Record<string, unknown> {
  return { uninstalled: true, installationMovedToTrash: true, credentialsPreserved: true, nativeConfigUntouched: true,
    ...(desktop.legacyForceCliKept === true ? { legacyForceCliKept: true } : {}) };
}
