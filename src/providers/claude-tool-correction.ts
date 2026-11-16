import { ProviderError } from "./provider.js";
import { telemetry } from "../telemetry.js";
import type { ClaudeTokens } from "./claude-stream.js";

export const toolCorrectionLimits = { attempts: 2, rejectionMs: 10_000 };
const failure = () => new ProviderError("invalid_tool_call",
  "Claude could not correct an unavailable gateway tool. No tool calls from this response were forwarded. Send a new message to continue.",
  502, { code: "unavailable_gateway_tool", event: "claude.tool_use" });

/** Native CLI error feedback, inside the same turn. Never a guessed alias, tool result or inference replay. */
export class ClaudeToolCorrection {
  private pending?: { id: string; name: string; complete: boolean; rejected: boolean };
  private attempts = 0;
  private recovered = false;
  private readonly rejected = new Set<string>();
  private readonly costs: ClaudeTokens[] = [];
  private deadline?: number;
  get hasCorrections(): boolean { return this.costs.length > 0; }
  constructor(private readonly enabled: boolean, private readonly nativeNames: Set<string>, private readonly threadKey?: string) {}

  admit(name: unknown, id: unknown): boolean {
    if (!this.enabled || typeof name !== "string" || this.nativeNames.has(name) ||
      !/^mcp__gateway__[A-Za-z0-9_]{1,51}$/.test(name) || typeof id !== "string" || !id) return false;
    if (this.pending) {
      if (this.pending.id !== id || this.pending.name !== name) this.stop("mixed_calls");
      return true;
    }
    if (this.rejected.has(id) || this.attempts >= toolCorrectionLimits.attempts) this.stop("exhausted");
    this.pending = { id, name, complete: false, rejected: false };
    this.deadline = Date.now() + toolCorrectionLimits.rejectionMs;
    return true;
  }

  registered(id: unknown): void {
    if (this.pending) this.stop("mixed_calls");
    if (typeof id === "string" && this.rejected.has(id)) this.stop("reused_id");
  }

  /** Wait for the CLI's own rejection of this exact call before accepting another model message. */
  observe(message: Record<string, unknown>): void {
    if (!this.pending) return;
    if (message.type === "user") {
      const content = (message.message as { content?: unknown } | undefined)?.content;
      const result = Array.isArray(content) ? content.find(block => block?.type === "tool_result" && block.tool_use_id === this.pending?.id) : undefined;
      if (!result) return;
      if (result.is_error !== true) this.stop("unconfirmed_rejection");
      this.pending.rejected = true;
      if (this.pending.complete) this.deadline = undefined;
      this.record("native_rejected");
    } else if (message.type === "message_start" || message.type === "stream_event" && (message.event as { type?: unknown } | undefined)?.type === "message_start") {
      if (!this.pending.complete || !this.pending.rejected) this.stop("unconfirmed_rejection");
      this.rejected.add(this.pending.id); this.pending = undefined; this.deadline = undefined;
    } else if (message.type === "result") this.stop("unconfirmed_rejection");
  }

  complete(calls: Array<{ id: string; name: string }>, tokens: ClaudeTokens): boolean {
    if (!this.pending) return false;
    if (calls.length !== 1 || calls[0].id !== this.pending.id || calls[0].name !== this.pending.name) this.stop("mixed_calls");
    if (this.pending.complete) return true;
    this.pending.complete = true; this.attempts++; this.costs.push(tokens);
    if (this.pending.rejected) this.deadline = undefined;
    this.record("attempted");
    return true;
  }

  /** All native model calls are billed, including the call that selected the unavailable name. */
  total(current?: Partial<ClaudeTokens>): Partial<ClaudeTokens> | undefined {
    if (!this.costs.length) return current ? { ...current } : undefined;
    const parts = [...this.costs, ...(current ? [current] : [])];
    const sum = (key: keyof ClaudeTokens) => parts.every(part => part[key] !== undefined) ? parts.reduce((n, part) => n + part[key]!, 0) : undefined;
    return { input: sum("input"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), output: sum("output") };
  }

  finish(tokens: ClaudeTokens): ClaudeTokens {
    if (this.pending) this.stop("unconfirmed_rejection");
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
