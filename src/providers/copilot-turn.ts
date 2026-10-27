import type { ChatToolSelection, InferenceEvent, OpenAITool, OpenAIToolCall, Usage, UsageAccounting } from "../protocol/types.js";
import { nativeCatalog } from "./copilot-render.js";
import { record } from "./copilot-rpc.js";
import { copilotContextFailure } from "./context-errors.js";
import { ProviderError } from "./provider.js";

type Message = Record<string, unknown>;
const invalidCall = (code: string, message: string) => new ProviderError("invalid_tool_call", message, 502, { code, event: "copilot.tool_use" });

/** The caller's tools by the names the CLI sees (copilot-render.ts nativeCatalog). */
export const nativeToolMap = (tools: OpenAITool[]): Map<string, OpenAITool> => new Map(nativeCatalog(tools).map(({ name, tool }) => [name, tool]));

export function nativeCopilotCalls(value: unknown, tools: OpenAITool[] | Map<string, OpenAITool>): OpenAIToolCall[] {
  if (!Array.isArray(value)) throw invalidCall("malformed_tool_call", "Copilot returned invalid tool requests");
  const names = tools instanceof Map ? tools : nativeToolMap(tools);
  const ids = new Set<string>();
  return value.map(raw => {
    const call = record(raw);
    const definition = typeof call.name === "string" ? names.get(call.name)?.function : undefined;
    if (!definition) throw invalidCall("unknown_tool", "Copilot returned an unknown tool call");
    if (typeof call.toolCallId === "string" && ids.has(call.toolCallId)) throw invalidCall("duplicate_tool_id", "Copilot returned a duplicate tool call ID");
    if (call.type !== "function" || typeof call.toolCallId !== "string" || !call.toolCallId) throw invalidCall("malformed_tool_call", "Copilot returned a malformed tool call");
    if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) throw invalidCall("invalid_tool_arguments", "Copilot returned invalid tool argument structure");
    ids.add(call.toolCallId);
    if (definition.responseTool?.type === "custom" && typeof record(call.arguments).input !== "string") throw invalidCall("nontext_custom_input", "Free-form input must be a string");
    return { id: call.toolCallId, type: "function", responseTool: definition.responseTool, function: { name: definition.name, arguments: JSON.stringify(call.arguments) } };
  });
}

const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const reportedCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export interface CopilotTurnOptions {
  /** The model the caller asked for; Copilot must answer with exactly it. */
  model: string;
  /** The upstream model ids this provider offers, for naming an unexpected one. */
  offered: string[];
  tools: OpenAITool[];
  choice: ChatToolSelection | undefined;
  /** The caller's reasoning summary preference; "none" hides reasoning deltas. */
  summary: unknown;
}

export interface CopilotStep {
  events: InferenceEvent[];
  /** `tools`: the model asked for caller tools (see `calls`). `idle`: the answer is complete. */
  end?: "tools" | "idle";
}

/**
 * One gateway request's view of a Copilot session. It validates the route (subscription,
 * model, no sub-agents, no native tools), sums every model call's usage, and turns session
 * events into inference events. The one-shot and live paths share it, so both enforce the
 * same rules and report the same billing detail.
 */
export class CopilotTurn {
  /** The text this request streamed. Codex replays it, so a live session's ledger records it. */
  text = "";
  calls: OpenAIToolCall[] = [];
  private final = false; private verified = false;
  private readonly names: Map<string, OpenAITool>;
  /** Who started the request's first model call, `user` or `agent`; `mixed` once the calls disagree. */
  private initiator?: "user" | "agent" | "mixed";
  // One gateway request can contain several model calls; their counts add up.
  private readonly totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheReadSamples: 0, cacheWriteSamples: 0, reasoning: 0, nanoAiu: 0, priced: 0, partial: false, calls: 0 };
  private usage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  private accounting: UsageAccounting = {};
  constructor(private readonly options: CopilotTurnOptions) { this.names = nativeToolMap(options.tools); }

  /** The model's answer is complete and wants no tool; only the session's idle event is still due. */
  get answered(): boolean { return this.final && this.calls.length === 0; }

  /** Throws a ProviderError for any event that must fail the request. */
  accept(event: Message): CopilotStep {
    const data = record(event.data); const { options } = this; const events: InferenceEvent[] = [];
    if (event.agentId) throw new ProviderError("invalid_stream", "Copilot emitted an unexpected sub-agent event");
    if (event.type === "permission.requested" || event.type === "external_tool.requested") throw invalidCall("native_builtin_tool", "Copilot requested execution beyond caller-dispatched inference");
    if (event.type === "session.error") {
      const context = copilotContextFailure(data); if (context) throw context;
      const diagnostic = typeof data.message === "string" ? data.message : "";
      if (/unsupported value|invalid value|not supported with|model.+not available/i.test(diagnostic)) throw new ProviderError("invalid_request", "Copilot rejected the requested model or reasoning option", 400);
      // Usage-limit and quota wording is final for Codex; a plain rate limit clears by itself, so Codex may retry it.
      if (/usage.?limit|quota/i.test(diagnostic)) throw new ProviderError("usage_limit", "Copilot subscription usage limit reached", 429);
      if (/rate.?limit/i.test(diagnostic)) throw new ProviderError("rate_limit_exceeded", "Copilot is temporarily limiting requests; retry shortly", 429);
      throw new ProviderError("inference_failed", "Copilot inference did not complete; check its subscription and model access");
    }
    if (event.type === "assistant.message_delta" && typeof data.deltaContent === "string") {
      this.text += data.deltaContent; if (Buffer.byteLength(this.text) > 8 * 1024 * 1024) throw new ProviderError("output_too_large", "Copilot output exceeds 8 MiB");
      events.push({ type: "text", text: data.deltaContent });
    }
    if (event.type === "assistant.reasoning_delta" && typeof data.deltaContent === "string" && options.summary !== "none") events.push({ type: "reasoning", text: data.deltaContent, ...(typeof data.reasoningId === "string" ? { id: data.reasoningId } : {}) });
    if (event.type === "assistant.usage") events.push(this.addUsage(data));
    if (event.type === "assistant.message") {
      // Protocol 3 in CLI 1.0.91 omits this optional field. Its preceding
      // isByok:false usage and exact model still attest the subscription route.
      if (data.providerId !== undefined && data.providerId !== "copilot") throw new ProviderError("provider_route", "Copilot changed the requested subscription route");
      if (data.model !== options.model) {
        const actual = typeof data.model === "string" && options.offered.includes(data.model) ? data.model : "an unexpected model";
        throw new ProviderError("model_route", `Copilot returned ${actual} instead of the requested model`);
      }
      if (!this.verified) throw new ProviderError("subscription_unverified", "Copilot did not verify subscription inference");
      const content = typeof data.content === "string" ? data.content : "";
      if (!content.startsWith(this.text)) throw new ProviderError("inconsistent_stream", "Copilot final text differs from streamed text");
      if (content.length > this.text.length) { events.push({ type: "text", text: content.slice(this.text.length) }); this.text = content; }
      this.final = true;
      if (Array.isArray(data.toolRequests) && data.toolRequests.length) {
        // The catalog is always whole, so the choice is enforced here: a model that ignores it fails the request.
        if (options.choice === "none") throw invalidCall("tool_choice_none", "Copilot returned a tool call although tool calls were disabled");
        this.calls = nativeCopilotCalls(data.toolRequests, this.names);
        const chosen = typeof options.choice === "object" ? options.choice.function.name : undefined;
        if (chosen !== undefined && this.calls.some(call => call.function.name !== chosen)) throw invalidCall("forced_tool_mismatch", "Copilot returned a tool other than the required one");
        for (const call of this.calls) events.push({ type: "tool", call });
        return { events, end: "tools" };
      }
      if (options.choice === "required" || typeof options.choice === "object") throw invalidCall("required_tool_missing", "Copilot did not return the required tool call");
    }
    if (event.type === "assistant.idle") {
      if (!this.final) throw new ProviderError("incomplete", "Copilot became idle without a final response");
      return { events, end: "idle" };
    }
    return { events };
  }

  /** The request's closing event: usage and billing summed over its model calls. */
  done(): InferenceEvent { return { type: "done", usage: this.usage, accounting: this.accounting }; }

  private addUsage(data: Message): InferenceEvent {
    if (data.isByok === true) throw new ProviderError("account_route", "Copilot attempted BYOK inference");
    if (data.isByok !== false && data.provider !== "copilot") throw new ProviderError("subscription_unverified", "Copilot did not verify subscription inference");
    this.verified = true;
    const { totals } = this; const nanoAiu = record(data.copilotUsage).totalNanoAiu;
    totals.input += count(data.inputTokens); totals.output += count(data.outputTokens); totals.cacheRead += count(data.cacheReadTokens);
    totals.cacheWrite += count(data.cacheWriteTokens); totals.reasoning += count(data.reasoningTokens); totals.calls++;
    if (reportedCount(data.cacheReadTokens) && reportedCount(data.inputTokens) && data.cacheReadTokens <= data.inputTokens) totals.cacheReadSamples++;
    if (reportedCount(data.cacheWriteTokens)) totals.cacheWriteSamples++;
    // `partial` means some amounts are missing from a call's figure, so the sum is a floor.
    if (data.aiCreditsStatus === "partial") totals.partial = true;
    if (typeof nanoAiu === "number" && Number.isFinite(nanoAiu) && nanoAiu >= 0 && data.aiCreditsStatus !== "unavailable") { totals.priced++; totals.nanoAiu += nanoAiu; }
    this.usage = { input_tokens: totals.input, output_tokens: totals.output, total_tokens: totals.input + totals.output,
      ...(totals.cacheReadSamples === totals.calls ? { input_tokens_details: { cached_tokens: totals.cacheRead } } : {}) };
    if (data.initiator === "user" || data.initiator === "agent") this.initiator = !this.initiator || this.initiator === data.initiator ? data.initiator : "mixed";
    this.accounting = { ...(totals.cacheWriteSamples === totals.calls ? { cacheWriteTokens: totals.cacheWrite } : {}), reasoningTokens: totals.reasoning, ...(totals.priced ? { nanoAiu: totals.nanoAiu } : {}), ...(this.initiator ? { initiator: this.initiator } : {}),
      nanoAiuStatus: !totals.priced ? "unavailable" : totals.priced === totals.calls && !totals.partial ? "complete" : "partial" };
    // The server records this before any later check can reject the call, so spend is never lost.
    return { type: "usage", usage: this.usage, accounting: this.accounting };
  }
}
