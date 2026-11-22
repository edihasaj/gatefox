import { ProviderError } from "./provider.js";
import { telemetry } from "../telemetry.js";
import type { ClaudeTokens } from "./claude-stream.js";

export const toolCorrectionLimits = { attempts: 2, rejectionMs: 10_000 };
const failure = () => new ProviderError("invalid_tool_call",
  "Claude could not correct an unavailable gateway tool. No tool calls from this response were forwarded. Send a new message to continue.",
  502, { code: "unavailable_gateway_tool", event: "claude.tool_use" });

/** Native CLI error feedback for unavailable private gateway names. Never a guessed alias, tool result or inference replay. */
export class ClaudeToolCorrection {
  /** Unavailable calls in the current model message, keyed by call ID. */
  private readonly batch = new Map<string, { name: string; rejected: boolean }>();
  private batchComplete = false;
  private batchDeclared = false;
  /** Withheld calls from an earlier request of this live CLI that still need the CLI's own error result. */
  private readonly awaiting = new Set<string>();
  /** Only a live session that carries withheld calls into its next request may forward the declared part of a mixed batch. */
  private mixedAllowed = false;
  private withheldIds: string[] = [];
  private attempts = 0;
  private recovered = false;
  private readonly rejected = new Set<string>();
  private readonly costs: ClaudeTokens[] = [];
  private deadline?: number;
  get hasCorrections(): boolean { return this.costs.length > 0; }
  /** Calls withheld from the caller by the request that just ended; the CLI rejects them natively. */
  get withheld(): string[] { return this.withheldIds; }
  constructor(private readonly enabled: boolean, private readonly nativeNames: Set<string>, private readonly threadKey?: string) {}

  /** Called by a live session for every request it runs, with the calls it still expects the CLI to reject. */
  expectRejections(ids: Iterable<string>): void {
    this.mixedAllowed = this.enabled;
    for (const id of ids) this.awaiting.add(id);
  }

  admit(name: unknown, id: unknown): boolean {
    if (!this.enabled || typeof name !== "string" || this.nativeNames.has(name) ||
      !/^mcp__gateway__[A-Za-z0-9_]{1,51}$/.test(name) || typeof id !== "string" || !id) return false;
    const known = this.batch.get(id);
    if (known) {
      if (known.name !== name) this.stop("mixed_calls");
      return true;
    }
    if (this.batchComplete || this.batchDeclared && !this.mixedAllowed) this.stop("mixed_calls");
    if (this.rejected.has(id) || this.awaiting.has(id) || this.attempts >= toolCorrectionLimits.attempts) this.stop("exhausted");
    this.batch.set(id, { name, rejected: false });
    this.deadline = Date.now() + toolCorrectionLimits.rejectionMs;
    return true;
  }

  /** A declared call. Next to an unavailable one it is a mixed batch, which only a live session can split. */
  registered(id: unknown): void {
    if (typeof id === "string" && (this.rejected.has(id) || this.awaiting.has(id))) this.stop("reused_id");
    if (this.batchComplete || this.batch.size && !this.mixedAllowed) this.stop("mixed_calls");
    this.batchDeclared = true;
  }

  /** Wait for the CLI's own rejection of each unavailable call before accepting another model message. */
  observe(message: Record<string, unknown>): void {
    // While the message with an unavailable call is still streaming, the bound is inactivity, so a long declared sibling can finish.
    if (this.batch.size && !this.batchComplete) this.deadline = Date.now() + toolCorrectionLimits.rejectionMs;
    if (message.type === "user") {
      const content = (message.message as { content?: unknown } | undefined)?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const pending = this.batch.get(block.tool_use_id);
        if (!pending && !this.awaiting.has(block.tool_use_id)) continue;
        if (block.is_error !== true) this.stop("unconfirmed_rejection");
        if (pending) pending.rejected = true; else this.awaiting.delete(block.tool_use_id);
        this.record("native_rejected");
      }
      if (this.batchComplete && [...this.batch.values()].every(call => call.rejected)) this.deadline = undefined;
    } else if (message.type === "message_start" || message.type === "stream_event" && (message.event as { type?: unknown } | undefined)?.type === "message_start") {
      if (this.awaiting.size) this.stop("unconfirmed_rejection");
      if (this.batch.size) {
        if (!this.batchComplete || [...this.batch.values()].some(call => !call.rejected)) this.stop("unconfirmed_rejection");
        for (const id of this.batch.keys()) this.rejected.add(id);
        this.batch.clear(); this.batchComplete = false; this.deadline = undefined;
      }
      this.batchDeclared = false;
    } else if (message.type === "result" && (this.batch.size || this.awaiting.size)) this.stop("unconfirmed_rejection");
  }

  /**
   * The calls of one finished model message that may reach the caller. Without unavailable calls that is all of
   * them. A batch of only unavailable calls returns none and waits for the CLI to correct itself in this turn.
   * A live mixed batch returns its declared calls; the CLI rejects the rest, and the next request checks that.
   */
  complete<T extends { id: string; name: string }>(calls: T[], tokens: ClaudeTokens): T[] {
    if (!this.batch.size) return calls;
    if (this.batchComplete) return [];
    const unavailable = calls.filter(call => this.batch.has(call.id));
    if (unavailable.length !== this.batch.size || unavailable.some(call => this.batch.get(call.id)!.name !== call.name)) this.stop("mixed_calls");
    const declared = calls.filter(call => !this.batch.has(call.id));
    if (declared.length && !this.mixedAllowed) this.stop("mixed_calls");
    this.attempts++;
    if (declared.length) {
      this.withheldIds = [...this.batch].filter(([, call]) => !call.rejected).map(([id]) => id);
      this.batch.clear(); this.deadline = undefined;
      this.record("withheld");
      return declared;
    }
    this.batchComplete = true; this.costs.push(tokens);
    this.deadline = [...this.batch.values()].some(call => !call.rejected) ? Date.now() + toolCorrectionLimits.rejectionMs : undefined;
    this.record("attempted");
    return [];
  }

  /** All native model calls are billed, including the call that selected the unavailable name. */
  total(current?: Partial<ClaudeTokens>): Partial<ClaudeTokens> | undefined {
    if (!this.costs.length) return current ? { ...current } : undefined;
    const parts = [...this.costs, ...(current ? [current] : [])];
    const sum = (key: keyof ClaudeTokens) => parts.every(part => part[key] !== undefined) ? parts.reduce((n, part) => n + part[key]!, 0) : undefined;
    return { input: sum("input"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), output: sum("output") };
  }

  finish(tokens: ClaudeTokens): ClaudeTokens {
    if (this.batch.size || this.awaiting.size) this.stop("unconfirmed_rejection");
    if (this.attempts && !this.recovered) { this.recovered = true; this.record("recovered"); }
    const total = this.total(tokens)!;
    return { ...total, output: total.output ?? 0 };
  }

  async wait<T>(next: Promise<T>): Promise<T> {
    if (this.deadline === undefined) return next;
    if (Date.now() >= this.deadline) { void next.catch(() => {}); this.stop("rejection_timeout"); }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([next, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.record("rejection_timeout"); reject(failure()); }, Math.max(0, this.deadline! - Date.now()));
      })]);
    } finally { clearTimeout(timer); }
  }

  private stop(outcome: string): never { this.record(outcome); throw failure(); }
  private record(outcome: string): void { telemetry("claude_tool_correction", { outcome, attempt: this.attempts, threadKey: this.threadKey }); }
}
