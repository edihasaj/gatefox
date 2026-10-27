import type { InferenceEvent, OpenAITool, OpenAIToolCall, Usage } from "../protocol/types.js";
import { ProviderError } from "./provider.js";
import { nativeClaudeCalls, nativeClaudeReasoning } from "./claude-calls.js";

/** Token counts from the CLI. Grok reports input_tokens including cache reads. */
export interface GrokTokens { input: number; cacheRead?: number; output: number }
export type GrokStreamEnd = { kind: "tool_use"; calls: OpenAIToolCall[] } | { kind: "end_turn" } | { kind: "result" };
export interface GrokStep { events: InferenceEvent[]; end?: GrokStreamEnd; /** A use_tool call is complete; the request may end once the CLI goes quiet. */ ready?: boolean }

/** Grok's only route to MCP tools. search_tool answers locally from the catalog; use_tool is the caller's call. */
const metaTools = new Set(["search_tool", "use_tool"]);
const gatewayPrefix = "gateway__";
const maxText = 8 * 1024 * 1024;
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const refuse = (code: string) => new ProviderError("invalid_tool_call", "Grok tried to use a tool the gateway does not offer", 502, { code, event: "grok.tool_use" });

export const grokUsage = (tokens: GrokTokens): Usage => ({ input_tokens: tokens.input, output_tokens: tokens.output, total_tokens: tokens.input + tokens.output,
  ...(tokens.cacheRead === undefined ? {} : { input_tokens_details: { cached_tokens: tokens.cacheRead } }) });

const codes = new Set(["rate_limit", "authentication_failed", "billing_error", "server_error", "overloaded", "invalid_request", "max_output_tokens", "unknown"]);
/** Maps only native error discriminants. Provider prose is never forwarded. */
export function grokFailure(message: Record<string, unknown>, event: "grok.assistant" | "grok.result"): ProviderError {
  const raw = message.type === "assistant" ? message.error : message.error_code ?? message.error;
  const code = typeof raw === "string" && codes.has(raw) ? raw : "unknown";
  const upstream = { code, event };
  if (code === "authentication_failed") return new ProviderError("authentication", "Grok could not authenticate this request. If it persists, run `grok login --device-auth` for the gateway's Grok home.", 401, upstream);
  if (code === "rate_limit") return new ProviderError("rate_limit_exceeded", "Grok is limiting requests or the Grok allowance is used up; retry later.", 429, upstream);
  if (code === "billing_error") return new ProviderError("insufficient_quota", "The Grok subscription allowance or billing is unavailable. Check your Grok plan, then retry.", 429, upstream);
  if (code === "server_error" || code === "overloaded") return new ProviderError("upstream_unavailable", "Grok is temporarily unavailable; retry shortly", 503, upstream);
  return new ProviderError("inference_failed", "Grok inference did not complete", 502, upstream);
}

/**
 * Reads the CLI's streaming-messages-json lines for one request. The CLI calls the gateway MCP
 * server as soon as a use_tool block is complete, before it prints the whole assistant frame, so
 * calls come from the streamed tool input. Anything other than text, thinking, search_tool and a
 * use_tool naming a gateway tool fails the request so the caller can stop the CLI at once.
 */
export class GrokMessageStream {
  readonly tokens: GrokTokens = { input: 0, output: 0 };
  costUsd?: number;
  readonly contextWindows: Array<{ model: string; contextWindow: number }> = [];
  private readonly blocks = new Map<number, { id: string; name: string; json: string }>();
  private readonly calls: Array<{ id: string; name: string; input: unknown }> = [];
  private readonly seen = new Set<string>();
  private raw = ""; private split = false;
  constructor(private readonly tools: OpenAITool[], private readonly summaryVisible: boolean) {}

  get toolCalls(): number { return this.calls.length; }

  accept(message: Record<string, unknown>): GrokStep {
    const step: GrokStep = { events: [] };
    if (message.type === "system") this.init(message);
    else if (message.type === "assistant") this.assistant(message);
    else if (message.type === "stream_event") this.event(object(message.event), step);
    else if (message.type === "result") this.result(message, step);
    return step;
  }

  /** The complete calls collected so far, if any. */
  finish(): GrokStreamEnd | undefined {
    return this.calls.length ? { kind: "tool_use", calls: nativeClaudeCalls(this.calls, this.tools) } : undefined;
  }

  private init(message: Record<string, unknown>): void {
    if (message.subtype !== "init") return;
    // The init list names the meta tools and the gateway catalog entries they reach; anything else is a native tool.
    if (Array.isArray(message.tools) && message.tools.some(name => typeof name !== "string" || !(metaTools.has(name) || name.startsWith(gatewayPrefix)))) throw refuse("native_builtin_tool");
    if (Array.isArray(message.mcp_servers) && message.mcp_servers.some(server => object(server).name !== "gateway")) throw refuse("unknown_tool");
  }

  private assistant(message: Record<string, unknown>): void {
    if (typeof message.error === "string") throw grokFailure(message, "grok.assistant");
    const content = object(message.message).content;
    for (const value of Array.isArray(content) ? content : []) {
      const block = object(value);
      if (!["text", "thinking", "redacted_thinking", "tool_use"].includes(String(block.type))) throw refuse("native_builtin_tool");
      if (block.type !== "tool_use") continue;
      if (typeof block.name !== "string" || !metaTools.has(block.name)) throw refuse("native_builtin_tool");
      if (block.name === "use_tool" && typeof block.id === "string" && !this.seen.has(block.id)) this.take(block.id, block.input);
    }
  }

  private take(id: string, input: unknown): void {
    this.seen.add(id);
    const value = object(input);
    const name = value.tool_name;
    if (typeof name !== "string" || !name.startsWith(gatewayPrefix)) throw refuse("unknown_tool");
    const call = { id, name: name.slice(gatewayPrefix.length), input: value.tool_input ?? {} };
    nativeClaudeCalls([call], this.tools);
    this.calls.push(call);
  }

  private usage(value: unknown): void {
    const usage = object(value);
    this.tokens.input = count(usage.input_tokens) ?? this.tokens.input;
    this.tokens.cacheRead = count(usage.cache_read_input_tokens) ?? this.tokens.cacheRead;
    this.tokens.output = count(usage.output_tokens) ?? this.tokens.output;
  }

  private event(event: Record<string, unknown>, step: GrokStep): void {
    const index = Number(event.index);
    if (event.type === "message_start") { this.usage(object(event.message).usage); this.blocks.clear(); }
    else if (event.type === "content_block_start") {
      const block = object(event.content_block);
      if (block.type === "tool_use") {
        if (typeof block.name !== "string" || !metaTools.has(block.name)) throw refuse("native_builtin_tool");
        this.blocks.set(index, { id: String(block.id), name: block.name, json: "" });
      } else if (block.type !== "text" && block.type !== "thinking" && block.type !== "redacted_thinking") throw refuse("native_builtin_tool");
      if (block.type !== "text" && this.raw) this.split = true;
    } else if (event.type === "content_block_delta") {
      const delta = object(event.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        this.raw += delta.text;
        if (this.raw.length > maxText) throw new ProviderError("output_too_large", "Provider output exceeds 8 MiB");
        step.events.push({ type: "text", text: this.split ? `\n\n${delta.text}` : delta.text }); this.split = false;
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const block = this.blocks.get(index);
        if (block) { block.json += delta.partial_json; if (block.json.length > maxText) throw new ProviderError("output_too_large", "Provider output exceeds 8 MiB"); }
      } else if (this.summaryVisible) {
        const reasoning = nativeClaudeReasoning(event as Parameters<typeof nativeClaudeReasoning>[0]);
        if (reasoning) step.events.push(reasoning);
      }
    } else if (event.type === "content_block_stop") {
      const block = this.blocks.get(index); this.blocks.delete(index);
      if (block?.name === "use_tool" && !this.seen.has(block.id)) {
        let input: unknown;
        try { input = block.json.trim() ? JSON.parse(block.json) : {}; } catch { throw refuse("malformed_tool_call"); }
        this.take(block.id, input); step.ready = true;
      }
    } else if (event.type === "message_delta") {
      this.usage(event.usage);
      const stop = object(event.delta).stop_reason;
      if (this.calls.length) step.end = this.finish();
      else if (stop === "end_turn") step.end = { kind: "end_turn" };
    }
  }

  private result(result: Record<string, unknown>, step: GrokStep): void {
    if (result.is_error === true || result.subtype !== "success") throw grokFailure(result, "grok.result");
    this.usage(result.usage);
    this.costUsd = count(result.total_cost_usd);
    for (const [model, value] of Object.entries(object(result.modelUsage))) {
      const window = object(value).contextWindow;
      if (typeof window === "number") this.contextWindows.push({ model, contextWindow: window });
    }
    const text = typeof result.result === "string" ? result.result : this.raw;
    if (text.startsWith(this.raw) && text.length > this.raw.length) { step.events.push({ type: "text", text: text.slice(this.raw.length) }); this.raw = text; }
    step.end = this.finish() ?? { kind: "result" };
  }
}
