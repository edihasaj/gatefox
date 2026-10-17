import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResponsesTranslationError, responsesToChatRequest } from "../protocol/request.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import { ResponsesAPI } from "../providers/responses-api.js";
import type { InferenceEvent, ResponsesRequest, WireEvent } from "../protocol/types.js";
import type { ProviderConfig } from "../config.js";

// Fixture values only. The shapes follow what the native Codex engine sends and receives.
const searchTool = { type: "tool_search", execution: "client", description: "Search deferred tools", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false } };
const searchCall = { type: "tool_search_call", call_id: "call_s1", execution: "client", status: "completed", arguments: { query: "fixture query" } };
const searchOutput = { type: "tool_search_output", call_id: "call_s1", execution: "client", status: "completed",
  tools: [{ type: "namespace", name: "mcp__fixture__", description: "Deferred", tools: [{ type: "function", name: "lookup", description: "d", defer_loading: true, parameters: { type: "object", properties: {} } }] }] };
const exec = { type: "function", name: "exec_command", description: "Run", parameters: { type: "object", properties: { cmd: { type: "string" } } } };
const request = (): ResponsesRequest => ({ model: "upstream", stream: true, tools: [exec, searchTool, { type: "namespace", name: "ns", description: "n", tools: [] }],
  input: [{ type: "message", role: "user", content: "find it" }, searchCall, searchOutput, { type: "message", role: "user", content: "now use it" }] } as unknown as ResponsesRequest);

async function reasonOf(run: () => unknown): Promise<[string, string | undefined]> {
  try { await run(); } catch (error) { if (error instanceof ResponsesTranslationError) return [error.reason, error.itemType]; throw error; }
  throw new Error("expected a translation failure");
}
async function drain(source: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> { const events: InferenceEvent[] = []; for await (const event of source) events.push(event); return events; }

test("tool_search and its items stay rejected unless the route opts in", async () => {
  const tool = { model: "m", input: "hi", tools: [searchTool] } as unknown as ResponsesRequest;
  assert.deepEqual(await reasonOf(() => responsesToChatRequest(tool)), ["unsupported_tool", "tool_search"]);
  assert.deepEqual(await reasonOf(() => responsesToChatRequest(tool, { toolSearch: false })), ["unsupported_tool", "tool_search"]);
  for (const item of [searchCall, searchOutput]) {
    const items = { model: "m", input: [item] } as unknown as ResponsesRequest;
    assert.deepEqual(await reasonOf(() => responsesToChatRequest(items)), ["unsupported_input_item", item.type]);
  }
  // A search tool declared in a Responses lite additional_tools item is rejected the same way.
  const lifted = { model: "m", input: [{ type: "additional_tools", tools: [searchTool] }] } as unknown as ResponsesRequest;
  assert.deepEqual(await reasonOf(() => responsesToChatRequest(lifted)), ["unsupported_tool", "tool_search"]);
});

test("with the Codex route's option, search is skipped by translation and never becomes a message or function", () => {
  const chat = responsesToChatRequest(request(), { toolSearch: true });
  assert.deepEqual(chat.tools?.map(tool => tool.function.name), ["exec_command"]);
  assert.deepEqual(chat.messages.map(message => message.role), ["user", "user"]);
  // Only search is accepted: another unsupported tool or item type still fails.
  assert.throws(() => responsesToChatRequest({ model: "m", input: "x", tools: [{ type: "web_search" }] } as unknown as ResponsesRequest, { toolSearch: true }), { reason: "unsupported_tool" });
  assert.throws(() => responsesToChatRequest({ model: "m", input: [{ type: "web_search_call" }] } as unknown as ResponsesRequest, { toolSearch: true }), { reason: "unsupported_input_item" });
  // A forced tool call is satisfied by a declared search tool, which the client executes.
  assert.doesNotThrow(() => responsesToChatRequest({ model: "m", input: "x", tool_choice: "required", tools: [searchTool] } as unknown as ResponsesRequest, { toolSearch: true }));
  assert.throws(() => responsesToChatRequest({ model: "m", input: "x", tool_choice: "required", tools: [] } as unknown as ResponsesRequest, { toolSearch: true }), { reason: "unsupported_tool_choice" });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-tool-search-"));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  return { directory, credentialFile };
}
const sse = (...events: Array<Record<string, unknown>>) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

test("the Codex route forwards the search tool and replayed search items byte for byte and streams search output back unchanged", async t => {
  const { directory, credentialFile } = await fixture();
  const bodies: Array<Record<string, unknown>> = [];
  const emitted = { type: "tool_search_call", id: "ts_1", call_id: "call_s2", execution: "client", status: "completed", arguments: { query: "other fixture query" } };
  const served = { type: "tool_search_output", id: "tso_1", call_id: "call_s3", execution: "server", status: "completed", tools: [] };
  const call = { type: "function_call", id: "fc_1", call_id: "call_f1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}", status: "completed" };
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    bodies.push(JSON.parse(String(options.body)));
    return new Response(sse(
      { type: "response.output_item.done", output_index: 0, item: emitted }, { type: "response.output_item.done", output_index: 1, item: served },
      { type: "response.output_item.done", output_index: 2, item: call },
      // The final snapshot repeats every item; none is sent to the client twice.
      { type: "response.completed", response: { id: "r", status: "completed", output: [emitted, served, call], usage } }), { headers: { "Content-Type": "text/event-stream" } });
  });
  try {
    const provider = new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, models: { "codex/upstream": "upstream" } } as ProviderConfig);
    const events = await drain(provider.infer(request(), new AbortController().signal));
    const sent = bodies[0] as { tools: unknown[]; input: unknown[] };
    // Same JSON, same key order: compare the serialized text, not only the parsed values.
    assert.equal(JSON.stringify(sent.tools.find(tool => (tool as { type: string }).type === "tool_search")), JSON.stringify(searchTool));
    assert.equal(JSON.stringify(sent.input.slice(1, 3)), JSON.stringify([searchCall, searchOutput]));
    assert.deepEqual(sent.input.map(item => (item as { type: string }).type), ["message", "tool_search_call", "tool_search_output", "message"], "order is kept");
    assert.deepEqual(sent.tools.map(tool => (tool as { type: string }).type).sort(), ["namespace", "namespace", "tool_search"], "the search tool is not wrapped in the gateway namespace");
    const gateway = sent.tools.find(tool => (tool as { name?: string }).name === "gateway") as { tools: Array<{ name: string }> };
    assert.deepEqual(gateway.tools.map(tool => tool.name), ["exec_command"], "only the caller's function tools join the gateway namespace");

    assert.deepEqual(events.filter(event => event.type === "native-item"), [{ type: "native-item", item: emitted }, { type: "native-item", item: served }]);
    assert.equal(events.filter(event => event.type === "tool").length, 1, "search items are not function calls");
    assert.equal(events.at(-1)!.type, "done");

    // The writer relays them to the SDK as received, in order, and keeps them in the final response.
    const wire: WireEvent[] = []; const writer = new ResponsesWriter("alias", event => wire.push(event)); writer.begin();
    for (const event of events) writer.accept(event);
    const done = wire.filter(event => event.type === "response.output_item.done").map(event => event.item);
    assert.deepEqual(done, [emitted, served, { ...call, id: "fc_call_f1" }]);
    assert.equal(JSON.stringify(wire.find(event => event.type === "response.output_item.added" && (event.item as { type: string }).type === "tool_search_call")!.item), JSON.stringify(emitted));
    assert.deepEqual((wire.at(-1)!.response as { output: unknown[] }).output.slice(0, 2), [emitted, served]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a search item that only appears in the final snapshot is still delivered once", async t => {
  const { directory, credentialFile } = await fixture();
  const late = { type: "tool_search_call", call_id: "call_s9", execution: "client", status: "completed", arguments: { query: "x" } };
  t.mock.method(globalThis, "fetch", async () => new Response(sse({ type: "response.completed", response: { id: "r", status: "completed", output: [late, late], usage } }), { headers: { "Content-Type": "text/event-stream" } }));
  try {
    const provider = new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, models: { "codex/upstream": "upstream" } } as ProviderConfig);
    assert.deepEqual((await drain(provider.infer(request(), new AbortController().signal))).filter(event => event.type === "native-item"), [{ type: "native-item", item: late }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("every other provider type rejects search exactly as before", async t => {
  const { directory, credentialFile } = await fixture();
  let reached = 0;
  t.mock.method(globalThis, "fetch", async () => { reached++; return new Response(sse({ type: "response.completed", response: { id: "r", status: "completed", usage } }), { headers: { "Content-Type": "text/event-stream" } }); });
  process.env.TOOL_SEARCH_TEST_KEY = "fixture-only";
  try {
    const generic = new ResponsesAPI({ id: "api", type: "responses-api", baseUrl: "https://example.invalid/v1", apiKeyEnv: "TOOL_SEARCH_TEST_KEY", models: { "api/upstream": "upstream" } } as ProviderConfig);
    const chat = new ChatCompletionsAPI({ id: "chat", type: "chat-completions-api", baseUrl: "https://example.invalid/v1", apiKeyEnv: "TOOL_SEARCH_TEST_KEY", models: { "chat/upstream": "upstream" } } as ProviderConfig);
    const onlyTool = { model: "upstream", input: "hi", tools: [searchTool] } as unknown as ResponsesRequest;
    const onlyItems = { model: "upstream", input: [searchCall] } as unknown as ResponsesRequest;
    for (const provider of [generic, chat]) {
      assert.deepEqual(await reasonOf(() => drain(provider.infer(onlyTool, new AbortController().signal))), ["unsupported_tool", "tool_search"]);
    }
    assert.deepEqual(await reasonOf(() => drain(chat.infer(onlyItems, new AbortController().signal))), ["unsupported_input_item", "tool_search_call"]);
    assert.equal(reached, 0, "nothing was sent upstream");
  } finally { delete process.env.TOOL_SEARCH_TEST_KEY; await rm(directory, { recursive: true, force: true }); }
});
