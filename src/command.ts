import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Historical launcher names remain valid for receipts and migration checks. New command references prefer the
 * installer-owned `gatefox` sibling; old layouts without it keep their working launcher.
 */
export const launcherName = "harness-gateway";
export const legacyLauncherName = "gateway";
/** The canonical GateFox command; supported alongside the historical launchers since 1.8.0. */
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

/** Prefers the real installer-owned GateFox launcher and leaves older or foreign layouts usable. */
export function preferredLauncher(command: string, managed: (path: string) => boolean = isManagedLauncher): string {
  if (![legacyLauncherName, launcherName, gatefoxLauncherName].includes(basename(command))) return command;
  const gatefox = resolve(dirname(command), gatefoxLauncherName);
  if (managed(gatefox)) return gatefox;
  const preferred = resolve(dirname(command), launcherName);
  return basename(command) === legacyLauncherName && managed(preferred) ? preferred : command;
}

export function gatewayCommand(): { command: string; args: string[] } {
  return process.env.GATEWAY_INSTALLED === "1" && process.env.GATEWAY_COMMAND
    ? { command: preferredLauncher(resolve(process.env.GATEWAY_COMMAND)), args: [] }
    : { command: process.execPath, args: [fileURLToPath(new URL("./cli.js", import.meta.url))] };
}
