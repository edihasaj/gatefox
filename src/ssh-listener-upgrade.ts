import { processStartMs } from "./boot-identity.js";
import { readListenerActivity, type ListenerRecord } from "./ssh-listener-activity.js";
import { sshListenerOwner, type SshListenerOwner } from "./ssh-socket.js";
import { releasePattern, releaseState } from "./self-update.js";
import { telemetry } from "./telemetry.js";

/**
 * An SSH listener keeps the release it started with, and a bootstrap on the installed release replaces it only when a new
 * listener starts. The remote app keeps a connection open for as long as it runs and reconnects through the live listener
 * (its proxy never starts a listener while one answers), so after an install the old listener never becomes idle and never
 * moves. The proxy fixes that from the outside: while it carries a connection, it checks every few minutes whether the
 * listener behind the socket runs another release than the installed one, and if so asks it to retire when idle (SIGUSR2).
 * The listener decides in its own process whether it is idle (no request in flight, no turn, no approval, 30 s without
 * traffic), exactly as for `gateway native install`; a busy one declines, and is asked again later. Once it retires, the app
 * reconnects and its bootstrap starts a listener on the installed release. The signal goes only to the process the socket's
 * ownership record names, whose activity record proves it handles SIGUSR2 and whose start time matches the process list,
 * so a release that would die of the signal and a reused pid are both left alone.
 */
export type StaleListenerOutcome = "current" | "unknown" | "busy" | "asked";

export interface StaleListenerDeps {
  installed(): string | undefined;
  owner(socketPath: string): Promise<SshListenerOwner | undefined>;
  activity(home: string, pid: number): Promise<ListenerRecord | undefined>;
  startMs(pid: number): Promise<number | undefined>;
  signal(pid: number): void;
}
export const realStaleListenerDeps: StaleListenerDeps = {
  installed: () => releaseState()?.installed,
  owner: sshListenerOwner,
  activity: readListenerActivity,
  startMs: pid => processStartMs(pid).catch(() => undefined),
  signal: pid => { process.kill(pid, "SIGUSR2"); },
};
/** A recorded start time is the process's own estimate; the process list has whole seconds. */
const startSlackMs = 3000;

/**
 * A listener that declined a request to retire records itself busy until its next message, so a decline can outlast the work
 * that caused it. Such a record is trusted for this long after the decline; after that the listener is asked again (it decides
 * itself, so asking a busy one is safe), which also bounds its declines to one per this interval.
 */
export const declineTrustMs = 10 * 60_000;

/**
 * One check of `owner`, the listener this connection reached; asks it to retire only when it runs another release than the
 * installed one and does not say it is busy. Its pid must be the same process the ownership record was stamped with (start time
 * from the record and from its own activity record, both against the process list), so a reused pid is never signalled.
 */
export async function askStaleListenerToRetire(home: string, owner: SshListenerOwner | undefined, deps: StaleListenerDeps = realStaleListenerDeps,
  now = Date.now()): Promise<{ outcome: StaleListenerOutcome; from?: string; to?: string }> {
  const installed = deps.installed();
  if (!installed || !releasePattern.test(installed)) return { outcome: "unknown" };
  if (!owner) return { outcome: "unknown" };
  if (owner.release === installed) return { outcome: "current" };
  if (owner.pid === undefined || owner.startedAtMs === undefined || owner.pid === process.pid) return { outcome: "unknown" };
  const record = await deps.activity(home, owner.pid).catch(() => undefined);
  if (!record) return { outcome: "unknown" };
  const started = await deps.startMs(owner.pid).catch(() => undefined);
  if (started === undefined || Math.abs(started - record.startedAt) > startSlackMs || Math.abs(started - owner.startedAtMs) > startSlackMs) return { outcome: "unknown" };
  if (record.busy && (record.declinedAt === undefined || now - record.declinedAt < declineTrustMs)) return { outcome: "busy" };
  try { deps.signal(owner.pid); } catch { return { outcome: "unknown" }; }
  return { outcome: "asked", from: owner.release ?? "unknown", to: installed };
}

export interface StaleListenerTiming { firstMs: number; everyMs: number }
export const staleListenerTiming: StaleListenerTiming = { firstMs: 60_000, everyMs: 120_000 };

/**
 * Checks the listener this proxy's connection reached after `firstMs` and then every `everyMs`, until the returned stop is
 * called. That listener is pinned when the proxy starts, before it connects: a bootstrap may later point the socket at a new
 * listener, while this connection stays on the one it reached. Only when no listener answered at the start is the socket's
 * current owner pinned at the first check. A bootstrap that swaps the socket in the moment between that read and the native
 * proxy's connect can leave the wrong listener pinned; that window exists only while a new listener is bootstrapping (which the
 * app does only when none answers), and its outcome is the behaviour before this check: the old listener stays until the app
 * next reconnects. The first request to retire is logged once as `ssh_listener_upgrade_requested`.
 * The timers never keep the proxy alive.
 */
export function watchStaleListener(home: string, socketPath: string, timing: StaleListenerTiming = staleListenerTiming,
  deps: StaleListenerDeps = realStaleListenerDeps): () => void {
  let stopped = false; let timer: NodeJS.Timeout | undefined; let logged = false;
  const pinned: Promise<SshListenerOwner | undefined> = deps.owner(socketPath).catch(() => undefined);
  let owner: SshListenerOwner | undefined;
  const check = async () => {
    if (stopped) return;
    owner ??= await pinned ?? await deps.owner(socketPath).catch(() => undefined);
    const result = await askStaleListenerToRetire(home, owner, deps).catch(() => ({ outcome: "unknown" as const }));
    if (result.outcome === "asked" && !logged) { logged = true; telemetry("ssh_listener_upgrade_requested", { from: result.from, to: result.to }); }
    // A listener that is current now can fall behind at the next install, so the check goes on for the whole connection.
    if (!stopped) schedule(timing.everyMs);
  };
  const schedule = (ms: number) => { timer = setTimeout(() => { void check(); }, ms); timer.unref(); };
  schedule(timing.firstMs);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
