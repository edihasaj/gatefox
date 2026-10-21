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
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

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
  // Only tool search is accepted here: another unsupported tool or item type still fails (hosted web search is skipped, never rejected; see web-search.test.ts).
  assert.throws(() => responsesToChatRequest({ model: "m", input: "x", tools: [{ type: "file_search" }] } as unknown as ResponsesRequest, { toolSearch: true }), { reason: "unsupported_tool" });
  assert.throws(() => responsesToChatRequest({ model: "m", input: [{ type: "file_search_call" }] } as unknown as ResponsesRequest, { toolSearch: true }), { reason: "unsupported_input_item" });
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

test("the Codex route drops the search tool and replayed search items, counts them, and still streams an upstream search item back unchanged", async t => {
  const { directory, credentialFile } = await fixture();
  configureTelemetry(directory, "test");
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
    // The ChatGPT backend refuses a forwarded tool_search (HTTP 400 in production), so neither the tool nor the items go upstream.
    assert.deepEqual(sent.tools.map(tool => (tool as { type: string }).type).sort(), ["namespace", "namespace"], "no search tool upstream; the other tools are unchanged");
    assert.equal(JSON.stringify(sent.tools).includes("tool_search"), false);
    assert.deepEqual(sent.input.map(item => (item as { type: string }).type), ["message", "message"], "no search item upstream; the rest keeps its order");
    assert.equal(JSON.stringify(sent.input).includes("tool_search"), false);
    const gateway = sent.tools.find(tool => (tool as { name?: string }).name === "gateway") as { tools: Array<{ name: string }> };
    assert.deepEqual(gateway.tools.map(tool => tool.name), ["exec_command"], "only the caller's function tools join the gateway namespace");
    // Counts only: never a definition, query or argument.
    await flushTelemetry();
    const dropped = (await readTelemetry(directory, 0)).filter(event => event.event === "tool_search_dropped");
    assert.equal(dropped.length, 1);
    assert.deepEqual([dropped[0].provider, dropped[0].tools, dropped[0].items], ["codex", 1, 2]);
    assert.equal(JSON.stringify(dropped[0]).includes("fixture query"), false);

    // An upstream search item, if one ever arrives, keeps today's handling.
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
  } finally { await flushTelemetry(); await rm(directory, { recursive: true, force: true }); }
});

test("a Codex request without search sends no tool_search_dropped event", async t => {
  const { directory, credentialFile } = await fixture();
  configureTelemetry(directory, "test");
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    bodies.push(JSON.parse(String(options.body)));
    return new Response(sse({ type: "response.completed", response: { id: "r", status: "completed", usage } }), { headers: { "Content-Type": "text/event-stream" } });
  });
  try {
    const provider = new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, models: { "codex/upstream": "upstream" } } as ProviderConfig);
    await drain(provider.infer({ model: "upstream", stream: true, tools: [exec], input: [{ type: "message", role: "user", content: "hi" }] } as unknown as ResponsesRequest, new AbortController().signal));
    assert.equal((bodies[0].tools as unknown[]).length, 1);
    await flushTelemetry();
    assert.deepEqual((await readTelemetry(directory, 0)).filter(event => event.event === "tool_search_dropped"), []);
  } finally { await flushTelemetry(); await rm(directory, { recursive: true, force: true }); }
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

test("an interrupted final snapshot withholds a search item that did not complete, like an unfinished function call", async t => {
  const { directory, credentialFile } = await fixture();
  const unfinished = [{ ...searchCall, call_id: "call_u1", status: "in_progress" }, { ...searchCall, call_id: "call_u2", status: "incomplete" }, { ...searchCall, call_id: "call_u3", status: undefined },
    { type: "tool_search_output", call_id: "call_u4", execution: "client", status: "in_progress", tools: [] }];
  const finished = { ...searchCall, call_id: "call_done", status: "completed" };
  const finishedOutput = { ...searchOutput, call_id: "call_done" };
  let snapshot: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async () => new Response(sse({ type: "response.incomplete", response: { id: "r", status: "incomplete", incomplete_details: { reason: "interrupted" }, output: snapshot, usage } }), { headers: { "Content-Type": "text/event-stream" } }));
  try {
    const provider = new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, models: { "codex/upstream": "upstream" } } as ProviderConfig);
    snapshot = [...unfinished, finished, finishedOutput];
    const events = await drain(provider.infer(request(), new AbortController().signal));
    assert.deepEqual(events.filter(event => event.type === "native-item"), [{ type: "native-item", item: finished }, { type: "native-item", item: finishedOutput }], "only the completed search items are delivered");
    assert.equal(events.at(-1)!.type, "done");
    assert.equal((events.at(-1) as { interrupted?: boolean }).interrupted, true);
    // The same unfinished item is still delivered when the stream completes normally: only an interrupted snapshot withholds it.
    t.mock.method(globalThis, "fetch", async () => new Response(sse({ type: "response.completed", response: { id: "r", status: "completed", output: [unfinished[0]], usage } }), { headers: { "Content-Type": "text/event-stream" } }));
    assert.deepEqual((await drain(provider.infer(request(), new AbortController().signal))).filter(event => event.type === "native-item"), [{ type: "native-item", item: unfinished[0] }]);
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
