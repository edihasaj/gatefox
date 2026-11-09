import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * macOS names a background item after the executable in the first ProgramArguments entry, so every plist the gateway
 * writes names the `harness-gateway` launcher, not the older `gateway` command, which stays installed and working.
 */
export const launcherName = "harness-gateway";
export const legacyLauncherName = "gateway";
/** The GateFox command, a third launcher with the same contents since 1.8.0. */
export const gatefoxLauncherName = "gatefox";

/** The line the installer puts in both launchers; a file without it is not ours to name in a plist. */
export const launcherMarker = "# Managed by subscription-gateway installer";
/** Whether a path is a regular file (not a link) that carries the installer's marker line. */
export function isManagedLauncher(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); if (!fstatSync(fd).isFile()) return false;
    const buffer = Buffer.alloc(4096); const length = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, length).toString("utf8").split("\n").includes(launcherMarker);
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * The launcher a plist should name. The installer's launchers both export the harness-gateway path as GATEWAY_COMMAND;
 * a value that still names the older `gateway` (inherited environment) is moved to the sibling harness-gateway launcher
 * when that file is the installer's own (it carries the managed marker), and left alone where it is absent, foreign,
 * or not a regular file (a rollback to a release without it).
 */
export function preferredLauncher(command: string, managed: (path: string) => boolean = isManagedLauncher): string {
  if (basename(command) !== legacyLauncherName) return command;
  const preferred = resolve(dirname(command), launcherName);
  return managed(preferred) ? preferred : command;
}

export function gatewayCommand(): { command: string; args: string[] } {
  return process.env.GATEWAY_INSTALLED === "1" && process.env.GATEWAY_COMMAND
    ? { command: preferredLauncher(resolve(process.env.GATEWAY_COMMAND)), args: [] }
    : { command: process.execPath, args: [fileURLToPath(new URL("./cli.js", import.meta.url))] };
}
