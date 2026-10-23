import type { InferenceEvent, OpenAITool, OpenAIToolCall, Usage } from "../protocol/types.js";
import { ProviderError } from "./provider.js";
import { nativeClaudeCalls, nativeClaudeReasoning } from "./claude-calls.js";
import { claudeToolBindings } from "./claude-tool-names.js";
import { claudeFailure, claudeRateLimit } from "./claude-errors.js";
import { claudeAuthenticationFailure } from "./claude-auth.js";
import { claudeContextFailure } from "./context-errors.js";
import { claudeUsageEvent, type ClaudeLimit } from "./claude-usage.js";

/** Native token counts of one API message. */
export interface ClaudeTokens { input: number; cacheRead: number; cacheWrite: number; output: number }
export type ClaudeStreamEnd =
  | { kind: "tool_use"; calls: OpenAIToolCall[]; usage: Usage; tokens: ClaudeTokens }
  /** A text turn complete at its message_delta (endTurn streams only). */
  | { kind: "end_turn"; usage: Usage; tokens: ClaudeTokens }
  | { kind: "result"; result: Record<string, unknown>; usage: Usage; tokens: ClaudeTokens };
export interface ClaudeStreamStep {
  events: InferenceEvent[];
  limit?: ClaudeLimit;
  fastState?: string;
  contextWindows?: Array<{ model: string; contextWindow: number }>;
  end?: ClaudeStreamEnd;
}

const maxText = 8 * 1024 * 1024;
const fastStates = new Set(["on", "off", "cooldown"]);
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
type NativeUsage = { input_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown; output_tokens?: unknown };
function tokensOf(usage: unknown, base: ClaudeTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }): ClaudeTokens {
  const value = (usage && typeof usage === "object" ? usage : {}) as NativeUsage;
  return { input: count(value.input_tokens) ?? base.input, cacheRead: count(value.cache_read_input_tokens) ?? base.cacheRead,
    cacheWrite: count(value.cache_creation_input_tokens) ?? base.cacheWrite, output: count(value.output_tokens) ?? base.output };
}
/** Cache reads are reported the Responses way so callers can see actual cache reuse. */
export function claudeUsage(tokens: ClaudeTokens): Usage {
  const input = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return { input_tokens: input, output_tokens: tokens.output, total_tokens: input + tokens.output, input_tokens_details: {
    cached_tokens: tokens.cacheRead,
    ...(tokens.cacheWrite ? { cache_creation_tokens: tokens.cacheWrite } : {}),
  } };
}

/** Maps an unsuccessful CLI result; private result text is only classified, never returned. */
export function claudeResultFailure(result: Record<string, unknown>, limit?: ClaudeLimit): ProviderError {
  const authentication = claudeAuthenticationFailure(result); if (authentication) return authentication;
  const failure = claudeFailure({ ...result, is_error: true }, limit)!;
  // A structured provider classification wins over explanatory result prose.
  if (typeof result.error_code === "string" && ["rate_limit", "authentication_failed", "billing_error", "server_error", "invalid_request"].includes(result.error_code)) return failure;
  if (failure.code === "insufficient_quota" || failure.upstream?.reason === "reasoning_extraction") return failure;
  const diagnosis = typeof result.result === "string" ? result.result : "";
  // "Server is temporarily limiting requests (not your usage limit)" is the CLI's transient
  // subscriber 429; it stays a throttle even after a rejected event for another window.
  if (/rate.?limit|usage.?limit|limiting requests/i.test(diagnosis)) return claudeRateLimit(/not your usage.?limit/i.test(diagnosis) ? undefined : limit);
  // Older CLI result forms have no structured error_code. Keep their final login outcome,
  // but never permit credential recovery without the native authentication_failed discriminator.
  if (/auth|log.?in|oauth/i.test(diagnosis)) return new ProviderError("authentication", "Claude could not authenticate this request. Retry; if it persists, sign in again.", 401,
    { ...failure.upstream, reason: "unknown" });
  // Keep the CLI's allowlisted end reason (for example max turns) so failures stay diagnosable.
  return failure;
}

/** The context windows a CLI result reports it actually used; the catalog adopts them on refresh. */
export function resultWindows(result: Record<string, unknown>): Array<{ model: string; contextWindow: number }> {
  const used = result.modelUsage;
  return used && typeof used === "object" ? Object.entries(used as Record<string, { contextWindow?: unknown }>).flatMap(([model, value]) =>
    typeof value?.contextWindow === "number" ? [{ model: model.replace(/\[1m\]$/, ""), contextWindow: value.contextWindow }] : []) : [];
}

interface Block { id: string; name: string; json: string; input?: unknown }
interface Message { id?: string; base: ClaudeTokens; tokens?: ClaudeTokens; blocks: Map<number, Block>; stop?: string; ending?: "all" | "complete"; ended?: boolean }

/**
 * Turns the CLI's stream-json lines into inference events for one request.
 * An API message is keyed by its message_start id. Its tool calls end the
 * request only once every call is complete: the CLI emits one `assistant`
 * line per content block, all with the same message id, before message_delta.
 * A message that stops for another reason ends with its complete calls only.
 * Output tokens come only from message_delta. With `endTurn`, a message without
 * calls that stops with end_turn ends the request at its message_delta, since
 * the CLI can print its result seconds later, after a post-turn summary. Any
 * other stop still waits for the result and its error classification.
 * `accept` throws the mapped ProviderError for native failures, foreign tools
 * and inconsistent text.
 */
export class ClaudeMessageStream {
  private readonly tools: OpenAITool[]; private readonly summaryVisible: boolean; private readonly endTurn: boolean;
  private readonly bindings: Map<string, OpenAITool | undefined>;
  private message?: Message; private last?: ClaudeTokens; private limit?: ClaudeLimit; private raw = "";
  /** A non-text block started after text was streamed, so the next text begins a new paragraph. */
  private split = false;
  constructor({ tools, summaryVisible, endTurn = false }: { tools: OpenAITool[]; summaryVisible: boolean; endTurn?: boolean }) {
    this.tools = tools; this.summaryVisible = summaryVisible; this.endTurn = endTurn; this.bindings = claudeToolBindings(tools);
  }
  /** Text streamed so far, for the final result's consistency check. */
  get text(): string { return this.raw; }

  accept(message: Record<string, unknown>): ClaudeStreamStep {
    const step: ClaudeStreamStep = { events: [] };
    // The CLI falls back to standard speed (cooldown) when fast mode credits are refused.
    if (typeof message.fast_mode_state === "string" && fastStates.has(message.fast_mode_state)) step.fastState = message.fast_mode_state;
    const limit = claudeUsageEvent(message); if (limit) { this.limit = limit; step.limit = limit; }
    const context = claudeContextFailure(message); if (context) throw context;
    if (message.type === "assistant") {
      const failure = claudeFailure(message, this.limit); if (failure) throw failure;
      this.assistant(message.message, step);
    } else if (message.type === "stream_event" && message.event && typeof message.event === "object") this.event(message.event as Record<string, unknown>, step);
    else if (message.type === "result") this.result(message, step);
    return step;
  }

  private event(event: Record<string, unknown>, step: ClaudeStreamStep): void {
    const message = this.message;
    if (event.type === "message_start") {
      const native = (event.message || {}) as { id?: unknown; usage?: unknown };
      // The start snapshot's output count is provisional; the final count arrives in message_delta.
      this.message = { id: typeof native.id === "string" ? native.id : undefined, base: { ...tokensOf(native.usage), output: 0 }, blocks: new Map() };
    } else if (event.type === "content_block_start") {
      const block = (event.content_block || {}) as { type?: unknown; id?: unknown; name?: unknown };
      if (block.type !== "text" && this.raw) this.split = true;
      if (block.type !== "tool_use" || !message || message.ended) return;
      // A foreign tool fails at once, before the CLI can act on it.
      if (typeof block.name !== "string" || !this.bindings.get(block.name)) nativeClaudeCalls([{ id: String(block.id), name: block.name as string, input: {} }], this.tools);
      message.blocks.set(Number(event.index), { id: String(block.id), name: block.name as string, json: "" });
    } else if (event.type === "content_block_delta") {
      const delta = (event.delta || {}) as { type?: unknown; text?: unknown; partial_json?: unknown };
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        // raw stays the native text for the result check; the caller sees one message, so text
        // that resumes after a tool call or thinking block is set off as its own paragraph.
        this.raw += delta.text;
        if (this.raw.length > maxText) throw new ProviderError("output_too_large", "Provider output exceeds 8 MiB");
        step.events.push({ type: "text", text: this.split ? `\n\n${delta.text}` : delta.text }); this.split = false;
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const block = message?.blocks.get(Number(event.index));
        if (block) { block.json += delta.partial_json; if (block.json.length > maxText) throw new ProviderError("output_too_large", "Provider output exceeds 8 MiB"); }
      } else if (this.summaryVisible) {
        const reasoning = nativeClaudeReasoning(event as Parameters<typeof nativeClaudeReasoning>[0]);
        if (reasoning) step.events.push(reasoning);
      }
    } else if (event.type === "message_delta" && message) {
      message.tokens = tokensOf(event.usage, message.base); this.last = message.tokens;
      const stop = (event.delta as { stop_reason?: unknown } | undefined)?.stop_reason;
      if (typeof stop === "string") message.stop = stop;
      // Another stop (max_tokens) still makes the CLI run the complete calls on the gateway MCP server and wait forever.
      if (message.stop !== undefined && message.blocks.size) { message.ending = message.stop === "tool_use" ? "all" : "complete"; this.finish(message, step, message.ending); }
      else if (this.endTurn && message.stop === "end_turn" && !message.ended) { message.ended = true; step.end = { kind: "end_turn", usage: claudeUsage(message.tokens), tokens: message.tokens }; }
    } else if (event.type === "message_stop" && message && message.blocks.size) {
      this.finish(message, step, message.stop === undefined || message.stop === "tool_use" ? "final" : "complete");
    }
  }

  private assistant(native: unknown, step: ClaudeStreamStep): void {
    const value = (native && typeof native === "object" ? native : {}) as { content?: unknown; usage?: unknown };
    const uses = (Array.isArray(value.content) ? value.content : []).filter(block => block && typeof block === "object" && (block as { type?: unknown }).type === "tool_use") as Array<{ id?: unknown; name?: unknown; input?: unknown }>;
    if (!uses.length) return;
    const message = this.message; const orphans: typeof uses = [];
    for (const use of uses) {
      const block = message && !message.ended ? [...message.blocks.values()].find(block => block.id === use.id) : undefined;
      if (block) block.input = use.input;
      else if (message && !message.ended) {
        if (typeof use.name !== "string" || !this.bindings.get(use.name)) nativeClaudeCalls([use as { id?: string; name?: string; input?: unknown }], this.tools);
        message.blocks.set(Math.max(-1, ...message.blocks.keys()) + 1, { id: String(use.id), name: use.name as string, json: "", input: use.input });
      } else orphans.push(use);
    }
    if (message?.ending && !message.ended) this.finish(message, step, message.ending);
    // Without partial messages a complete assistant line is all there is, so it ends the request itself.
    if (orphans.length && !step.end) {
      const tokens = tokensOf(value.usage);
      step.end = { kind: "tool_use", calls: nativeClaudeCalls(orphans as Array<{ id?: string; name?: string; input?: unknown }>, this.tools), usage: claudeUsage(tokens), tokens };
    }
  }

  /**
   * "all" waits until every call has its `assistant` line; "final" takes every call, parsing streamed
   * input where the line is missing; "complete" takes only the calls with an `assistant` line, which
   * are the ones the CLI itself runs, and without one leaves the CLI to continue (max_tokens recovery).
   */
  private finish(message: Message, step: ClaudeStreamStep, mode: "all" | "final" | "complete"): void {
    if (message.ended) return;
    let blocks = [...message.blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
    if (mode === "all" && blocks.some(block => block.input === undefined)) return;
    if (mode === "complete" && !(blocks = blocks.filter(block => block.input !== undefined)).length) return;
    const parse = (json: string) => { try { return json.trim() ? JSON.parse(json) as unknown : {}; } catch { return undefined; } };
    message.ended = true;
    const calls = nativeClaudeCalls(blocks.map(block => ({ id: block.id, name: block.name, input: block.input === undefined ? parse(block.json) : block.input })), this.tools);
    const tokens = message.tokens || message.base;
    step.end = { kind: "tool_use", calls, usage: claudeUsage(tokens), tokens };
  }

  private result(result: Record<string, unknown>, step: ClaudeStreamStep): void {
    const windows = resultWindows(result); if (windows.length) step.contextWindows = windows;
    if (result.is_error || result.subtype !== "success") throw claudeResultFailure(result, this.limit);
    const text = typeof result.result === "string" ? result.result : this.raw;
    if (!text.startsWith(this.raw)) throw new ProviderError("inconsistent_stream", "Claude final text differs from streamed text");
    if (text.length > this.raw.length) { step.events.push({ type: "text", text: text.slice(this.raw.length) }); this.raw = text; }
    // The last API message is this request's cost; result.usage sums every message of the turn.
    const tokens = this.last || tokensOf(result.usage);
    step.end = { kind: "result", result, usage: claudeUsage(tokens), tokens };
  }
}
