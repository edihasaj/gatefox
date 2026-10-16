import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { object, type Message } from "./app-server-connection.js";
import type { ServiceComponent } from "./service-plan.js";

const exec = promisify(execFile);

/**
 * The relay is optional, so the service and the adapter ask these questions
 * instead of assuming a registered relay exists. Nothing here throws for a
 * missing or garbled file: an unreadable registration reads as unregistered,
 * which keeps a broken receipt from taking inference or tunnels down.
 */

export const nativeRegistrationPath = (stateDirectory: string): string => resolve(stateDirectory, "native-registration.json");

/** The saved registration, or undefined when this machine never registered a relay or its record is unreadable. */
export async function nativeRegistrationRecord(stateDirectory: string): Promise<Message | undefined> {
  let value: unknown;
  try { value = JSON.parse(await readFile(nativeRegistrationPath(stateDirectory), "utf8")); } catch { return; }
  return object(value);
}

/** Whether the registration says a relay is registered here; the only question readiness and the supervisor ask. */
export async function nativeRegistrationEnabled(stateDirectory: string): Promise<boolean> {
  return (await nativeRegistrationRecord(stateDirectory))?.registered === true;
}

/** The `--codex` executable of a native component, the file a relay restart is waiting for. */
function nativeCodex(component: ServiceComponent): string {
  const at = component.args.indexOf("--codex");
  return at >= 0 && typeof component.args[at + 1] === "string" ? resolve(component.args[at + 1]) : component.command;
}

/**
 * Identity of the binaries a paused relay would restart into: the app's `codex`
 * executable, the relay itself, and the registration record. A relay restart is
 * only worth trying once one of them changed.
 */
export async function relayFingerprint(component: ServiceComponent, stateDirectory: string): Promise<string> {
  const parts = await Promise.all([nativeCodex(component), component.command, nativeRegistrationPath(stateDirectory)].map(async path => {
    try { const info = await stat(path); return `${info.dev}:${info.ino}:${info.size}:${Math.round(info.mtimeMs)}`; } catch { return "absent"; }
  }));
  return parts.join(" ");
}

/** A `ps -axo comm=` line per running process; the check the native install already makes. */
export const realProcessList = async (): Promise<string> => (await exec("/bin/ps", ["-axo", "comm="], { timeout: 5000 })).stdout;

/** Whether a ChatGPT desktop app is running here, so a relay never competes with its stock remote control. */
export async function chatGptAppRunning(listProcesses: () => Promise<string> = realProcessList): Promise<boolean> {
  try { return (await listProcesses()).split("\n").some(line => line.trim() === "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"); } catch { return true; }
}
