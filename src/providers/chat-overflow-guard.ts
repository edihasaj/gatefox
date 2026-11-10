/**
 * Bounds the client's overflow trimming loop on Chat Completions providers. When a request exceeds the window, Codex drops
 * its oldest history item and retries. A worker forked with far more history than the window allows can then retry for an
 * hour: on 10 November 2026 three forked Qwen workers sent about 4,000 refused requests over 89 minutes. After
 * `limit` consecutive overflows for one conversation inside `windowMs`, further requests fail once, locally, with a
 * non-retryable error that names the remedy. Any completed request resets the count. Only routing identities are kept.
 */
import { ProviderError } from "./provider.js";

export const overflowGuardLimit = 25;
export const overflowGuardWindowMs = 10 * 60_000;
const maxEntries = 512;

type Entry = { count: number; last: number };

export class ChatOverflowGuard {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly limit = overflowGuardLimit, private readonly windowMs = overflowGuardWindowMs, private readonly now = () => Date.now()) {}

  private current(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.last > this.windowMs) { this.entries.delete(key); return; }
    return entry;
  }
  /** True when this conversation already hit the limit and should not reach the provider again yet. */
  exhausted(key: string | undefined): boolean {
    return key !== undefined && (this.current(key)?.count ?? 0) >= this.limit;
  }
  overflow(key: string | undefined): void {
    if (key === undefined) return;
    const entry = this.current(key) ?? { count: 0, last: 0 };
    entry.count += 1; entry.last = this.now();
    this.entries.delete(key); this.entries.set(key, entry);
    while (this.entries.size > maxEntries) this.entries.delete(this.entries.keys().next().value as string);
  }
  success(key: string | undefined): void { if (key !== undefined) this.entries.delete(key); }
}

export const overflowExhausted = () => new ProviderError("invalid_request",
  "The conversation still exceeds the model's context window after repeated trimming; start a fresh worker with a compact handoff (fork_turns=\"none\")", 400);
