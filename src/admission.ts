import { ProviderError } from "./providers/provider.js";

interface Waiter { signal: AbortSignal; abort: () => void; resolve: (release: () => void) => void; reject: (error: unknown) => void }
/** One bounded FIFO; cancellation removes a waiter without starting its provider. */
export class Admission {
  running = 0;
  private limit: number;
  private readonly waiters: Waiter[] = [];
  constructor(limit: number, private readonly capacity = 32) { this.limit = limit; }
  get queued(): number { return this.waiters.length; }
  setLimit(limit: number): void { this.limit = limit; this.pump(); }
  check(): void {
    if (this.running >= this.limit && this.queued >= this.capacity) throw new ProviderError("busy", "Gateway waiting queue is full; retry shortly", 429);
  }
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted(); this.check();
    if (this.running < this.limit && !this.queued) return this.start();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject, abort: () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        signal.removeEventListener("abort", waiter.abort); reject(signal.reason); this.pump();
      } };
      this.waiters.push(waiter); signal.addEventListener("abort", waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
    });
  }
  private start(): () => void {
    this.running++; let released = false;
    return () => { if (!released) { released = true; this.running--; this.pump(); } };
  }
  private pump(): void {
    while (this.running < this.limit && this.waiters.length) {
      const waiter = this.waiters.shift()!; waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) { waiter.reject(waiter.signal.reason); continue; }
      waiter.resolve(this.start());
    }
  }
}
