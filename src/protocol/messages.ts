import { randomUUID } from "node:crypto";
import type { InferenceEvent, Usage, WireEvent } from "./types.js";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
const identifier = () => `msg_${randomUUID().replaceAll("-", "")}`;

/** Maps gateway failures to Anthropic's native, public error envelope. */
export function anthropicError(code: string, message: string, status?: number): { type: "error"; error: { type: string; message: string } } {
  const type = code === "authentication" || status === 401 ? "authentication_error"
    : code === "cross_origin" || code === "permission" || status === 403 ? "permission_error"
    : code === "model_not_found" || code === "not_found" || status === 404 ? "not_found_error"
      : code === "usage_limit" || code === "busy" || code === "rate_limit_exceeded" || status === 429 ? "rate_limit_error"
        : code === "request_too_large" || code === "output_too_large" || code === "tooLarge" || status === 413 ? "request_too_large"
          : code === "timeout" || status === 504 ? "timeout_error"
            : code === "invalid_request" || code === "invalid_json" || code === "unsupported_protocol" || status === 400 ? "invalid_request_error"
              : "api_error";
  return { type: "error", error: { type, message } };
}

/** Native Anthropic event writer. It never manufactures thinking blocks or signatures. */
export class MessagesWriter {
  private readonly id = identifier();
  private readonly blocks: Block[] = [];
  private readonly ids = new Set<string>();
  private status: "in_progress" | "completed" | "failed" = "in_progress";
  private textIndex: number | undefined;
  private usage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  private stopReason: StopReason = "end_turn";
  private stopSequence: string | null = null;
  constructor(private readonly model: string, private readonly emit: (event: WireEvent) => void) {}
  get completed(): boolean { return this.status === "completed"; }
  private messageUsage(): Record<string, number> {
    const cached = this.usage.input_tokens_details?.cached_tokens || 0;
    const created = this.usage.input_tokens_details?.cache_creation_tokens || 0;
    return { input_tokens: Math.max(0, this.usage.input_tokens - cached - created), output_tokens: this.usage.output_tokens,
      ...(cached ? { cache_read_input_tokens: cached } : {}), ...(created ? { cache_creation_input_tokens: created } : {}) };
  }
  private snapshot(): Record<string, unknown> {
    return { id: this.id, type: "message", role: "assistant", model: this.model, content: structuredClone(this.blocks),
      stop_reason: this.status === "in_progress" ? null : this.stopReason, stop_sequence: this.status === "in_progress" ? null : this.stopSequence,
      usage: this.messageUsage() };
  }
  private closeText(): void {
    if (this.textIndex === undefined) return;
    this.emit({ type: "content_block_stop", index: this.textIndex }); this.textIndex = undefined;
  }
  begin(): void { if (this.status !== "in_progress") throw new Error("Messages response already ended"); this.emit({ type: "message_start", message: this.snapshot() }); }
  progress(): void { if (this.status === "in_progress") this.emit({ type: "ping" }); }
  result(): Record<string, unknown> { return this.snapshot(); }
  private acceptText(value: string): void {
    if (!value) return;
    if (this.textIndex === undefined) {
      const index = this.blocks.length; this.blocks.push({ type: "text", text: "" }); this.textIndex = index;
      this.emit({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    }
    const block = this.blocks[this.textIndex] as Extract<Block, { type: "text" }>;
    block.text += value; this.emit({ type: "content_block_delta", index: this.textIndex, delta: { type: "text_delta", text: value } });
  }
  private acceptTool(event: Extract<InferenceEvent, { type: "tool" }>): void {
    this.closeText(); const call = event.call; const id = call.id;
    if (typeof id !== "string" || !id || this.ids.has(id) || typeof call.function.name !== "string" || !call.function.name) throw new Error("Provider returned an invalid or duplicate tool call");
    let input: unknown;
    try { input = JSON.parse(call.function.arguments); } catch { throw new Error("Provider returned invalid tool arguments"); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Provider returned non-object tool input");
    this.ids.add(id); const index = this.blocks.length; const name = call.responseTool?.name || call.function.name;
    this.blocks.push({ type: "tool_use", id, name, input: input as Record<string, unknown> });
    this.emit({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } });
    this.emit({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
    this.emit({ type: "content_block_stop", index });
  }
  private finish(event: Extract<InferenceEvent, { type: "done" }>): void {
    if (event.interrupted) throw new Error("Interrupted inference cannot complete a Messages response");
    if (event.stopReason === "max_tokens" && this.ids.size) throw new Error("Provider reached its output limit while returning tools");
    if (event.endTurn === false && !this.ids.size && event.stopReason !== "max_tokens") throw new Error("Provider continued without a tool or output limit");
    this.closeText(); this.usage = event.usage;
    this.stopReason = event.stopReason === "max_tokens" ? "max_tokens" : event.stopReason === "stop_sequence" ? "stop_sequence" : this.ids.size ? "tool_use" : "end_turn";
    this.stopSequence = this.stopReason === "stop_sequence" && typeof event.stopSequence === "string" ? event.stopSequence : null;
    this.status = "completed";
    this.emit({ type: "message_delta", delta: { stop_reason: this.stopReason, stop_sequence: this.stopSequence }, usage: this.messageUsage() });
    this.emit({ type: "message_stop" });
  }
  accept(event: InferenceEvent): void {
    if (this.status !== "in_progress") throw new Error("Provider emitted after the Messages response ended");
    switch (event.type) {
      case "text": this.acceptText(event.text); return;
      case "message-done": this.closeText(); return;
      case "tool": this.acceptTool(event); return;
      case "reasoning": case "reasoning-state": return;
      case "done": this.finish(event); return;
    }
  }
  fail(code: string, message: string, status?: number): void {
    if (this.status !== "in_progress") return;
    this.status = "failed"; this.emit(anthropicError(code, message, status));
  }
}
