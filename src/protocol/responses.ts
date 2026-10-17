import { randomUUID } from "node:crypto";
import { ResponsesTranslationError } from "./request.js";
import { publicServiceTier, type AssistantMessagePhase, type PublicServiceTier, type InferenceEvent, type OpenAIToolCall, type Usage, type WireEvent } from "./types.js";

type Item = Record<string, unknown> & { type: string; id: string };
const identifier = (kind: string) => `${kind}_${randomUUID().replaceAll("-", "")}`;
function outputCall(call: OpenAIToolCall): Item {
  const custom = call.responseTool?.type === "custom";
  const item: Item = {
    type: custom ? "custom_tool_call" : "function_call", id: `${custom ? "ctc" : "fc"}_${call.id}`,
    call_id: call.id, name: call.responseTool?.name || call.function.name, status: "completed",
  };
  if (call.responseTool?.namespace) item.namespace = call.responseTool.namespace;
  if (!custom) { item.arguments = call.function.arguments; return item; }
  let input: unknown;
  try { input = (JSON.parse(call.function.arguments) as { input?: unknown }).input; }
  catch { throw new ResponsesTranslationError("Provider returned invalid custom tool arguments", "invalid_provider_output"); }
  if (typeof input !== "string") throw new ResponsesTranslationError("Provider returned non-text custom tool input", "invalid_provider_output");
  item.input = input; return item;
}
export function responseToolItems(calls: OpenAIToolCall[]): Item[] { return calls.map(outputCall); }
function callFrames(item: Item, position: number): WireEvent[] {
  const custom = item.type === "custom_tool_call";
  return [
    { type: "response.output_item.added", output_index: position, item: { ...item, status: "in_progress" } },
    { type: custom ? "response.custom_tool_call_input.done" : "response.function_call_arguments.done",
      output_index: position, item_id: item.id, name: item.name, ...(custom ? { input: item.input } : { arguments: item.arguments }) },
    { type: "response.output_item.done", output_index: position, item },
  ];
}
export function responseToolFrames(calls: OpenAIToolCall[], offset: number): string[] {
  const frames: string[] = [];
  for (const call of calls) for (const frame of callFrames(outputCall(call), offset++)) frames.push(JSON.stringify(frame));
  return frames;
}

type Thought = { item: Item; position: number; parts: Map<number, string> };
type Message = { id: string; position: number; value: string; providerId?: string; phase?: AssistantMessagePhase; closed?: boolean };

/** A single response ledger drives both streamed events and the final JSON body. */
export class ResponsesWriter {
  private readonly responseId: string;
  private readonly created = Math.floor(Date.now() / 1000);
  private readonly ledger: Item[] = [];
  private readonly thoughts = new Map<string, Thought>();
  private message?: Message;
  private readonly messages = new Map<string, Message>();
  private readonly providerMessages = new Map<string, Message>();
  private serial = 0;
  private status: "in_progress" | "completed" | "incomplete" | "failed" = "in_progress";
  private answer = "";
  private tokens: Usage = { total_tokens: 0, input_tokens: 0, output_tokens: 0 };
  private serviceTier?: PublicServiceTier;
  private endTurn?: boolean;
  constructor(private readonly model: string, private readonly emit: (event: WireEvent) => void, options: { id?: string } = {}) { this.responseId = options.id ?? identifier("resp"); }
  /** The inference has a real terminal event; the user turn may still continue. */
  get completed(): boolean { return this.status === "completed" || this.status === "incomplete"; }
  private publish(frame: WireEvent): void { this.emit({ ...frame, sequence_number: this.serial++ }); }
  private snapshot(status: string): Record<string, unknown> {
    return { object: "response", id: this.responseId, created_at: this.created, model: this.model,
      status, usage: { ...this.tokens }, output_text: this.answer, output: structuredClone(this.ledger),
      ...(this.serviceTier === undefined ? {} : { service_tier: this.serviceTier }),
      ...(this.status === "incomplete" ? { incomplete_details: { reason: "interrupted" } } : {}),
      ...(this.endTurn === undefined ? {} : { end_turn: this.endTurn }) };
  }
  begin(): void { this.publish({ type: "response.created", response: this.snapshot("in_progress") }); }
  progress(): void { if (this.status === "in_progress") this.publish({ type: "response.in_progress", response: this.snapshot("in_progress") }); }
  result(): Record<string, unknown> { return this.snapshot(this.status === "in_progress" ? "incomplete" : this.status); }
  private append(item: Item): number {
    const position = this.ledger.push(item) - 1;
    this.publish({ type: "response.output_item.added", output_index: position, item }); return position;
  }
  private closeMessage(message = this.message, status: "completed" | "incomplete" = "completed"): void {
    if (!message || message.closed) return;
    const part = { type: "output_text", text: message.value, annotations: [] };
    const item: Item = { type: "message", id: message.id, role: "assistant", status, content: [part],
      ...(message.phase === undefined ? {} : { phase: message.phase }) };
    const coordinates = { item_id: message.id, output_index: message.position, content_index: 0 };
    this.publish({ type: "response.output_text.done", ...coordinates, text: message.value });
    this.publish({ type: "response.content_part.done", ...coordinates, part });
    this.ledger[message.position] = item;
    this.publish({ type: "response.output_item.done", output_index: message.position, item }); message.closed = true;
    if (this.message === message) this.message = undefined;
  }
  private text(event: Extract<InferenceEvent, { type: "text" }>): void {
    const value = event.text;
    if (!value) return;
    let message = event.messageId === undefined ? this.message?.providerId === undefined ? this.message : undefined : this.providerMessages.get(event.messageId);
    if (message?.closed) throw new Error("Provider emitted text after its message ended");
    if (!message) {
      const id = identifier("msg");
      const position = this.append({ type: "message", id, role: "assistant", status: "in_progress", content: [],
        ...(event.phase === undefined ? {} : { phase: event.phase }) });
      message = { id, position, value: "", ...(event.messageId === undefined ? {} : { providerId: event.messageId }), ...(event.phase === undefined ? {} : { phase: event.phase }) };
      this.messages.set(id, message); if (event.messageId !== undefined) this.providerMessages.set(event.messageId, message);
      this.publish({ type: "response.content_part.added", item_id: id, output_index: position, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] } });
    }
    this.message = message; if (event.phase !== undefined) message.phase = event.phase;
    this.answer += value; message.value += value;
    this.publish({ type: "response.output_text.delta", item_id: message.id, output_index: message.position, content_index: 0, delta: value });
  }
  private thought(key: string): Thought {
    let state = this.thoughts.get(key);
    if (!state) {
      const item: Item = { type: "reasoning", id: key || identifier("rs"), summary: [] };
      state = { item, position: this.append(item), parts: new Map() }; this.thoughts.set(key, state);
    }
    return state;
  }
  private reason(event: Extract<InferenceEvent, { type: "reasoning" }>): void {
    const index = event.summaryIndex ?? 0;
    if (!Number.isInteger(index) || index < 0 || index > 255) throw new Error("Invalid reasoning summary index");
    const state = this.thought(event.id || ""); const coordinates = { item_id: state.item.id, output_index: state.position };
    for (let part = 0; part <= index; part++) if (!state.parts.has(part)) {
      state.parts.set(part, "");
      this.publish({ type: "response.reasoning_summary_part.added", ...coordinates, summary_index: part, part: { type: "summary_text", text: "" } });
    }
    state.parts.set(index, state.parts.get(index)! + event.text);
    this.publish({ type: "response.reasoning_summary_text.delta", ...coordinates, summary_index: index, delta: event.text,
      ...(event.estimatedTokens === undefined ? {} : { estimated_tokens: event.estimatedTokens }) });
  }
  private closeThoughts(): void {
    for (const state of this.thoughts.values()) {
      const parts = [...state.parts].sort(([a], [b]) => a - b);
      for (const [summary_index, text] of parts) {
        const coordinates = { item_id: state.item.id, output_index: state.position, summary_index };
        this.publish({ type: "response.reasoning_summary_text.done", ...coordinates, text });
        this.publish({ type: "response.reasoning_summary_part.done", ...coordinates, part: { type: "summary_text", text } });
      }
      if (parts.length) state.item = { ...state.item, summary: parts.map(([, text]) => ({ type: "summary_text", text })) };
      this.ledger[state.position] = state.item;
      this.publish({ type: "response.output_item.done", output_index: state.position, item: state.item });
    }
  }
  accept(event: InferenceEvent): void {
    if (this.status !== "in_progress") throw new Error("Provider emitted after the response ended");
    switch (event.type) {
      case "text": this.text(event); return;
      case "message-done": {
        const message = event.messageId === undefined ? this.message : this.providerMessages.get(event.messageId);
        if (message) { if (event.phase !== undefined) message.phase = event.phase; this.closeMessage(message, event.status); }
        return;
      }
      case "reasoning": this.reason(event); return;
      case "reasoning-state": {
        if (event.item.type !== "reasoning" || typeof event.item.id !== "string") throw new Error("Invalid reasoning state");
        const state = this.thought(event.item.id); state.item = { ...event.item } as Item;
        this.ledger[state.position] = state.item; return;
      }
      case "tool": {
        // Explicit provider messages close at their actual output-item boundary.
        // Legacy text-only providers close before their next caller tool.
        if (this.message?.providerId === undefined) this.closeMessage();
        const item = outputCall(event.call); const position = this.ledger.length;
        for (const frame of callFrames(item, position)) this.publish(frame); this.ledger.push(item); return;
      }
      case "native-item": {
        // Opaque to the gateway: a search item is relayed and kept in the ledger as received.
        if (this.message?.providerId === undefined) this.closeMessage();
        const item = structuredClone(event.item) as Item; const position = this.ledger.length;
        this.publish({ type: "response.output_item.added", output_index: position, item });
        this.publish({ type: "response.output_item.done", output_index: position, item }); this.ledger.push(item); return;
      }
      case "done": {
        if (event.interrupted && event.endTurn !== false) throw new Error("Interrupted inference cannot finish the user turn");
        for (const message of this.messages.values()) this.closeMessage(message, event.interrupted ? "incomplete" : "completed");
        this.closeThoughts(); this.tokens = event.usage;
        this.serviceTier = publicServiceTier(event.serviceTier); this.status = event.interrupted ? "incomplete" : "completed";
        this.endTurn = typeof event.endTurn === "boolean" ? event.endTurn : undefined;
        this.publish({ type: event.interrupted ? "response.incomplete" : "response.completed", response: this.snapshot(this.status) }); return;
      }
    }
  }
  fail(code: string, message: string): void {
    if (this.status !== "in_progress") return;
    this.status = "failed";
    this.publish({ type: "response.failed", response: { ...this.snapshot(this.status), error: { code, message } } });
  }
}
