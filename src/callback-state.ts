import type { Id } from "./app-server-connection.js";

/** Answered callbacks whose full fingerprint is kept per connection, so a harmless duplicate is ignored and a changed one is refused. */
export const RECENT_CALLBACKS = 256;
/** Disjoint completed numeric id ranges and exact completed string ids a connection may remember; a full history refuses new callbacks. */
export const COMPLETED_RANGES = 4096;
export const COMPLETED_STRINGS = 1024;
/** Threaded callbacks (approvals, dynamic tool calls) protected from loss with a socket; a full set refuses new ones instead of evicting. */
export const PROTECTED_CALLBACKS = 256;

export class CallbackHistoryFull extends Error {
  constructor() { super("Codex server request history is full"); }
}
export class CallbackReplayed extends Error {
  constructor() { super("Completed Codex server request replayed"); }
}

/**
 * Exact completed integers as sorted inclusive ranges. Two ranges merge only when their ids were actually completed and are
 * adjacent: an id that was skipped (another client's callback, say) is never claimed as completed, so a delayed lower id that
 * was never seen still passes.
 */
export class CompletedNumbers {
  private readonly ranges: Array<[number, number]> = [];
  get size(): number { return this.ranges.length; }
  /** Index of the first range whose end is not below `value`. */
  private find(value: number): number {
    let low = 0; let high = this.ranges.length;
    while (low < high) { const mid = (low + high) >> 1; if (this.ranges[mid][1] < value) low = mid + 1; else high = mid; }
    return low;
  }
  has(value: number): boolean { const at = this.find(value); return at < this.ranges.length && this.ranges[at][0] <= value; }
  add(value: number): void {
    const at = this.find(value);
    if (at < this.ranges.length && this.ranges[at][0] <= value) return;
    const joinsBefore = at > 0 && this.ranges[at - 1][1] === value - 1;
    const joinsAfter = at < this.ranges.length && this.ranges[at][0] === value + 1;
    if (joinsBefore && joinsAfter) { this.ranges[at - 1][1] = this.ranges[at][1]; this.ranges.splice(at, 1); }
    else if (joinsBefore) this.ranges[at - 1][1] = value;
    else if (joinsAfter) this.ranges[at][0] = value;
    else this.ranges.splice(at, 0, [value, value]);
  }
}

interface Answered { id: string; fingerprint: string; resolved: boolean }

/**
 * One connection's server-request ids. Ids are scoped to the connection that sent them. `pending` holds only unanswered
 * callbacks (original id to desktop id). An answered or resolved callback leaves it for bounded recent fingerprints plus the
 * exact completed-id memory, so history can never push out a true pending approval and a forgotten fingerprint can never let
 * an old id execute a second time.
 */
export class CallbackLedger {
  private readonly pending = new Map<Id, string>();
  private readonly recent = new Map<Id, Answered>();
  private readonly numbers = new CompletedNumbers();
  private readonly strings = new Set<string>();
  pendingId(original: Id): string | undefined { return this.pending.get(original); }
  answered(original: Id): Answered | undefined { return this.recent.get(original); }
  completed(original: Id): boolean {
    return typeof original === "number" ? this.numbers.has(original) : this.strings.has(original);
  }
  /** Refuses an id this ledger cannot remember exactly, or one whose completion it could not afford to remember. */
  admit(original: Id): void {
    if (typeof original === "number" && !Number.isSafeInteger(original)) throw new Error("Invalid or excessive pending Codex server requests");
    // Every pending callback may need one more slot when it completes, so room is reserved for all of them now.
    const used = typeof original === "number" ? this.numbers.size : this.strings.size;
    if (used + this.pending.size >= (typeof original === "number" ? COMPLETED_RANGES : COMPLETED_STRINGS)) throw new CallbackHistoryFull();
  }
  track(original: Id, desktop: string): void { this.pending.set(original, desktop); }
  /** The callback is finished (answered or resolved): keep its fingerprint for a while and its id for good. */
  complete(original: Id, desktop: string, fingerprint: string, resolved = false): void {
    this.pending.delete(original);
    this.recent.delete(original); this.recent.set(original, { id: desktop, fingerprint, resolved });
    while (this.recent.size > RECENT_CALLBACKS) this.recent.delete(this.recent.keys().next().value as Id);
    if (typeof original === "string") this.strings.add(original); else if (Number.isSafeInteger(original)) this.numbers.add(original);
  }
  /** The engine says the callback is resolved. Returns its desktop id the first time only, so the desktop hears it once. */
  resolve(original: Id, fingerprint: string): string | undefined {
    const pending = this.pending.get(original);
    if (pending !== undefined) { this.complete(original, pending, fingerprint, true); return pending; }
    const answered = this.recent.get(original);
    if (answered && !answered.resolved) { answered.resolved = true; return answered.id; }
    return undefined;
  }
}
