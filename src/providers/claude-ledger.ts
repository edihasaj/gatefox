import { createHash } from "node:crypto";
import { agentMessageInput } from "../protocol/request.js";
import type { OpenAITool, OpenAIToolCall, ResponsesRequest } from "../protocol/types.js";
import { claudeToolBindings } from "./claude-tool-names.js";

/**
 * The history a live CLI session holds, as digests of canonical items. Canonical
 * items come from the restored Responses input and skip what the CLI's native
 * history keeps in another form: typed reasoning items and additional_tools.
 * Every entry also records the translated conversation messages
 * it renders as, so the ledger and the renderer share one item space.
 */
export interface LedgerEntry {
  digest: string;
  kind: "m" | "c" | "o";
  /** A merged assistant run; it enters native history only as the CLI's own output. */
  assistant?: true;
  callId?: string;
  /** Conversation messages this entry renders as: `count` messages from index `first`. */
  first: number;
  count: number;
  /** An output entry's source item, for relay delivery. */
  item?: Record<string, unknown>;
}
export interface LedgerState {
  items: string[];
  /** An interrupted turn's partial assistant run; the next history may include or omit it. */
  partial?: string;
}
export type LedgerPhase = "awaiting_outputs" | "turn_done";
export type LedgerDecision =
  | { kind: "continue_outputs"; outputs: LedgerEntry[] }
  | { kind: "continue_user"; from: number; items: number }
  | { kind: "reseed"; reason: "prefix_diverged" | "unexpected_tail"; divergedAt: number };

type Part = ["t", string] | ["i", string];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function parts(content: unknown): Part[] {
  if (typeof content === "string") return [["t", content]];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): Part[] => {
    const value = (part && typeof part === "object" ? part : {}) as { type?: unknown; text?: unknown; image_url?: unknown };
    if (value.type === "input_image") return [["i", sha(String(value.image_url))]];
    return typeof value.text === "string" ? [["t", value.text]] : [];
  });
}
const text = (list: Part[]) => list.map(([kind, value]) => kind === "t" ? value : "").join("");

/** How many translated conversation messages an input item becomes (request.ts responsesInputToMessages). */
function messageCount(item: Record<string, unknown>): number {
  // Tool declarations and search items never become conversation text (responsesInputToMessages skips them).
  if (["additional_tools", "web_search_call", "tool_search_call", "tool_search_output"].includes(String(item.type))) return 0;
  if (item.type === "reasoning") return Array.isArray(item.summary) && item.summary.map(part => (part as { text?: unknown }).text).join("\n") ? 1 : 0;
  if (item.type === "agent_message") { try { return agentMessageInput(item) ? 1 : 0; } catch { return 0; } }
  return 1;
}

/** A call's raw input: custom tools carry their free-form input, functions their argument string. */
export function callInput(call: OpenAIToolCall): string {
  if (call.responseTool?.type !== "custom") return call.function.arguments;
  try { const input = (JSON.parse(call.function.arguments) as { input?: unknown }).input; if (typeof input === "string") return input; } catch { /* Keep the exact arguments. */ }
  return call.function.arguments;
}
const callDigest = (id: string, name: string, input: unknown) => digest(["c", id, name, input]);
const runDigest = (value: string) => digest(["m", "assistant", [["t", value]]]);

/**
 * Canonical entries of a restored request, plus the number of conversation messages it translates to.
 * The first `leading` translated messages are the CLI's system prompt (the fingerprint covers them), so
 * their items have no entry and indices count from the first message after them.
 */
export function ledgerEntries(request: ResponsesRequest, tools: OpenAITool[], leading = 0): { entries: LedgerEntry[]; messages: number } {
  const bindings = claudeToolBindings(tools);
  const input = (typeof request.input === "string" ? [{ type: "message", role: "user", content: request.input }] : request.input) as Array<Record<string, unknown>>;
  let index = (typeof request.instructions === "string" && request.instructions ? 1 : 0) - leading;
  const entries: LedgerEntry[] = []; let run: { value: string; first: number; count: number } | undefined;
  const close = () => { if (run) entries.push({ digest: runDigest(run.value), kind: "m", assistant: true, first: run.first, count: run.count }); run = undefined; };
  for (const item of input) {
    const count = messageCount(item); const first = index; index += count;
    const type = item.type ?? "message";
    if (type === "reasoning" || type === "additional_tools" || count === 0 || first < 0) continue;
    if (type === "message" && item.role === "assistant") {
      // Consecutive assistant text merges into one run, the way the CLI streamed it.
      if (run) { run.value += text(parts(item.content)); run.count += count; } else run = { value: text(parts(item.content)), first, count };
      continue;
    }
    close();
    if (type === "function_call" || type === "custom_tool_call") {
      const named = typeof item.namespace === "string" ? `${item.namespace}.${item.name}` : String(item.name);
      const name = bindings.get(named)?.function.name ?? named;
      entries.push({ digest: callDigest(String(item.call_id), name, type === "custom_tool_call" ? item.input : item.arguments), kind: "c", callId: String(item.call_id), first, count });
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      entries.push({ digest: digest(["o", String(item.call_id), parts(item.output)]), kind: "o", callId: String(item.call_id), first, count, item });
    } else if (type === "agent_message") {
      const message = agentMessageInput(item)!;
      entries.push({ digest: digest(["m", "user", parts(message.content)]), kind: "m", first, count });
    } else entries.push({ digest: digest(["m", String(item.role), parts(item.content)]), kind: "m", first, count });
  }
  close();
  return { entries, messages: index };
}

/** What Codex replays for one request's output: the streamed text as one assistant run, then the calls in emission order. */
export function echoDigests(streamed: string, calls: OpenAIToolCall[]): string[] {
  return [...(streamed ? [runDigest(streamed)] : []), ...calls.map(call => callDigest(call.id, call.function.name, callInput(call)))];
}
/** The ledger item for an interrupted turn's partial text, if any. */
export function partialDigest(streamed: string): string | undefined { return streamed ? runDigest(streamed) : undefined; }

/**
 * Whether a session can continue with this history. The ledger must be an exact
 * prefix. Waiting on tool outputs, the tail must be exactly one output per pending
 * call, in any order. After a finished turn, it must be one or more messages whose
 * conversation messages are exactly the rest of the conversation, with no assistant text.
 */
export function decide(ledger: LedgerState, entries: LedgerEntry[], messages: number, phase: LedgerPhase, pending: readonly string[]): LedgerDecision {
  const diverged = ledger.items.findIndex((item, index) => entries[index]?.digest !== item);
  if (diverged >= 0) return { kind: "reseed", reason: "prefix_diverged", divergedAt: diverged };
  let length = ledger.items.length;
  if (ledger.partial !== undefined && entries[length]?.digest === ledger.partial) length++;
  const tail = entries.slice(length);
  const unexpected = { kind: "reseed", reason: "unexpected_tail", divergedAt: length } as const;
  if (phase === "awaiting_outputs") {
    const waiting = new Set(pending);
    return waiting.size && tail.length === waiting.size && tail.every(entry => entry.kind === "o" && waiting.delete(entry.callId!)) ? { kind: "continue_outputs", outputs: tail } : unexpected;
  }
  // Assistant text inside a user message would misattribute it; only the CLI writes assistant turns.
  if (!tail.length || tail.some(entry => entry.kind !== "m" || entry.assistant)) return unexpected;
  // A skipped item inside the tail would render without a ledger entry; that history is not a plain continuation.
  const from = tail[0].first;
  return tail.reduce((sum, entry) => sum + entry.count, 0) === messages - from ? { kind: "continue_user", from, items: tail.length } : unexpected;
}

/** An exact pending-output batch followed by new caller messages requires a full-history seed. */
export function messagesAfterTools(entries: LedgerEntry[], from: number, pending: readonly string[]): boolean {
  const waiting = new Set(pending);
  const tail = entries.slice(from), outputs = tail.slice(0, waiting.size), messages = tail.slice(waiting.size);
  return waiting.size > 0 && waiting.size === pending.length && outputs.length === waiting.size && messages.length > 0
    && outputs.every(entry => entry.kind === "o" && waiting.delete(entry.callId!))
    && messages.every(entry => entry.kind === "m" && !entry.assistant);
}

/** Complete tool outputs followed only by fully ledgered caller messages. */
export function queuedToolContinuation(entries: LedgerEntry[], from: number, pending: readonly string[], messages: number): { outputs: LedgerEntry[]; from: number } | undefined {
  if (!messagesAfterTools(entries, from, pending)) return;
  const tail = entries.slice(from + pending.length), first = tail[0].first;
  if (tail.reduce((count, entry) => count + entry.count, 0) !== messages - first) return;
  return { outputs: entries.slice(from, from + pending.length), from: first };
}
