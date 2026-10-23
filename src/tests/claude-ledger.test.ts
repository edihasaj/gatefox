import test from "node:test";
import assert from "node:assert/strict";
import { decide, echoDigests, ledgerEntries, partialDigest } from "../providers/claude-ledger.js";
import { normalizeResponsesTools, responsesToChatRequest } from "../protocol/request.js";
import { restoreReasoning } from "../protocol/reasoning-state.js";
import type { OpenAIToolCall, ResponsesInputItem, ResponsesRequest } from "../protocol/types.js";

const tools = normalizeResponsesTools([
  { type: "function", name: "read", description: "Reads", parameters: { type: "object", properties: {} } },
  { type: "custom", name: "patch", description: "Patches" },
  { type: "namespace", name: "files", tools: [{ type: "function", name: "list", description: "Lists" }] },
]);
const request = (input: ResponsesInputItem[], instructions?: string): ResponsesRequest => ({ model: "m", input, ...(instructions ? { instructions } : {}) });
const entries = (input: ResponsesInputItem[], instructions?: string) => ledgerEntries(request(input, instructions), tools);
const call = (id: string, name: string, args: string, responseTool?: OpenAIToolCall["responseTool"]): OpenAIToolCall => ({ type: "function", id, function: { name, arguments: args }, ...(responseTool ? { responseTool } : {}) });
const user = (text: string): ResponsesInputItem => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistant = (text: string): ResponsesInputItem => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

test("canonical entries ignore transport fields and match what Codex replays for each emitted item", () => {
  const replayed: ResponsesInputItem[] = [
    user("go"), assistant("Reading"),
    { type: "function_call", call_id: "c1", name: "read", arguments: "{\"a\":1}", id: "fc_c1", status: "completed" } as ResponsesInputItem,
    { type: "custom_tool_call", call_id: "c2", name: "patch", input: "*** raw" },
    { type: "function_call", call_id: "c3", name: "list", namespace: "files", arguments: "{}" },
  ];
  const emitted = [call("c1", "read", "{\"a\":1}"), call("c2", "patch", JSON.stringify({ input: "*** raw" }), { type: "custom", name: "patch" }), call("c3", "files.list", "{}", { type: "function", name: "list", namespace: "files" })];
  const { entries: list } = entries(replayed);
  assert.deepEqual(list.slice(1).map(entry => entry.digest), echoDigests("Reading", emitted));
  assert.deepEqual(list.map(entry => [entry.kind, entry.callId]), [["m", undefined], ["m", undefined], ["c", "c1"], ["c", "c2"], ["c", "c3"]]);
  // Content parts and string content of the same user text are the same canonical item.
  assert.equal(entries([{ type: "message", role: "user", content: "go" }]).entries[0].digest, list[0].digest);
});

test("consecutive assistant text merges into one run, across skipped reasoning, the way it streamed", () => {
  const split = entries([user("go"), assistant("Hel"), { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] }, assistant("lo")]);
  assert.equal(split.entries.length, 2);
  assert.equal(split.entries[1].digest, echoDigests("Hello", [])[0]);
  assert.deepEqual([split.entries[1].first, split.entries[1].count], [1, 2], "the run renders as its two messages; the summary is skipped");
  assert.equal(split.messages, 4);
});

test("typed restored reasoning summaries count as rendered history but are the only skipped ledger entries", () => {
  const replayed = restoreReasoning(request([user("go"), { type: "reasoning", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "plan" }] } as ResponsesInputItem, assistant("Done"), user("next")]), "scope", { preserveSummaries: true });
  const restored = (replayed.input as ResponsesInputItem[])[1];
  assert.deepEqual(restored, { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }] });
  const { entries: list, messages } = ledgerEntries(replayed, tools);
  assert.equal(messages, responsesToChatRequest(replayed, { reasoningSummaryMetadata: true }).messages.length);
  assert.deepEqual(list.map(entry => entry.first), [0, 2, 3], "entries keep their conversation positions around the skipped summary");
});

test("ordinary assistant strings are ledgered exactly like content arrays and edits reseed", () => {
  const stringAssistant = { type: "message", role: "assistant", content: "ordinary answer" } as ResponsesInputItem;
  const arrayAssistant = assistant("ordinary answer");
  const stringEntry = entries([user("go"), stringAssistant]).entries[1];
  const arrayEntry = entries([user("go"), arrayAssistant]).entries[1];
  assert.equal(stringEntry.digest, arrayEntry.digest);
  const ledger = { items: entries([user("go"), stringAssistant]).entries.map(entry => entry.digest) };
  const edited = entries([user("go"), { type: "message", role: "assistant", content: "edited answer" } as ResponsesInputItem]).entries;
  assert.deepEqual(decide(ledger, edited, 2, "turn_done", []), { kind: "reseed", reason: "prefix_diverged", divergedAt: 1 });
});

test("instructions, agent messages and additional tools count in the conversation the way the translator counts them", () => {
  const input: ResponsesInputItem[] = [
    { type: "additional_tools", tools: [] } as unknown as ResponsesInputItem,
    { type: "agent_message", author: "a", recipient: "b", content: "from a sub-agent" },
    { type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "x" }] },
    { type: "reasoning", encrypted_content: "opaque" },
    user("hi"),
  ];
  const { entries: list, messages } = entries(input, "Be brief");
  assert.equal(messages, responsesToChatRequest(request(input, "Be brief")).messages.length);
  assert.deepEqual(list.map(entry => entry.first), [1, 2]);
  assert.equal(list[0].digest, entries([user("from a sub-agent")]).entries[0].digest, "an agent message is the user text it translates to");
});

test("decide continues outputs, continues user turns and names each reseed", () => {
  const history = [user("go"), assistant("Calling"), { type: "function_call", call_id: "c1", name: "read", arguments: "{}" } as ResponsesInputItem, { type: "function_call", call_id: "c2", name: "read", arguments: "{}" } as ResponsesInputItem];
  const ledger = { items: [entries([user("go")]).entries[0].digest, ...echoDigests("Calling", [call("c1", "read", "{}"), call("c2", "read", "{}")])] };
  const output = (id: string) => ({ type: "function_call_output", call_id: id, output: id }) as ResponsesInputItem;
  const run = (input: ResponsesInputItem[], phase: "awaiting_outputs" | "turn_done", pending = ["c1", "c2"], state = ledger) => { const value = entries(input); return decide(state, value.entries, value.messages, phase, pending); };
  const outputs = run([...history, output("c2"), output("c1")], "awaiting_outputs");
  assert.equal(outputs.kind, "continue_outputs");
  assert.deepEqual(outputs.kind === "continue_outputs" && outputs.outputs.map(entry => entry.callId), ["c2", "c1"], "outputs may come in any order");
  assert.deepEqual(run([...history, output("c1")], "awaiting_outputs"), { kind: "reseed", reason: "unexpected_tail", divergedAt: 4 });
  assert.deepEqual(run([...history, output("c1"), output("c2"), user("also")], "awaiting_outputs"), { kind: "reseed", reason: "unexpected_tail", divergedAt: 4 });
  assert.deepEqual(run([user("edited"), ...history.slice(1), output("c1"), output("c2")], "awaiting_outputs"), { kind: "reseed", reason: "prefix_diverged", divergedAt: 0 });
  assert.deepEqual(run(history.slice(0, 3), "awaiting_outputs"), { kind: "reseed", reason: "prefix_diverged", divergedAt: 3 }, "a retry of an earlier history");
  const done = { items: [entries([user("go")]).entries[0].digest, ...echoDigests("Hi", [])] };
  assert.deepEqual(run([user("go"), assistant("Hi"), user("a"), { type: "message", role: "developer", content: "b" }], "turn_done", [], done), { kind: "continue_user", from: 2, items: 2 });
  assert.deepEqual(run([user("go"), assistant("Hi")], "turn_done", [], done), { kind: "reseed", reason: "unexpected_tail", divergedAt: 2 }, "nothing new to send");
  assert.deepEqual(run([user("go"), assistant("Hi"), output("x")], "turn_done", [], done), { kind: "reseed", reason: "unexpected_tail", divergedAt: 2 });
  const summary = { type: "reasoning", summary: [{ type: "summary_text", text: "restored summary" }] } as ResponsesInputItem;
  assert.deepEqual(run([user("go"), assistant("Hi"), summary, user("a")], "turn_done", [], done), { kind: "continue_user", from: 3, items: 1 }, "a typed summary before the tail is not sent");
  assert.deepEqual(run([user("go"), assistant("Hi"), user("a"), summary, user("b")], "turn_done", [], done), { kind: "reseed", reason: "unexpected_tail", divergedAt: 2 }, "a typed summary inside the tail is not sent");
});

test("after an interrupt the next history may include or omit the partial run", () => {
  const ledger = { items: [entries([user("go")]).entries[0].digest], partial: partialDigest("Half an ans") };
  for (const input of [[user("go"), user("again")], [user("go"), assistant("Half an ans"), user("again")]]) {
    const value = entries(input);
    assert.equal(decide(ledger, value.entries, value.messages, "turn_done", []).kind, "continue_user");
  }
  const changed = entries([user("go"), assistant("Different"), user("again")]);
  assert.deepEqual(decide(ledger, changed.entries, changed.messages, "turn_done", []), { kind: "reseed", reason: "unexpected_tail", divergedAt: 1 }, "other assistant text never enters as user input");
  assert.equal(partialDigest(""), undefined);
});

test("search items and hosted web search count as no conversation message, exactly as translation skips them", () => {
  // A chat that switched to Claude from a Codex route can carry these; a miscount would shift every later ledger index.
  const input = [{ type: "message", role: "user", content: "find" }, { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "q" } },
    { type: "tool_search_call", call_id: "call_s1", execution: "client", arguments: { query: "q" } },
    { type: "tool_search_output", call_id: "call_s1", execution: "client", status: "completed", tools: [] },
    { type: "message", role: "user", content: "next" }] as unknown as ResponsesInputItem[];
  const { entries: list, messages } = ledgerEntries(request(input), tools);
  assert.equal(messages, responsesToChatRequest(request(input)).messages.length);
  assert.deepEqual(list.map(entry => [entry.kind, entry.first]), [["m", 0], ["m", 1]]);
});
