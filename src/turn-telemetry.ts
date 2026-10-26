import { object, type Message } from "./app-server-connection.js";
import { telemetry } from "./telemetry.js";

interface Turn { startedAt: number; lastEventAt: number; items: number; agentMessages: number; toolCalls: number; reasoning: number; errors: number; quietReported: number }
const toolItems = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "collabAgentToolCall", "imageView"]);

/** Classifies Codex error text into a fixed set; the text itself is never logged. */
export function errorClass(message: unknown): string {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  if (!text) return "none";
  for (const [name, pattern] of [
    ["stream_disconnected", /stream disconnected|ended without completion|connection (reset|closed)/],
    ["idle_timeout", /idle timeout|timed out waiting/], ["deadline", /deadline|exceeded the gateway/],
    ["usage_limit", /usage[ _-]limit|quota/], ["rate_limit", /rate[ _-]limit/], ["context_window", /context (window|length)|too long/],
    ["attachment", /attachment is invalid|could not read the local/], ["authentication", /login|unauthori[sz]ed|authentication/],
    // A status code stands alone; digits inside a thread id must not count as one.
    ["overloaded", /overload|server_error|unavailable|\b5\d\d\b/],
    ["tool_call", /tool call|unknown tool|malformed tool/], ["cancelled", /cancel|interrupt/],
  ] as const) if (pattern.test(text)) return name;
  return "other";
}

/**
 * Watches app-server notifications on their way to the client. It records each
 * turn's outcome and flags the shapes that look like silent stops: a completed
 * turn with no answer and no tool call, or an active turn with no events for
 * five minutes.
 */
export class TurnTelemetry {
  private readonly turns = new Map<string, Turn>();
  private readonly timer: NodeJS.Timeout;
  /** `describe` gives the chat's engine kind as `provider`, its model, and for a gateway chat the provider id it was saved with as `identity`. */
  constructor(private readonly describe: (threadId: string) => { provider?: string; model?: string; identity?: string }) {
    this.timer = setInterval(() => this.checkQuiet(), 60000); this.timer.unref();
  }
  close(): void { clearInterval(this.timer); }
  /** Turns started and not yet completed on this connection. */
  get active(): number { return this.turns.size; }
  private key(params: Message): string | undefined {
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const turnId = typeof params.turnId === "string" ? params.turnId : typeof object(params.turn).id === "string" ? String(object(params.turn).id) : undefined;
    return threadId && turnId ? `${threadId}\n${turnId}` : undefined;
  }
  private fields(key: string): Record<string, unknown> {
    const [threadId, turnId] = key.split("\n"); const route = this.describe(threadId!);
    return { threadId, turnId, provider: route.provider || "unknown", model: route.model, identity: route.identity };
  }
  observe(message: Message): void {
    const method = typeof message.method === "string" ? message.method : ""; const params = object(message.params); const now = Date.now();
    if (method === "turn/started") {
      const key = this.key(params); if (!key) return;
      this.turns.set(key, { startedAt: now, lastEventAt: now, items: 0, agentMessages: 0, toolCalls: 0, reasoning: 0, errors: 0, quietReported: 0 });
      if (this.turns.size > 512) this.turns.delete(this.turns.keys().next().value!);
      telemetry("turn_started", this.fields(key)); return;
    }
    const key = this.key(params); const turn = key ? this.turns.get(key) : undefined;
    if (turn) turn.lastEventAt = now;
    if (method === "item/completed" && turn) {
      const type = String(object(params.item).type); turn.items++;
      if (type === "agentMessage") turn.agentMessages++; else if (type === "reasoning") turn.reasoning++; else if (toolItems.has(type)) turn.toolCalls++;
    }
    if (method === "error" && key) {
      const error = object(params.error); if (turn) turn.errors++;
      telemetry("turn_error", { ...this.fields(key), willRetry: params.willRetry === true, errorInfo: typeof error.codexErrorInfo === "string" ? error.codexErrorInfo : typeof error.codexErrorInfo === "object" && error.codexErrorInfo ? Object.keys(error.codexErrorInfo as object)[0] : undefined, errorClass: errorClass(error.message) });
    }
    if (method === "turn/completed" && key) {
      const status = String(object(params.turn).status); const error = object(object(params.turn).error);
      const empty = status === "completed" && !!turn && turn.agentMessages === 0 && turn.toolCalls === 0;
      telemetry(empty ? "turn_empty_completion" : "turn_completed", { ...this.fields(key), status, durationMs: turn ? now - turn.startedAt : undefined,
        items: turn?.items, agentMessages: turn?.agentMessages, toolCalls: turn?.toolCalls, reasoningItems: turn?.reasoning, errors: turn?.errors,
        errorClass: status === "failed" ? errorClass(error.message) : undefined });
      this.turns.delete(key);
    }
  }
  private checkQuiet(): void {
    const now = Date.now();
    for (const [key, turn] of this.turns) {
      const quietMinutes = Math.floor((now - turn.lastEventAt) / 60000);
      if (quietMinutes >= 5 && quietMinutes >= turn.quietReported + 5) { turn.quietReported = quietMinutes; telemetry("turn_quiet", { ...this.fields(key), quietMinutes, items: turn.items }); }
      if (now - turn.startedAt > 24 * 3600000) this.turns.delete(key);
    }
  }
}
