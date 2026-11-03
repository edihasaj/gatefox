import { randomBytes } from "node:crypto";
import { lstat, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ownStartMs, processAlive } from "../boot-identity.js";
import { withPrivateFileLock } from "../private-file-lock.js";
import { fixedReason } from "./grok-reasons.js";

/**
 * The persisted record of conversations whose live Grok session ended or may still run. A conversation in it is never
 * started again: its original request would pay for the whole conversation in a second process. Only sha256 key hashes,
 * a time, a write sequence and a fixed reason code are stored, never content. The file is private (0600), written
 * atomically, and shared by every process that uses the same Grok home.
 *
 * Every operation takes the cross-process lock (`withPrivateFileLock`), reads the file again from disk and writes the
 * whole file back before releasing it, so no process works from a stale copy and no write overwrites another's. A
 * reservation is an atomic conditional insert: it is made only when the key is absent, else the existing record is returned.
 *
 * Entries leave only when they are older than `expiryMs`, never by count, and a `live` entry never leaves by age. When
 * the store holds `maxEntries` it refuses new conversations. When it cannot be read, locked or written, a new
 * conversation is refused too (fixed codes below).
 */
export const grokEndedLimits = {
  /** Longer than any session lifetime (parkMinutes tops out at 4 hours) plus a wide margin. */
  expiryMs: 7 * 24 * 3600 * 1000,
  maxEntries: 20000,
  /**
   * A record this many expiries old is suspect (the clock jumped, or the gateway was idle for months): its age restarts
   * instead of the record expiring, so a large forward jump of the clock cannot drop records at once.
   */
  suspectFactor: 10,
  /** A leftover temporary file is removed only when it is older than this. */
  tempStaleMs: 60_000,
};
export const grokEndedFile = "gateway-ended-sessions.json";
/** A conversation whose session was started and has no recorded end: its gateway process ended without closing it. */
const live = "live";
const lost = "session_lost";

export class GrokEndedStoreError extends Error {
  constructor(readonly code: "ended_store_unavailable" | "ended_store_full") { super(code); }
}
/** `owner` (`<pid>:<process start ms>`) is set on `live` entries only; `seq` orders writes across processes. */
interface Entry { at: number; reason: string; seq: number; owner?: string }
interface State { seq: number; entries: Map<string, Entry>; changed: boolean }
type Alive = (owner: { pid: number; startedAtMs?: number }) => Promise<boolean>;
const unavailable = () => new GrokEndedStoreError("ended_store_unavailable");
const full = () => new GrokEndedStoreError("ended_store_full");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface GrokEndedStoreOptions {
  /** The wall clock in ms (tests inject one). */
  now?: () => number;
  /** This process's identity token (tests inject one); default `<pid>:<kernel start time>`. */
  owner?: string;
  /** Whether a process can still be running (tests inject one); default is the boot-identity rule. */
  alive?: Alive;
}

export class GrokEndedStore {
  private chain: Promise<unknown> = Promise.resolve();
  private owner?: string;
  /** Closings that could not be written yet (`null` releases): applied under the lock before the next operation. */
  private readonly pending = new Map<string, string | null>();
  private readonly clock: () => number;
  private readonly alive: Alive;
  constructor(readonly path: string, options: GrokEndedStoreOptions = {}) {
    this.owner = options.owner; this.clock = options.now ?? Date.now; this.alive = options.alive ?? processAlive;
  }

  static forHome(home: string, options?: GrokEndedStoreOptions): GrokEndedStore { return new GrokEndedStore(join(home, grokEndedFile), options); }

  /** The name of a temporary file this store writes: `<file>.<writer pid>.<12 hex>.tmp`. */
  static tempName(file: string, pid: number = process.pid): string { return `${file}.${pid}.${randomBytes(6).toString("hex")}.tmp`; }

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => {});
    return run;
  }

  private async identity(): Promise<string> {
    if (this.owner === undefined) this.owner = `${process.pid}:${await ownStartMs().catch(() => undefined) ?? 0}`;
    return this.owner;
  }

  private async read(): Promise<State> {
    let text: string;
    try {
      if (!(await lstat(this.path)).isFile()) throw unavailable();
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { seq: 0, entries: new Map(), changed: false };
      throw unavailable();
    }
    let decoded: unknown;
    try { decoded = JSON.parse(text); } catch { throw unavailable(); }
    const body = decoded as { version?: unknown; seq?: unknown; entries?: unknown } | null;
    const raw = body && typeof body === "object" && body.version === 1 && body.entries && typeof body.entries === "object" && !Array.isArray(body.entries) ? body.entries as Record<string, unknown> : undefined;
    if (!raw || (body!.seq !== undefined && !(typeof body!.seq === "number" && Number.isFinite(body!.seq) && body!.seq >= 0))) throw unavailable();
    const entries = new Map<string, Entry>(); let seq = typeof body!.seq === "number" ? body!.seq : 0;
    for (const [key, value] of Object.entries(raw)) {
      const entry = value as { at?: unknown; reason?: unknown; seq?: unknown; owner?: unknown } | null;
      if (!/^[0-9a-f]{64}$/.test(key) || !entry || typeof entry !== "object" || typeof entry.at !== "number" || !Number.isFinite(entry.at)
        || (entry.seq !== undefined && !(typeof entry.seq === "number" && Number.isFinite(entry.seq))) || (entry.owner !== undefined && typeof entry.owner !== "string")) throw unavailable();
      const reason = entry.reason === live ? live : fixedReason(entry.reason);
      const entrySeq = typeof entry.seq === "number" ? entry.seq : 0; seq = Math.max(seq, entrySeq);
      entries.set(key, { at: entry.at, reason: reason === "other" ? "closed" : reason, seq: entrySeq, ...(reason === live && entry.owner ? { owner: entry.owner } : {}) });
    }
    return { seq, entries, changed: false };
  }

  /** True when the process that wrote this `live` entry cannot be running it: not this process, and gone (or its pid reused). */
  private async orphaned(entry: Entry, me: string, verdicts: Map<string, boolean>): Promise<boolean> {
    if (entry.owner === me) return false;
    const known = verdicts.get(entry.owner ?? "");
    if (known !== undefined) return known;
    const parsed = /^(\d+):(\d+)$/.exec(entry.owner ?? "");
    let orphan = true;
    // A live entry of another running gateway process stays live; a pid that is this process's own with another start is a reused pid.
    if (parsed && Number(parsed[1]) !== process.pid) orphan = !(await this.alive({ pid: Number(parsed[1]), ...(Number(parsed[2]) > 0 ? { startedAtMs: Number(parsed[2]) } : {}) }).catch(() => true));
    verdicts.set(entry.owner ?? "", orphan);
    return orphan;
  }

  /** Under the lock: closings that failed before, orphaned `live` entries, then retention. */
  private async prepare(state: State, now: number, me: string): Promise<void> {
    for (const [key, reason] of this.pending) {
      const entry = state.entries.get(key);
      if (reason === null) { if (entry?.reason === live && entry.owner === me) { state.entries.delete(key); state.changed = true; } }
      else { state.entries.set(key, { at: now, reason, seq: ++state.seq }); state.changed = true; }
    }
    // A `live` entry that no running process of ours owns is a session lost with its gateway; its age starts when it is found.
    const verdicts = new Map<string, boolean>();
    for (const [key, entry] of state.entries) {
      if (entry.reason === live && await this.orphaned(entry, me, verdicts)) { state.entries.set(key, { at: now, reason: lost, seq: ++state.seq }); state.changed = true; }
    }
    for (const [key, entry] of state.entries) {
      if (entry.reason === live) continue; // never by age
      if (entry.at > now) { entry.at = now; state.changed = true; continue; } // a time in the future is now
      const age = now - entry.at;
      if (age >= grokEndedLimits.expiryMs * grokEndedLimits.suspectFactor) { entry.at = now; entry.seq = ++state.seq; state.changed = true; } // suspect: kept, aged again
      else if (age > grokEndedLimits.expiryMs) { state.entries.delete(key); state.changed = true; }
    }
  }

  /** Runs `work` on the freshly read store under the cross-process lock; whatever it or the preparation changed is written before the lock is released. */
  private run<T>(work: (state: State, now: number, me: string) => T): Promise<T> {
    return this.exclusive(async () => {
      const me = await this.identity();
      try {
        return await withPrivateFileLock(this.path, async () => {
          const state = await this.read(); const now = this.clock(); const retried = new Map(this.pending);
          await this.prepare(state, now, me);
          const result = work(state, now, me);
          if (state.changed) await this.write(state);
          for (const [key, reason] of retried) if (this.pending.get(key) === reason) this.pending.delete(key);
          return result;
        });
      } catch (error) { throw error instanceof GrokEndedStoreError ? error : unavailable(); }
    });
  }

  /** Writes the whole store to a temporary file and renames it over the real one; leftover temporary files of dead writers are removed first. */
  private async write(state: State): Promise<void> {
    await this.reclaimTemporaries();
    const temporary = GrokEndedStore.tempName(this.path);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, seq: state.seq, entries: Object.fromEntries(state.entries) })); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
      state.changed = false;
    } catch {
      await unlink(temporary).catch(() => {});
      throw unavailable();
    }
  }

  /** Removes this store's own temporary files that are older than a minute and whose writer process is not running. */
  private async reclaimTemporaries(): Promise<void> {
    const folder = dirname(this.path); const pattern = new RegExp(`^${escape(basename(this.path))}\\.(\\d+)\\.[0-9a-f]{12}\\.tmp$`);
    let names: string[];
    try { names = await readdir(folder); } catch { return; }
    for (const name of names) {
      const match = pattern.exec(name); if (!match) continue;
      const file = join(folder, name);
      try {
        const info = await lstat(file);
        if (!info.isFile() || Date.now() - info.mtimeMs < grokEndedLimits.tempStaleMs) continue;
        // `processAlive` answers false for this very process: its own writes are serialized, so an old temporary of ours is a leftover.
        if (await this.alive({ pid: Number(match[1]) })) continue;
        await unlink(file);
      } catch { /* Gone already, or not ours to remove. */ }
    }
  }

  /** The reason this conversation is closed, or undefined when it may start. Throws when the store cannot say. */
  lookup(key: string): Promise<string | undefined> {
    return this.run(state => {
      const entry = state.entries.get(key);
      return entry ? entry.reason === live ? lost : entry.reason : undefined;
    });
  }

  /**
   * Records that a session is about to start, only when the key is absent: the existing record's reason is returned
   * instead (nothing is written), and undefined means this call holds the conversation. Throws (and records nothing)
   * when the store is full or cannot be written.
   */
  reserve(key: string): Promise<string | undefined> {
    return this.run((state, now, me) => {
      const entry = state.entries.get(key);
      if (entry) return entry.reason === live ? lost : entry.reason;
      if (state.entries.size >= grokEndedLimits.maxEntries) throw full();
      state.entries.set(key, { at: now, reason: live, seq: ++state.seq, owner: me }); state.changed = true;
      return undefined;
    });
  }

  /** The session ended: the conversation is closed with this reason. A write failure is kept and retried; lookups fail closed meanwhile. */
  finish(key: string, reason: string): Promise<void> {
    const fixed = fixedReason(reason);
    this.pending.set(key, fixed === "other" ? "closed" : fixed);
    return this.run(() => undefined).then(() => undefined, () => undefined);
  }

  /** The session spent nothing and never ran a prompt: the conversation may start again (only a reservation of this process is released). */
  release(key: string): Promise<void> {
    this.pending.set(key, null);
    return this.run(() => undefined).then(() => undefined, () => undefined);
  }
}
