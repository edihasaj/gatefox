import { ProviderError } from "./provider.js";
import type { AssistantMessagePhase, InferenceEvent } from "../protocol/types.js";
import { randomUUID } from "node:crypto";

type Item = Record<string, unknown>;
type Message = { emissionId: string; phase?: AssistantMessagePhase; parts: Map<number, string>; closed: boolean; providerDone: boolean; emittedDone: boolean; lastEmittedIndex: number };
const object = (value: unknown): Item => value && typeof value === "object" && !Array.isArray(value) ? value as Item : {};
const invalid = () => new ProviderError("invalid_output", "Provider returned invalid assistant output");
function identity(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\0")) throw invalid();
  return value;
}
function phase(value: unknown): AssistantMessagePhase | undefined {
  if (value === undefined) return;
  if (value !== "commentary" && value !== "partial_answer" && value !== "final_answer") throw invalid();
  return value;
}

/** Retain actual message boundaries and append only provider-confirmed missing text. */
export class ResponsesOutput {
  private readonly messages = new Map<string, Message>();
  private readonly unbound: Message[] = [];
  private anonymous?: Message;
  private textBytes = 0;
  private messageCount = 0;
  get hasText(): boolean { return this.textBytes > 0; }
  private create(emissionId: string): Message {
    if (++this.messageCount > 256) throw invalid();
    return { emissionId, parts: new Map(), closed: false, providerDone: false, emittedDone: false, lastEmittedIndex: -1 };
  }
  private message(id: string | undefined, terminal?: Item): Message {
    if (id === undefined) {
      const open = [...new Set(this.messages.values())].filter(message => !message.closed);
      if (this.anonymous && !open.includes(this.anonymous) && !this.anonymous.closed) open.push(this.anonymous);
      if (open.length > 1) throw new ProviderError("inconsistent_stream", "Provider omitted an ambiguous assistant message identity");
      if (open[0]) return open[0];
      if (!this.anonymous || this.anonymous.closed) { this.anonymous = this.create(`anonymous_${randomUUID()}`); this.unbound.push(this.anonymous); }
      return this.anonymous;
    }
    const existing = this.messages.get(id); if (existing) return existing;
    const assigned = new Set(this.messages.values());
    const candidates = this.unbound.filter(message => !assigned.has(message));
    const match = terminal && Array.isArray(terminal.content) ? candidates.find(message => [...message.parts].every(([index, text]) => {
      const part = object((terminal.content as unknown[])[index]); return part.type === "output_text" && typeof part.text === "string" && part.text.startsWith(text);
    })) : this.anonymous && !this.anonymous.closed && !assigned.has(this.anonymous) ? this.anonymous : undefined;
    if (terminal && candidates.length && !match) throw new ProviderError("inconsistent_stream", "Provider final text differs from unidentified streamed text");
    const selected = match || this.create(id);
    this.messages.set(id, selected); return selected;
  }
  private metadata(item: Item, terminal: boolean): Message {
    if (item.type !== "message" || item.role !== "assistant") throw invalid();
    if (item.status !== undefined && item.status !== "completed" && (terminal || item.status !== "in_progress")) throw invalid();
    const selected = this.message(identity(item.id), terminal ? item : undefined); const actual = phase(item.phase);
    if (actual !== undefined) {
      if (selected.phase !== undefined && selected.phase !== actual) throw new ProviderError("inconsistent_stream", "Provider changed its assistant message phase");
      selected.phase = actual;
    }
    return selected;
  }
  private text(message: Message, index: number, value: string, append: boolean): InferenceEvent[] {
    if (!Number.isSafeInteger(index) || index < 0 || index > 255) throw invalid();
    const previous = message.parts.get(index) || "";
    if (!append && !value.startsWith(previous)) throw new ProviderError("inconsistent_stream", "Provider final text differs from streamed text");
    const added = append ? value : value.slice(previous.length);
    if (!added) return [];
    if (message.closed) throw new ProviderError("inconsistent_stream", "Provider emitted text after its assistant message ended");
    if (index < message.lastEmittedIndex) throw new ProviderError("inconsistent_stream", "Provider reordered assistant content parts");
    this.textBytes += Buffer.byteLength(added); if (this.textBytes > 8 * 1024 * 1024) throw new ProviderError("output_too_large", "Provider output exceeds 8 MiB");
    message.parts.set(index, previous + added); message.lastEmittedIndex = index;
    return [{ type: "text", text: added, messageId: message.emissionId, ...(message.phase === undefined ? {} : { phase: message.phase }) }];
  }
  private boundary(message: Message): InferenceEvent[] {
    if (message.emittedDone) return [];
    message.emittedDone = true;
    return [{ type: "message-done", messageId: message.emissionId, ...(message.phase === undefined ? {} : { phase: message.phase }) }];
  }
  added(item: Item): void { this.metadata(item, false); }
  delta(event: Item): InferenceEvent[] {
    if (typeof event.delta !== "string") throw invalid();
    const index = event.content_index === undefined ? 0 : event.content_index;
    if (typeof index !== "number") throw invalid();
    return this.text(this.message(event.item_id === undefined ? undefined : identity(event.item_id)), index, event.delta, true);
  }
  done(item: Item, final = false): InferenceEvent[] {
    const selected = this.metadata(item, true); const events: InferenceEvent[] = [];
    if (selected.providerDone && !final) throw new ProviderError("inconsistent_stream", "Provider ended its assistant message twice");
    if (!Array.isArray(item.content) || item.content.length > 256) throw invalid();
    if ([...selected.parts.keys()].some(index => index >= (item.content as unknown[]).length)) throw new ProviderError("inconsistent_stream", "Provider omitted streamed assistant content");
    for (const [index, value] of item.content.entries()) {
      const part = object(value); if (part.type !== "output_text" || typeof part.text !== "string") throw invalid();
      events.push(...this.text(selected, index, part.text, false));
    }
    selected.closed = true; selected.providerDone = true;
    // Some providers supply phase only in the final response snapshot. Keep
    // that boundary open until then rather than publishing a misleading phase.
    if (final || selected.phase !== undefined) events.push(...this.boundary(selected));
    return events;
  }
  legacy(text: string): InferenceEvent[] { return this.text(this.message(undefined), 0, text, false); }
  toolBoundary(): void {
    // ID-less streams historically imply a boundary at a caller tool. Keep the
    // internal message for a later snapshot to supply its real identity/phase.
    if (this.anonymous && !new Set(this.messages.values()).has(this.anonymous)) { this.anonymous.closed = true; this.anonymous = undefined; }
  }
  finish(): InferenceEvent[] {
    const all = new Set([...this.messages.values(), ...this.unbound]);
    return [...all].flatMap(message => { message.closed = true; return this.boundary(message); });
  }
}
