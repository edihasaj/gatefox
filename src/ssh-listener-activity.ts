import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { writePrivateJson } from "./config.js";
import { isId, object, type Message } from "./app-server-connection.js";
import { NativeTurnTracker } from "./native-turns.js";

/**
 * An SSH listener tells the rest of the gateway whether it is working, so activating the native relay can retire an idle
 * listener and leave a busy one alone. Another process cannot see inside the listener, so the listener keeps one small
 * private record beside its socket: `<ssh home>/listener-activity-<pid>.json`, holding the pid, its start time, whether any
 * turn is running in any of its sessions, and how many sessions it serves. Nothing of a chat, a path or an argument is recorded.
 * The record is also the proof that this listener release handles SIGUSR2 (a request to retire when idle); a release without
 * one would die of that signal, so it is never sent to a listener without a record.
 * A pending approval (or any other request the engine made of the client) counts as work until the engine reports it resolved.
 */
export const listenerActivityPath = (home: string, pid: number): string => resolve(home, `listener-activity-${pid}.json`);

/**
 * What a listener's record says. `startedAt` (ms) identifies the process, so a record never vouches for a reused pid;
 * `declinedAt` (ms) is when the listener last refused a request to retire because it was not idle.
 */
export interface ListenerRecord { pid: number; startedAt: number; busy: boolean; declinedAt?: number }

/** Reads the record of the listener with this pid. Anything but a well-formed record for that pid is undefined, which is never idle. */
export async function readListenerActivity(home: string, pid: number): Promise<ListenerRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(listenerActivityPath(home, pid), "utf8")) as Partial<ListenerRecord>;
    if (value.pid !== pid || typeof value.busy !== "boolean" || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)) return undefined;
    return { pid, startedAt: value.startedAt, busy: value.busy, ...(typeof value.declinedAt === "number" ? { declinedAt: value.declinedAt } : {}) };
  } catch { return undefined; }
}

/** What one session is doing: the turns in flight and the server requests the client has not answered yet. */
interface SessionWork { turns: NativeTurnTracker; requests: Set<string> }
const maxRequests = 256;

export class ListenerActivity {
  private readonly sessions = new Set<SessionWork>();
  private published?: boolean;
  private declinedAt?: number;
  private writes: Promise<void> = Promise.resolve();
  /** This process's start, as the process list will show it to within a second. */
  readonly startedAt = Math.round(Date.now() - process.uptime() * 1000);
  constructor(private readonly home: string, private readonly pid = process.pid) {}

  private busy(): boolean { for (const work of this.sessions) if (work.turns.active.size || work.requests.size) return true; return false; }

  private write(busy: boolean): void {
    this.writes = this.writes.then(() => writePrivateJson(listenerActivityPath(this.home, this.pid),
      { pid: this.pid, startedAt: this.startedAt, busy, ...(this.declinedAt === undefined ? {} : { declinedAt: this.declinedAt }), sessions: this.sessions.size, at: new Date().toISOString() })).catch(() => {});
  }

  /** Writes the record when what it says changed (or on the first call); the listener never waits on it. */
  publish(): void {
    const busy = this.busy();
    if (this.published === busy) return;
    this.published = busy; this.write(busy);
  }

  /** The listener was asked to retire and was not idle: the record says so, and says it is busy. */
  decline(): void { this.declinedAt = Date.now(); this.published = true; this.write(true); }

  /**
   * One session of this listener. `emit` is the session's way to the client; every notification it carries is also what the
   * session's turns are followed from, and `close` ends the session's share of the listener's work.
   */
  open(emit: (message: Message) => Promise<void>): { emit: (message: Message) => Promise<void>; close: () => void } {
    const work: SessionWork = { turns: new NativeTurnTracker(), requests: new Set() }; this.sessions.add(work); this.publish();
    return {
      emit: message => {
        if (isId(message.id)) { if (typeof message.method === "string" && work.requests.size < maxRequests) work.requests.add(String(message.id)); }
        else {
          if (message.method === "serverRequest/resolved") work.requests.delete(String(object(message.params).requestId));
          work.turns.observe(message);
        }
        this.publish();
        return emit(message);
      },
      close: () => { work.turns.close(); this.sessions.delete(work); this.publish(); },
    };
  }

  /** Removes the record; the listener is going away, and no record reads as `unknown`, which is never idle. */
  async stop(): Promise<void> { await this.writes; await unlink(listenerActivityPath(this.home, this.pid)).catch(() => {}); }
}
