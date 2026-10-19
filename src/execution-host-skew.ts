import { object, type Message } from "./app-server-connection.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";
import { sameSocketIdentity, socketIdentity, type SocketIdentity } from "./execution-host-storage.js";
import { urgentUpgradeIntervalMs, type PendingGatewaySdk } from "./self-update.js";

/**
 * Release skew, host side: the cheap look at an engine that an urgent move needs, and the watcher that makes it.
 *
 * A quiet check (execution-host-activity.ts) reads every loaded chat in full, including its newest turn, which replays the
 * chat's saved history. An urgent host looks again and again, so its look is far cheaper: a chat's live status (`active` covers
 * a running turn and one waiting for an approval or for input) and, only when no chat is active, its background terminals. No
 * turn list, so no history replay, and the look ends at the first chat that is busy.
 */
export type EngineBusy = "idle" | "running" | "blocked";
/** Statuses that prove no turn runs; `systemError` is what the engine keeps after a failed turn (as in execution-host-activity.ts). */
const settled = new Set(["idle", "systemError", "notLoaded"]);
const maxChats = 256; const timeoutMs = 10_000;

/**
 * One engine through a transient admin connection (never a persistent one: the SDK would subscribe it to new chats and keep
 * them loaded). `running`: a chat has a turn running or waiting. `blocked`: no turn runs but a background terminal runs, a
 * chat or its terminals could not be read, or there are too many chats to read. `idle`: none of those. With `terminals`
 * false only the status pass runs, which is what a last look before closing the gate needs.
 */
export async function engineBusy(socketPath: string, expected: SocketIdentity | undefined, terminals = true): Promise<EngineBusy> {
  const socket = await socketIdentity(socketPath);
  if (!socket || !expected || !sameSocketIdentity(socket, expected)) throw new Error("Execution engine socket ownership changed; its listener was preserved");
  const admin = new SocketAppServerConnection(socketPath, async () => {}); let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([(async (): Promise<EngineBusy> => {
      await admin.ready;
      await admin.request("initialize", { clientInfo: { name: "codex_app_server_daemon", version: "1" }, capabilities: { experimentalApi: true } });
      admin.send({ method: "initialized", params: {} });
      const loaded = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= 128) throw new Error("Execution SDK loaded-chat pagination exceeded its bound");
        const result: Message = await admin.request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result.data) || !result.data.every(id => typeof id === "string" && id.length > 0 && id.length <= 1024)) throw new Error("Execution SDK returned invalid loaded-chat metadata");
        for (const id of result.data as string[]) loaded.add(id);
        if (loaded.size > maxChats) return "blocked";
        if (result.nextCursor == null) break;
        if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) throw new Error("Execution SDK returned invalid loaded-chat pagination");
        cursor = result.nextCursor; cursors.add(cursor);
      }
      let blocked = false;
      for (const threadId of loaded) {
        const status = await admin.request("thread/read", { threadId, includeTurns: false }).then(reply => object(object(reply.thread).status).type, () => undefined);
        if (status === "active") return "running";
        if (typeof status !== "string" || !settled.has(status)) blocked = true; // Unreadable: not quiet, but a running chat later in the list still wins.
      }
      if (blocked) return "blocked";
      if (!terminals) return "idle";
      for (const threadId of loaded) {
        const list = await admin.request("thread/backgroundTerminals/list", { threadId, limit: 1 }).catch(() => undefined);
        if (!list || !Array.isArray(list.data) || list.data.length) return "blocked";
      }
      return "idle";
    })(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Execution SDK activity inspection timed out")), timeoutMs).unref(); })]);
  } finally { clearTimeout(timer); admin.stop(); await admin.exited; }
}

/** What the watcher reads: the engines now loaded (gateway and native), skipping any that closed. */
export interface WatchedEngine { closed: boolean; record: { socketPath: string }; owner: { socket?: SocketIdentity } }
export interface SkewWatchDeps {
  /** The installed release that is newer than this process, with its SDK checksum (cached by its reader). */
  pending: () => Promise<PendingGatewaySdk | undefined>;
  engines: () => WatchedEngine[];
  /** Called once per gap with the urgent releases; without it the watcher only keeps the urgent set honest. */
  onIdle?: (release: string) => void;
  /** The host is stopping or its gate is closed: nothing is read. */
  halted: () => boolean;
  baseMs: () => number;
}

/**
 * The releases a refused newer adapter made urgent, and the look that tells the supervisor the moment no turn runs. Agents
 * that run turns back to back leave only short gaps that the supervisor's own 10 second look would miss. Each look (every
 * `baseMs`, one second in production) first drops the releases that are no longer the pending one (a rollback, or a newer
 * install), and stops itself when none is left; a later refusal starts it again. A look that finds a chat running keeps the
 * pace; one blocked by a background terminal, an unreadable chat or too many chats backs off, doubling up to the supervisor's
 * own tick, and returns to the base pace when a gap appears. It changes nothing and closes no gate: the supervisor's quiet
 * check decides.
 */
export function skewWatch(deps: SkewWatchDeps) {
  const urgent = new Set<string>(); let timer: NodeJS.Timeout | undefined; let active = false; let stopped = false; let idle = false; let delayMs = 0;
  const base = () => { delayMs = deps.baseMs(); return delayMs; };
  /** The delay before the next look, or undefined when nothing is urgent any more. */
  const look = async (): Promise<number | undefined> => {
    const pending = await deps.pending().catch(() => undefined);
    for (const release of [...urgent]) if (pending?.release !== release) urgent.delete(release);
    if (!urgent.size) { idle = false; return; }
    if (!deps.onIdle || deps.halted()) return base();
    let state: EngineBusy = "idle";
    for (const engine of deps.engines()) {
      if (engine.closed) continue;
      state = await engineBusy(engine.record.socketPath, engine.owner.socket);
      if (state !== "idle") break;
    }
    if (state === "idle") {
      if (!idle) for (const release of urgent) deps.onIdle(release);
      idle = true; return base();
    }
    idle = false;
    if (state === "running") return base();
    delayMs = Math.min(Math.max(delayMs, deps.baseMs()) * 2, Math.max(urgentUpgradeIntervalMs(), deps.baseMs()));
    return delayMs;
  };
  const schedule = (ms: number) => { timer = setTimeout(run, ms); timer.unref(); };
  const run = () => {
    timer = undefined; if (stopped) return;
    look().then(next => { if (next !== undefined && !stopped) schedule(next); else active = false; }, () => { idle = false; if (!stopped) schedule(base()); else active = false; });
  };
  return {
    /** A refused newer adapter made `release` urgent. */
    mark(release: string) { urgent.add(release); if (!active && !stopped) { active = true; schedule(base()); } },
    has: (release: string) => urgent.has(release),
    stop() { stopped = true; active = false; clearTimeout(timer); timer = undefined; },
  };
}
