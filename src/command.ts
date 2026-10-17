import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * macOS names a background item after the executable in the first ProgramArguments entry, so every plist the gateway
 * writes names the `harness-gateway` launcher, not the older `gateway` command, which stays installed and working.
 */
export const launcherName = "harness-gateway";
export const legacyLauncherName = "gateway";

/**
 * The launcher a plist should name. The installer's launchers both export the harness-gateway path as GATEWAY_COMMAND;
 * a value that still names the older `gateway` (inherited environment) is moved to the sibling harness-gateway launcher
 * when that file exists, and left alone where it does not (a rollback to a release without it).
 */
export function preferredLauncher(command: string, exists: (path: string) => boolean = existsSync): string {
  if (basename(command) !== legacyLauncherName) return command;
  const preferred = resolve(dirname(command), launcherName);
  return exists(preferred) ? preferred : command;
}

export function gatewayCommand(): { command: string; args: string[] } {
  return process.env.GATEWAY_INSTALLED === "1" && process.env.GATEWAY_COMMAND
    ? { command: preferredLauncher(resolve(process.env.GATEWAY_COMMAND)), args: [] }
    : { command: process.execPath, args: [fileURLToPath(new URL("./cli.js", import.meta.url))] };
}
