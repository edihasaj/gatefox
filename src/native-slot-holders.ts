import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { readListenerActivity, type ListenerState } from "./ssh-listener-activity.js";
import { telemetry } from "./telemetry.js";

/**
 * Before the native relay connects, any stock app engine on this Mac that was started without the relay's registration may
 * already hold this machine's one remote-control slot (OpenAI answers a second connection with HTTP 409). The engines that
 * matter are the ones this gateway's adapters and SSH listeners run for the app. An idle SSH listener is retired the way an
 * install retires one (a graceful SIGTERM; the remote app reconnects through a fresh listener, which already stands down
 * because the activation is registered as pending). A busy or unknown one, or any other adapter, is never touched.
 */
export interface SlotHolder { pid: number; owner: number; kind: "ssh-listener" | "adapter" }

interface Row { pid: number; parent: number; startedAt: number; args: string }
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Rows of `ps -axo pid=,ppid=,lstart=,args=`. `lstart` is local wall-clock time in whole seconds. */
export function parseHolderSnapshot(snapshot: string): Row[] {
  return snapshot.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+[A-Za-z]{3} ([A-Za-z]{3}) +(\d+) (\d{2}):(\d{2}):(\d{2}) (\d{4})\s+(\S.*)$/.exec(line);
    const month = months.indexOf(match?.[3] ?? "");
    if (!match || month < 0) return [];
    const startedAt = new Date(Number(match[8]), month, Number(match[4]), Number(match[5]), Number(match[6]), Number(match[7])).getTime();
    return [{ pid: Number(match[1]), parent: Number(match[2]), startedAt, args: match[9]! }];
  });
}

const shim = /(?:^|\s)codex-shim(?:\s|$)/;

/**
 * The stock engines under this gateway's adapters and SSH listeners (the config path names which gateway) that started
 * before the pending registration. Gateway chat engines and `proxy` clients are not stock engines. A holder is the engine
 * child; `owner` is the adapter or listener process that started it.
 */
export function slotHolders(snapshot: string, configPath: string, pendingAtMs: number): SlotHolder[] {
  const rows = parseHolderSnapshot(snapshot); const byPid = new Map(rows.map(row => [row.pid, row]));
  const config = resolve(configPath); const names = (args: string) => args.includes(config) || args.includes(JSON.stringify(config).slice(1, -1));
  return rows.flatMap<SlotHolder>(row => {
    if (!/(?:^|\s)app-server(?:\s|$)/.test(row.args) || /(?:^|\s)proxy(?:\s|$)/.test(row.args) || shim.test(row.args) || row.args.includes("model_catalog_json=")) return [];
    let parent = byPid.get(row.parent); const seen = new Set<number>();
    while (parent && !seen.has(parent.pid)) {
      seen.add(parent.pid);
      if (shim.test(parent.args) && names(parent.args)) {
        if (parent.startedAt > pendingAtMs) return [];
        return [{ pid: row.pid, owner: parent.pid, kind: /(?:^|\s)--ssh(?:\s|$)/.test(parent.args) ? "ssh-listener" : "adapter" }];
      }
      parent = byPid.get(parent.parent);
    }
    return [];
  });
}

export interface HolderDeps {
  snapshot(): Promise<string>;
  activity(home: string, pid: number): Promise<ListenerState>;
  terminate(pid: number): void;
  alive(pid: number): boolean;
  /** How long a retired listener and its engine have to exit, and how often that is checked. */
  stopWaitMs: number;
  pollMs: number;
}
const realSnapshot = async (): Promise<string> =>
  (await promisify(execFile)("/bin/ps", ["-axo", "pid=,ppid=,lstart=,args="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout;
export const realHolderDeps: HolderDeps = {
  snapshot: realSnapshot, activity: readListenerActivity,
  terminate: pid => { process.kill(pid, "SIGTERM"); },
  alive: pid => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } },
  stopWaitMs: 10_000, pollMs: 100,
};

const busyMessage = "An SSH session from another Mac is using this Mac; retry when it is idle. The native relay was not registered";
const refuse = (reason: string, message: string): Error => { telemetry("native_activation_refused", { reason }); return new Error(message); };

/**
 * Retires every idle SSH listener that may hold the remote-control slot, and refuses (changing nothing) when any listener
 * is busy or cannot say, or when another adapter holds an engine. Returns how many listeners were retired.
 */
export async function clearSlotHolders(options: { configPath: string; sshHome: string; pendingAtMs: number }, deps: HolderDeps = realHolderDeps): Promise<number> {
  let holders: SlotHolder[];
  try { holders = slotHolders(await deps.snapshot(), options.configPath, options.pendingAtMs); }
  catch { throw refuse("process_list", "Cannot verify the engines running on this Mac; the native relay was not registered"); }
  if (holders.some(holder => holder.kind === "adapter")) throw refuse("adapter_running", "A Codex session on this Mac is running its own engine; close it and retry. The native relay was not registered");
  const owners = [...new Set(holders.map(holder => holder.owner))];
  for (const owner of owners) {
    const state = await deps.activity(options.sshHome, owner);
    if (state !== "idle") throw refuse(state === "busy" ? "listener_busy" : "listener_unknown", busyMessage);
  }
  for (const owner of owners) {
    // Asked again right before the signal: a turn that started since the first answer keeps its listener.
    if (await deps.activity(options.sshHome, owner) !== "idle") throw refuse("listener_busy", busyMessage);
    deps.terminate(owner);
  }
  const waiting = [...owners, ...holders.map(holder => holder.pid)];
  for (let waited = 0; waiting.some(pid => deps.alive(pid)); waited += deps.pollMs) {
    if (waited >= deps.stopWaitMs) throw refuse("listener_stuck", "An SSH listener did not stop; the native relay was not registered");
    await delay(deps.pollMs);
  }
  if (owners.length) telemetry("native_listener_retired", { count: owners.length });
  return owners.length;
}
