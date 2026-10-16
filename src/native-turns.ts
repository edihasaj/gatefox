import { isId, object, type Message } from "./app-server-connection.js";
import { telemetry } from "./telemetry.js";

export interface NativeTurn { id: string; rootTurnId: string | null; startedAt: number | null }
export const nativeId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0");

const MAX_ACTIVE = 256;
const MAX_COMPLETED = 512;
/** The eviction signal is a rare leak indicator, so repeats collapse into one event per minute. */
const EVICT_REPORT_MS = 60_000;

/** The only thread statuses that prove a turn is over; `systemError` accompanies a turn that keeps running. */
const releasedStatuses = new Set(["idle", "notLoaded"]);

/**
 * Which native (app-owned-engine) threads have a turn in flight. The adapter launched the engine,
 * so nothing here may ever stop it: the tracking cap evicts the oldest entry instead of throwing,
 * and the engine's own `thread/closed` or an `idle`/`notLoaded` `thread/status/changed` releases an
 * entry that never saw a `turn/completed` (sub-agent threads included).
 */
export class NativeTurnTracker {
  readonly active = new Map<string, NativeTurn>();
  readonly completed = new Set<string>();
  /** Bumped by anything that changes what a turn is doing, so a `thread/read` answer is only trusted when nothing raced it. */
  revision = 0;
  private evictions = 0;
  private lastEvictionReportedAt?: number;
  private evictionTimer?: NodeJS.Timeout;

  /** One notification from the native engine. Well-formed input never throws. */
  observe(message: Message): void {
    if (isId(message.id)) return;
    const params = object(message.params);
    if (message.method === "thread/closed") {
      if (nativeId(params.threadId)) { this.active.delete(params.threadId); this.revision++; }
      return;
    }
    if (message.method === "thread/status/changed") {
      // Only the tagged {type} shape is understood; anything else changes nothing.
      const status = object(params.status);
      if (nativeId(params.threadId) && typeof status.type === "string" && releasedStatuses.has(status.type)) {
        this.active.delete(params.threadId); this.revision++;
      }
      return;
    }
    const turn = object(params.turn);
    if (!nativeId(params.threadId) || !nativeId(turn.id)) return;
    const key = JSON.stringify([params.threadId, turn.id]);
    if (message.method === "turn/started" || message.method === "turn/completed") this.revision++;
    if (message.method === "turn/started" && turn.status === "inProgress") {
      if (this.completed.has(key)) return;
      // Insertion order makes the oldest thread the first to go; the engine keeps running either way.
      while (!this.active.has(params.threadId) && this.active.size >= MAX_ACTIVE) {
        const oldest = this.active.keys().next();
        if (oldest.done) break;
        this.active.delete(oldest.value); this.recordEviction();
      }
      this.active.set(params.threadId, { id: turn.id, rootTurnId: nativeId(turn.rootTurnId) ? turn.rootTurnId : null,
        startedAt: typeof turn.startedAt === "number" && Number.isFinite(turn.startedAt) ? turn.startedAt : null });
    }
    if (message.method === "turn/completed" && ["completed", "failed", "interrupted"].includes(String(turn.status))) {
      if (this.active.get(params.threadId)?.id === turn.id) this.active.delete(params.threadId);
      this.rememberCompleted(key);
    }
  }

  delete(threadId: string): void { this.active.delete(threadId); }
  /** An engine that is gone cannot evict again: the window's pending count must not die with it. */
  close(): void { clearTimeout(this.evictionTimer); this.evictionTimer = undefined; this.flushEvictions(); }
  private flushEvictions(): void {
    if (!this.evictions) return;
    // This report opens the next window, so a timer left over from the old one must not report inside it.
    clearTimeout(this.evictionTimer); this.evictionTimer = undefined;
    this.lastEvictionReportedAt = Date.now();
    telemetry("native_turns_evicted", { count: this.evictions });
    this.evictions = 0;
  }
  rememberCompleted(key: string): void {
    this.completed.add(key);
    while (this.completed.size > MAX_COMPLETED) {
      const oldest = this.completed.values().next();
      if (oldest.done) break;
      this.completed.delete(oldest.value);
    }
  }
  clear(): void { this.active.clear(); this.completed.clear(); }

  private recordEviction(): void {
    this.evictions++;
    const now = Date.now();
    if (this.lastEvictionReportedAt === undefined || now - this.lastEvictionReportedAt >= EVICT_REPORT_MS) { this.flushEvictions(); return; }
    // Inside a window the count accumulates, but it is still reported when the window closes.
    this.evictionTimer ??= setTimeout(() => { this.evictionTimer = undefined; this.flushEvictions(); }, EVICT_REPORT_MS - (now - this.lastEvictionReportedAt)).unref();
  }
}
