import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateJson } from "./config.js";
import { object, type Message } from "./app-server-connection.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { telemetry } from "./telemetry.js";

const maxEntries = 512;
const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
const replayAgeMs = 24 * 60 * 60 * 1000;
const claimAgeMs = 60 * 1000;
const terminal = new Set(["completed", "failed", "interrupted"]);
const fileWrites = new Map<string, Promise<unknown>>();

export interface CompletionReplayEntry { device?: string; threadId?: string; turnId: string; followedAt: number; delivered: boolean; deliveredAt?: number; claim?: { id: string; at: number } }
export interface CompletionReplayStorage { read(): Promise<Record<string, CompletionReplayEntry>>; update<T>(change: (entries: Record<string, CompletionReplayEntry>) => T): Promise<T>; settled?: () => Promise<void>; liveKey?: string }
export type CompletionReplayOutcome = "delivered" | "stale" | "turn_changed" | "not_terminal" | "already_delivered_in_session" | "lookup_failed";

/** A small, host-wide record of terminals an adapter could not forward to an app. */
export class CompletionReplay {
  private readonly followed = new Map<string, number>();
  private readonly delivered = new Set<string>();
  private writes = Promise.resolve();
  private readonly live: Set<string>;
  private device: string;
  private identitySettled: boolean;
  private readonly pendingFollows = new Map<string, Message>();
  private readonly pendingWrites = new Map<string, Message>();
  private readonly pendingDelivered = new Set<string>();
  constructor(private readonly dependencies: {
    storage: CompletionReplayStorage;
    request: (method: string, params: Message) => Promise<Message>;
    emit: (message: Message) => Promise<void>;
    clock?: () => number;
    record?: (event: "completion_replayed", fields: { outcome: CompletionReplayOutcome }) => void;
    device?: string;
    awaitClient?: boolean;
  }) { this.live = liveDelivered(this.dependencies.storage); this.device = dependencies.device ?? "local"; this.identitySettled = !dependencies.awaitClient; }
  private get now(): number { return (this.dependencies.clock ?? Date.now)(); }
  private key(threadId: string, turnId: string): string { return `${this.device}\0${threadId}\0${turnId}`; }
  private entryKey(threadId: string): string { return `${this.device}\0${threadId}`; }
  /** A hello decides the device; every other first client frame decides local. */
  setDevice(device: string): void { if (!this.identitySettled) this.device = device; this.settleDevice(); }
  settleDevice(): void {
    if (this.identitySettled) return;
    this.identitySettled = true;
    const follows = [...this.pendingFollows.values()], writes = [...this.pendingWrites.values()];
    this.pendingFollows.clear(); this.pendingWrites.clear();
    for (const message of follows) this.forward(message);
    for (const message of writes) {
      const found = terminalMessage(message); if (found) this.pendingDelivered.delete(`${found.threadId}\0${found.turnId}`);
      void this.persistWritten(message);
    }
  }
  /** Reserve an outbound frame before it is written. False means this session already received this terminal. */
  forward(message: Message): boolean {
    const params = object(message.params), threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const turn = object(params.turn), turnId = typeof turn.id === "string" ? turn.id : typeof params.turnId === "string" ? params.turnId : undefined;
    if (!threadId || !turnId) return true;
    const key = this.key(threadId, turnId), method = message.method;
    const completed = method === "turn/completed" && terminal.has(String(turn.status));
    if (!this.identitySettled) {
      const pendingKey = `${threadId}\0${turnId}`;
      if (completed) return !this.pendingDelivered.has(pendingKey);
      this.pendingFollows.set(pendingKey, message); return true;
    }
    if (method === "turn/completed") {
      if (!terminal.has(String(turn.status))) return true;
      if (this.delivered.has(key)) return false;
      this.delivered.add(key);
    }
    if (!completed && !this.delivered.has(key) && (method === "turn/started" || !this.followed.has(key))) {
      const followedAt = this.now; this.followed.set(key, followedAt); this.queue(entries => {
        const entryKey = this.entryKey(threadId), current = entries[entryKey];
        if (!current || current.turnId === turnId) entries[entryKey] = { device: this.device, threadId, turnId, followedAt, delivered: current?.delivered ?? false, ...(current?.deliveredAt === undefined ? {} : { deliveredAt: current.deliveredAt }), ...(current?.claim ? { claim: current.claim } : {}) };
        else if (current.followedAt <= followedAt) entries[entryKey] = { device: this.device, threadId, turnId, followedAt, delivered: false };
      });
    }
    return true;
  }
  /** Persist a terminal only after its app write succeeds. */
  written(message: Message): Promise<void> {
    const found = terminalMessage(message); if (!found) return Promise.resolve();
    if (!this.identitySettled) {
      const pendingKey = `${found.threadId}\0${found.turnId}`;
      this.pendingDelivered.add(pendingKey); this.pendingWrites.set(pendingKey, message); return Promise.resolve();
    }
    return this.persistWritten(message);
  }
  private persistWritten(message: Message): Promise<void> {
    const found = terminalMessage(message); if (!found) return Promise.resolve();
    const { threadId, turnId } = found, key = this.key(threadId, turnId), followedAt = this.followed.get(key);
    this.delivered.add(key);
    this.live.add(key); if (this.live.size > maxEntries) this.live.delete(this.live.values().next().value!);
    return this.queue(entries => {
      const entryKey = this.entryKey(threadId), current = entries[entryKey];
      if (!current) entries[entryKey] = { device: this.device, threadId, turnId, followedAt: followedAt ?? this.now, delivered: true, deliveredAt: this.now };
      else if (current.turnId === turnId) { current.delivered = true; current.deliveredAt = this.now; delete current.claim; }
      // A terminal delayed behind a newer followed turn is never allowed to replace it.
    });
  }
  /** A failed app write must leave this session and the durable ledger eligible for a later replay. */
  failed(message: Message): void {
    const found = terminalMessage(message); if (!found) return;
    if (!this.identitySettled) {
      const pendingKey = `${found.threadId}\0${found.turnId}`;
      this.pendingWrites.delete(pendingKey); this.pendingDelivered.delete(pendingKey);
    }
    else this.delivered.delete(this.key(found.threadId, found.turnId));
  }
  /** Run only after a successful thread/resume reply has reached this adapter session. */
  async resume(threadId: string): Promise<void> {
    let entry: CompletionReplayEntry | undefined;
    try { entry = (await this.dependencies.storage.read())[this.entryKey(threadId)]; } catch { return; }
    if (!entry || entry.delivered) return;
    const now = this.now;
    if (now - entry.followedAt > maxAgeMs) return this.outcome("stale");
    let page: Message;
    try { page = await timeout(this.dependencies.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }), 10_000); }
    catch { return this.outcome("lookup_failed"); }
    const turn = Array.isArray(page.data) ? object(page.data[0]) : {};
    if (turn.id !== entry.turnId) return this.outcome("turn_changed");
    if (!terminal.has(String(turn.status))) return this.outcome("not_terminal");
    const completedAt = Number(turn.completedAt);
    if (!Number.isFinite(completedAt) || now - completedAt * 1000 > replayAgeMs) return this.outcome("stale");
    const key = this.key(threadId, entry.turnId);
    try { await this.dependencies.storage.settled?.(); }
    catch { return this.outcome("lookup_failed"); }
    if (this.delivered.has(key) || this.live.has(key)) return this.outcome("already_delivered_in_session");
    const claim = randomBytes(12).toString("hex");
    const claimed = await this.dependencies.storage.update(entries => {
      const current = entries[this.entryKey(threadId)];
      if (!current || current.turnId !== entry.turnId || current.delivered || current.claim && now - current.claim.at <= claimAgeMs) return false;
      current.claim = { id: claim, at: now }; return true;
    }).catch(() => false);
    if (!claimed || this.delivered.has(key) || this.live.has(key)) { if (claimed) await this.release(threadId, entry.turnId, claim); return; }
    this.delivered.add(key);
    try { await this.dependencies.emit({ method: "turn/completed", params: { threadId, turn } }); }
    catch { this.delivered.delete(key); await this.release(threadId, entry.turnId, claim); return; }
    await this.dependencies.storage.update(entries => {
      const current = entries[this.entryKey(threadId)];
      if (current?.turnId === entry.turnId && current.claim?.id === claim) { current.delivered = true; current.deliveredAt = this.now; delete current.claim; }
    }).catch(() => {});
    this.outcome("delivered");
  }
  /** Lets tests and shutdown wait for the intentionally non-blocking ledger work. */
  settled(): Promise<void> { return this.writes; }
  private async release(threadId: string, turnId: string, claim: string): Promise<void> {
    await this.dependencies.storage.update(entries => {
      const current = entries[this.entryKey(threadId)];
      if (current?.turnId === turnId && current.claim?.id === claim) delete current.claim;
    }).catch(() => {});
  }
  private queue(change: (entries: Record<string, CompletionReplayEntry>) => unknown): Promise<void> {
    this.writes = this.writes.then(async () => { await this.dependencies.storage.update(change); }).catch(() => {});
    return this.writes;
  }
  private outcome(outcome: CompletionReplayOutcome): void { (this.dependencies.record ?? ((event, fields) => telemetry(event, fields)))("completion_replayed", { outcome }); }
}

/** Private file implementation used by all adapter processes on one machine. */
export function completionReplayStorage(stateDirectory: string, clock = Date.now): CompletionReplayStorage {
  const path = join(stateDirectory, "completion-replay.json"), lock = join(stateDirectory, "completion-replay");
  const load = async (): Promise<Record<string, CompletionReplayEntry>> => {
    try { return prune(JSON.parse(await readFile(path, "utf8")), clock()); } catch { return {}; }
  };
  return {
    read: async () => withPrivateFileLock(lock, load).catch(() => ({})),
    update: async change => serialFileWrite(path, () => withPrivateFileLock(lock, async () => { const entries = await load(); const result = change(entries); const kept = prune(entries, clock()); await writePrivateJson(path, kept); return result; })),
    settled: async () => { await (fileWrites.get(path) ?? Promise.resolve()); },
    liveKey: path,
  };
}

function serialFileWrite<T>(path: string, write: () => Promise<T>): Promise<T> {
  const previous = fileWrites.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(write);
  fileWrites.set(path, next);
  void next.finally(() => { if (fileWrites.get(path) === next) fileWrites.delete(path); }).catch(() => {});
  return next as Promise<T>;
}

function terminalMessage(message: Message): { threadId: string; turnId: string } | undefined {
  const params = object(message.params), turn = object(params.turn), threadId = typeof params.threadId === "string" ? params.threadId : undefined, turnId = typeof turn.id === "string" ? turn.id : undefined;
  return message.method === "turn/completed" && threadId && turnId && terminal.has(String(turn.status)) ? { threadId, turnId } : undefined;
}

const liveDeliveries = new Map<string | CompletionReplayStorage, Set<string>>();
function liveDelivered(storage: CompletionReplayStorage): Set<string> {
  const key = storage.liveKey ?? storage, current = liveDeliveries.get(key); if (current) return current;
  const created = new Set<string>(); liveDeliveries.set(key, created); return created;
}

function prune(value: unknown, now: number): Record<string, CompletionReplayEntry> {
  const entries: Array<[string, CompletionReplayEntry]> = [];
  for (const [key, raw] of Object.entries(object(value))) {
    const entry = object(raw), turnId = typeof entry.turnId === "string" ? entry.turnId : undefined, followedAt = Number(entry.followedAt);
    const modern = typeof entry.device === "string" && typeof entry.threadId === "string" && key === `${entry.device}\0${entry.threadId}`;
    const device = modern ? entry.device as string : "unknown", threadId = modern ? entry.threadId as string : key;
    if (threadId && !threadId.includes("\0") && turnId && Number.isFinite(followedAt) && now - followedAt <= maxAgeMs && typeof entry.delivered === "boolean") {
      const claim = object(entry.claim);
      entries.push([`${device}\0${threadId}`, { device, threadId, turnId, followedAt, delivered: entry.delivered, ...(Number.isFinite(Number(entry.deliveredAt)) ? { deliveredAt: Number(entry.deliveredAt) } : {}), ...(typeof claim.id === "string" && Number.isFinite(Number(claim.at)) ? { claim: { id: claim.id, at: Number(claim.at) } } : {}) }]);
    }
  }
  entries.sort((a, b) => b[1].followedAt - a[1].followedAt);
  return Object.fromEntries(entries.slice(0, maxEntries));
}

async function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("completion lookup timed out")), ms); timer.unref(); })]); }
  finally { if (timer) clearTimeout(timer); }
}
