import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { readListenerActivity, type ListenerRecord } from "./ssh-listener-activity.js";
import { telemetry } from "./telemetry.js";

/**
 * Before the native relay connects, any stock app engine on this Mac that was started without the relay's registration may
 * already hold this machine's one remote-control slot (OpenAI answers a second connection with HTTP 409). The engines that
 * matter are the ones this gateway's adapters, SSH listeners and shared host run for the app.
 *
 * An SSH listener is never killed from outside. The install asks it to retire (SIGUSR2) and the listener decides, in its own
 * process and in one step, whether it is truly idle (no request in flight, no turn, no approval, 30 s without traffic); only
 * then does it stop itself, the way a TERM would, and the remote app reconnects through a fresh listener, which stands down
 * because the activation is registered as pending. A busy listener ignores the request. The signal is only ever sent to a
 * listener whose activity record proves it handles it, and whose recorded start time matches the process list, so a release
 * that would die of SIGUSR2 and a reused pid are both left alone. The shared host is restarted by the service itself, when idle.
 */
export interface SlotHolder { pid: number; owner: number; ownerStartedAt: number; kind: "ssh-listener" | "adapter" | "host" }

interface Row { pid: number; parent: number; startedAt: number; args: string }
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Rows of `ps -axo pid=,ppid=,lstart=,args=` run in the C locale (another locale prints `lstart` in its own words). A line that
 * is not empty and does not parse is an error, never a skipped row: a list that cannot be read must not look like an empty one.
 */
export function parseHolderSnapshot(snapshot: string): Row[] {
  return snapshot.split("\n").filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+[A-Za-z]{3} ([A-Za-z]{3}) +(\d+) (\d{2}):(\d{2}):(\d{2}) (\d{4})\s+(\S.*)$/.exec(line);
    const month = months.indexOf(match?.[3] ?? "");
    if (!match || month < 0) throw new Error("Unreadable process list");
    const startedAt = new Date(Number(match[8]), month, Number(match[4]), Number(match[5]), Number(match[6]), Number(match[7])).getTime();
    return { pid: Number(match[1]), parent: Number(match[2]), startedAt, args: match[9]! };
  });
}

const shim = /(?:^|\s)codex-shim(?:\s|$)/;
const host = /(?:^|\s)(?:daemon|executor-host)(?:\s|$)/;

/** Every way a command line can spell this gateway's config path: as given, with links resolved, and JSON-escaped. */
function configForms(configPath: string): string[] {
  const forms = new Set([resolve(configPath)]);
  try { forms.add(realpathSync(configPath)); } catch { /* A config that is not there has only its written form. */ }
  return [...forms].flatMap(form => [form, JSON.stringify(form).slice(1, -1)]);
}

/**
 * The stock engines under this gateway's adapters, SSH listeners and shared host that started before the pending record.
 * Gateway chat engines and `proxy` clients are not stock engines. `pid` is the engine; `owner` is the process that started it.
 * A listener or adapter decides its engines' remote control when it starts, so its own start time decides; the host decides
 * when it launches the engine, so the engine's start time does.
 */
export function slotHolders(snapshot: string, configPath: string, pendingAtMs: number): SlotHolder[] {
  const rows = parseHolderSnapshot(snapshot); const byPid = new Map(rows.map(row => [row.pid, row]));
  const forms = configForms(configPath); const names = (args: string) => forms.some(form => args.includes(form));
  return rows.flatMap<SlotHolder>(row => {
    if (!/(?:^|\s)app-server(?:\s|$)/.test(row.args) || /(?:^|\s)proxy(?:\s|$)/.test(row.args) || shim.test(row.args) || row.args.includes("model_catalog_json=")) return [];
    let parent = byPid.get(row.parent); const seen = new Set<number>();
    while (parent && !seen.has(parent.pid)) {
      seen.add(parent.pid);
      if (shim.test(parent.args) && names(parent.args)) {
        if (parent.startedAt > pendingAtMs) return [];
        return [{ pid: row.pid, owner: parent.pid, ownerStartedAt: parent.startedAt, kind: /(?:^|\s)--ssh(?:\s|$)/.test(parent.args) ? "ssh-listener" : "adapter" }];
      }
      if (host.test(parent.args) && names(parent.args)) {
        if (row.startedAt > pendingAtMs) return [];
        return [{ pid: row.pid, owner: parent.pid, ownerStartedAt: parent.startedAt, kind: "host" }];
      }
      parent = byPid.get(parent.parent);
    }
    return [];
  });
}

export interface HolderDeps {
  snapshot(): Promise<string>;
  activity(home: string, pid: number): Promise<ListenerRecord | undefined>;
  /** Asks one listener to retire when idle (SIGUSR2). It may throw the signal's errno. */
  signal(pid: number): void;
  alive(pid: number): boolean;
  /** How long the retired listeners, their engines and a restarting host have to go, and how often that is checked. */
  stopWaitMs: number;
  pollMs: number;
}
/** The environment `ps` runs in: the C locale, so `lstart` is always `Sat Oct 17 23:27:35 2026`. */
export const holderPsEnvironment = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: "C", LANG: "C", LC_TIME: "C" });
const realSnapshot = async (): Promise<string> =>
  (await promisify(execFile)("/bin/ps", ["-axo", "pid=,ppid=,lstart=,args="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: holderPsEnvironment() })).stdout;
export const realHolderDeps: HolderDeps = {
  snapshot: realSnapshot, activity: readListenerActivity,
  signal: pid => { process.kill(pid, "SIGUSR2"); },
  alive: pid => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } },
  stopWaitMs: 10_000, pollMs: 100,
};

const busyMessage = "An SSH session from another Mac is using this Mac; retry when it is idle. The native relay was not registered";
const unknownMessage = "A listener from an older release is running; quit ChatGPT on the other Mac, wait about 2 minutes, then retry. The native relay was not registered";
const hostMessage = "The shared execution host is busy and still runs an engine that may hold remote control; retry when no chat is loaded. The native relay was not registered";
const refuse = (reason: string, message: string): Error => { telemetry("native_activation_refused", { reason }); return new Error(message); };
/** A recorded start time is the process's own estimate; the process list has whole seconds. */
const startSlackMs = 3000;

/**
 * Asks every idle SSH listener that may hold the remote-control slot to retire, and refuses (retiring none) when any listener
 * is busy, runs a release that cannot be asked, or another adapter holds an engine. A listener that declines after the ask
 * refuses the activation too. Returns how many listeners retired.
 */
export async function clearSlotHolders(options: { configPath: string; sshHome: string; pendingAtMs: number }, deps: HolderDeps = realHolderDeps): Promise<number> {
  const scan = async (): Promise<SlotHolder[]> => {
    try { return slotHolders(await deps.snapshot(), options.configPath, options.pendingAtMs); }
    catch { throw refuse("process_list", "Cannot verify the engines running on this Mac; the native relay was not registered"); }
  };
  const holders = await scan();
  if (holders.some(holder => holder.kind === "adapter")) throw refuse("adapter_running", "A Codex session on this Mac is running its own engine; close it and retry. The native relay was not registered");
  const listeners = new Map<number, number>();
  for (const holder of holders) if (holder.kind === "ssh-listener") listeners.set(holder.owner, holder.ownerStartedAt);
  for (const [pid, startedAt] of listeners) {
    const record = await deps.activity(options.sshHome, pid);
    if (!record || Math.abs(record.startedAt - startedAt) > startSlackMs) throw refuse("listener_unknown", unknownMessage);
    if (record.busy) throw refuse("listener_busy", busyMessage);
  }
  const signalledAt = Date.now();
  const declined = (record: ListenerRecord | undefined) => record?.declinedAt !== undefined && record.declinedAt >= signalledAt;
  for (const pid of listeners.keys()) {
    try { deps.signal(pid); }
    catch (error) {
      // A listener that exited by itself since the list was read is gone, which is what was asked for.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw refuse("signal_failed", "A listener could not be asked to retire; the native relay was not registered");
    }
  }
  const engines = holders.filter(holder => holder.kind === "ssh-listener").map(holder => holder.pid);
  const goneListeners = () => ![...listeners.keys(), ...engines].some(pid => deps.alive(pid));
  let hostHolders = holders.some(holder => holder.kind === "host");
  const hostEvery = Math.max(1, Math.round(1000 / deps.pollMs));
  for (let waited = 0, polls = 0; !goneListeners() || hostHolders; waited += deps.pollMs, polls++) {
    if (waited >= deps.stopWaitMs) {
      if (hostHolders) throw refuse("host_busy", hostMessage);
      for (const pid of listeners.keys()) {
        if (!deps.alive(pid)) continue;
        const record = await deps.activity(options.sshHome, pid);
        throw refuse(declined(record) ? "listener_busy" : "listener_stuck", declined(record) ? busyMessage : "An SSH listener did not stop; the native relay was not registered");
      }
      throw refuse("listener_stuck", "An SSH listener did not stop; the native relay was not registered");
    }
    await delay(deps.pollMs);
    // A listener that declined says so in its record; waiting out the rest of the time would only delay the refusal.
    if (polls % hostEvery === 0) for (const pid of listeners.keys()) if (deps.alive(pid) && declined(await deps.activity(options.sshHome, pid))) throw refuse("listener_busy", busyMessage);
    // The service restarts an idle host on its own once the activation is pending; the host is checked about once a second.
    if (hostHolders && polls % hostEvery === 0) hostHolders = (await scan()).some(holder => holder.kind === "host");
  }
  if (listeners.size) telemetry("native_listener_retired", { count: listeners.size });
  return listeners.size;
}
