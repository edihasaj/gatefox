import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCallError, bridgeToolSearch, bridgedSearchCall } from "../protocol/tool-search-bridge.js";
import { ResponsesAPI } from "../providers/responses-api.js";
import { modelCatalog } from "../catalog.js";
import { executorNativeRow, withNativeRow } from "../codex-native-rows.js";
import { validateConfig, type GatewayConfig, type ProviderConfig } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";

// Fixture values only. The shapes follow what the native Codex engine sends and receives.
const searchTool = { type: "tool_search", execution: "client", description: "Search deferred tools", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false } };
const searchCall = { type: "tool_search_call", id: "tsc_1", call_id: "call_s1", execution: "client", status: "completed", arguments: { query: "fixture query", limit: 8 } };
const lookup = { type: "function", name: "lookup", description: "d", defer_loading: true, parameters: { type: "object", properties: {} } };
const searchOutput = { type: "tool_search_output", call_id: "call_s1", execution: "client", status: "completed", tools: [{ type: "namespace", name: "mcp__fixture__", description: "Deferred", tools: [lookup] }] };
const exec = { type: "function", name: "exec_command", description: "Run", parameters: { type: "object", properties: { cmd: { type: "string" } } } };
const user = (content: string) => ({ type: "message", role: "user", content });
const typeOf = (value: unknown) => (value as { type: string }).type;
const noSearchType = (value: unknown) => !/"type":"tool_search/.test(JSON.stringify(value));

test("top-level search becomes a function, and a replayed search becomes a function call, an output and appended tools", () => {
  const request = { model: "m", tools: [exec, searchTool], input: [user("find"), searchCall, searchOutput, user("use it")] } as unknown as ResponsesRequest;
  const bridged = bridgeToolSearch(request);
  assert.equal(bridged.name, "tool_search");
  assert.ok(noSearchType(bridged.request), "nothing of the refused tool_search type remains");
  const tools = bridged.request.tools as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(tools[1], { type: "function", name: "tool_search", description: searchTool.description, parameters: searchTool.parameters });
  assert.deepEqual(tools[2], { type: "namespace", name: "mcp__fixture__", description: "Deferred", tools: [{ type: "function", name: "lookup", description: "d", parameters: { type: "object", properties: {} } }] },
    "the loaded namespace is appended, without its deferral flag");
  const input = bridged.request.input as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(input.map(typeOf), ["message", "function_call", "function_call_output", "message"]);
  assert.deepEqual(input[1], { type: "function_call", call_id: "call_s1", name: "tool_search", arguments: JSON.stringify(searchCall.arguments) });
  assert.deepEqual(input[2], { type: "function_call_output", call_id: "call_s1", output: "Loaded tools: mcp__fixture__.lookup" });
  assert.deepEqual(bridged.counts, { tools: 1, calls: 1, outputs: 1, loaded: 1 });
  assert.equal(JSON.stringify(request).includes("\"type\":\"tool_search\""), true, "the caller's request is not changed in place");
});

test("on a Responses lite request the search stays where it was declared and the loaded tools follow the output", () => {
  const request = { model: "m", input: [{ type: "additional_tools", tools: [exec, searchTool] }, user("find"), searchCall, searchOutput, user("use it")] } as unknown as ResponsesRequest;
  const bridged = bridgeToolSearch(request);
  const input = bridged.request.input as unknown as Array<{ type: string; tools?: Array<{ name: string }> }>;
  assert.deepEqual(input.map(item => item.type), ["additional_tools", "message", "function_call", "function_call_output", "additional_tools", "message"]);
  assert.deepEqual(input[0].tools!.map(tool => tool.name), ["exec_command", "tool_search"]);
  assert.deepEqual(input[4].tools!.map(tool => tool.name), ["mcp__fixture__"], "everything before the output is unchanged, so the prompt prefix is too");
  assert.deepEqual(bridged.request.tools, [], "no top-level tool is added");
  assert.ok(noSearchType(bridged.request));
});

test("the bridge name avoids every flat tool name, a repeated declaration collapses, and a tool already declared is not loaded twice", () => {
  const own = { type: "function", name: "tool_search", description: "the caller's own", parameters: { type: "object", properties: {} } };
  const declared = { type: "namespace", name: "mcp__fixture__", description: "Mine", tools: [{ type: "function", name: "lookup", description: "mine" }] };
  const flatLoaded = { ...searchOutput, tools: [{ type: "function", name: "tool_search_", description: "x" }, { type: "web_search" }, "junk"] };
  const bridged = bridgeToolSearch({ model: "m", tools: [own, searchTool, searchTool, declared], input: [searchCall, searchOutput, { ...flatLoaded, call_id: "call_s2" }] } as unknown as ResponsesRequest);
  assert.equal(bridged.name, "tool_search__", "the caller's tool_search and a loaded tool_search_ are both taken");
  const tools = bridged.request.tools as unknown as Array<{ name: string }>;
  assert.deepEqual(tools.map(tool => tool.name), ["tool_search", "tool_search__", "mcp__fixture__", "tool_search_"]);
  assert.equal(bridged.counts.tools, 2); assert.equal(bridged.counts.loaded, 1, "only the new flat tool loads; lookup was declared and web_search is not loadable");
  const outputs = (bridged.request.input as unknown as Array<{ type: string; output?: string }>).filter(item => item.type === "function_call_output");
  assert.deepEqual(outputs.map(item => item.output), ["Loaded tools: mcp__fixture__.lookup", "Loaded tools: tool_search_"]);
});

test("a request without search is returned unchanged, and search items without a call id are dropped", () => {
  const plain = { model: "m", tools: [exec], input: [user("hi")] } as unknown as ResponsesRequest;
  assert.equal(bridgeToolSearch(plain).request, plain);
  const orphan = bridgeToolSearch({ model: "m", input: [{ ...searchCall, call_id: null }, { ...searchOutput, call_id: undefined }] } as unknown as ResponsesRequest);
  assert.deepEqual(orphan.request.input, []);
  const empty = bridgeToolSearch({ model: "m", tools: [searchTool], input: [searchCall, { ...searchOutput, tools: [] }] } as unknown as ResponsesRequest);
  assert.equal((empty.request.input as unknown as Array<{ output?: string }>)[1].output, "No matching tools were found.");
});

test("an upstream call of the bridge function is the client's search; anything else is not", () => {
  const call = { type: "function_call", call_id: "call_s2", name: "tool_search", namespace: "gateway", arguments: "{\"query\":\"q\"}" };
  assert.deepEqual(bridgedSearchCall(call, "tool_search", "gateway"), { type: "tool_search_call", call_id: "call_s2", status: "completed", execution: "client", arguments: { query: "q" } });
  assert.deepEqual(bridgedSearchCall({ ...call, namespace: undefined }, "tool_search", "gateway")?.type, "tool_search_call", "a lite declaration has no namespace");
  for (const other of [{ ...call, namespace: "mcp__x" }, { ...call, name: "exec_command" }, { ...call, type: "custom_tool_call" }]) assert.equal(bridgedSearchCall(other, "tool_search", "gateway"), undefined);
  assert.equal(bridgedSearchCall(call, undefined, "gateway"), undefined, "no bridge, no search");
  for (const bad of ["{\"que", "[1]", "7"]) assert.throws(() => bridgedSearchCall({ ...call, arguments: bad }, "tool_search", "gateway"), BridgeCallError);
});

async function codexFixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-tool-search-bridge-"));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  return { directory, credentialFile };
}
const sse = (...events: Array<Record<string, unknown>>) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
async function drain(source: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> { const events: InferenceEvent[] = []; for await (const event of source) events.push(event); return events; }

test("a bridged Codex route sends search as a gateway function and returns the model's search to the client to run", async t => {
  const { directory, credentialFile } = await codexFixture();
  configureTelemetry(directory, "test");
  const bodies: Array<Record<string, unknown>> = [];
  const search = { type: "function_call", id: "fc_9", call_id: "call_s2", name: "tool_search", namespace: "gateway", arguments: "{\"query\":\"other\"}", status: "completed" };
  const loadedCall = { type: "function_call", id: "fc_10", call_id: "call_l1", name: "lookup", namespace: "mcp__fixture__", arguments: "{}", status: "completed" };
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    bodies.push(JSON.parse(String(options.body)));
    return new Response(sse({ type: "response.output_item.done", output_index: 0, item: search }, { type: "response.output_item.done", output_index: 1, item: loadedCall },
      { type: "response.completed", response: { id: "r", status: "completed", output: [search, loadedCall], usage } }), { headers: { "Content-Type": "text/event-stream" } });
  });
  try {
    const provider = new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, toolSearch: "bridge", models: { "codex/sol": "gpt-6.1-sol" } } as ProviderConfig);
    const request = { model: "gpt-6.1-sol", stream: true, tools: [exec, searchTool], input: [user("find"), searchCall, searchOutput, user("use it")] } as unknown as ResponsesRequest;
    const events = await drain(provider.infer(request, new AbortController().signal));
    const sent = bodies[0] as { tools: Array<{ type: string; name: string; tools?: Array<{ name: string }> }>; input: Array<{ type: string; namespace?: string; name?: string }> };
    assert.ok(noSearchType(sent), "the refused tool_search type never goes upstream");
    assert.deepEqual(sent.tools.find(tool => tool.name === "gateway")?.tools?.map(tool => tool.name), ["exec_command", "tool_search"], "the search function joins the gateway namespace");
    assert.deepEqual(sent.tools.find(tool => tool.name === "mcp__fixture__")?.tools?.map(tool => tool.name), ["lookup"]);
    assert.deepEqual(sent.input.map(item => item.type), ["message", "function_call", "function_call_output", "message"]);
    assert.equal(sent.input[1].namespace, "gateway", "the replayed search call is a call of the gateway function");
    const natives = events.filter(event => event.type === "native-item");
    assert.deepEqual(natives, [{ type: "native-item", item: { type: "tool_search_call", call_id: "call_s2", status: "completed", execution: "client", arguments: { query: "other" } } }], "delivered once despite the final snapshot");
    const calls = events.filter(event => event.type === "tool") as Array<Extract<InferenceEvent, { type: "tool" }>>;
    assert.deepEqual(calls.map(event => event.call.responseTool), [{ type: "function", name: "lookup", namespace: "mcp__fixture__" }], "a loaded tool is a caller tool; the search is not");
    await flushTelemetry();
    const bridged = (await readTelemetry(directory, 0)).filter(event => event.event === "tool_search_bridged");
    assert.deepEqual(bridged.map(event => [event.provider, event.tools, event.calls, event.outputs, event.loaded]), [["codex", 1, 1, 1, 1]]);
    assert.equal(JSON.stringify(bridged).includes("fixture query"), false, "counts only");
    assert.deepEqual((await readTelemetry(directory, 0)).filter(event => event.event === "tool_search_dropped"), []);
  } finally { await flushTelemetry(); await rm(directory, { recursive: true, force: true }); }
});

test("an interrupted bridged search is withheld, and malformed search arguments fail as an invalid tool call", async t => {
  const { directory, credentialFile } = await codexFixture();
  const partial = { type: "function_call", id: "fc_1", call_id: "call_s2", name: "tool_search", namespace: "gateway", arguments: "{\"que", status: "in_progress" };
  let reply = sse({ type: "response.output_item.added", output_index: 0, item: { ...partial, encrypted_function_args: [] } },
    { type: "response.incomplete", response: { id: "r", status: "incomplete", incomplete_details: { reason: "interrupted" }, output: [partial], usage } });
  t.mock.method(globalThis, "fetch", async () => new Response(reply, { headers: { "Content-Type": "text/event-stream" } }));
  try {
    const provider = new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, toolSearch: "bridge", models: { "codex/sol": "gpt-6.1-sol" } } as ProviderConfig);
    const request = { model: "gpt-6.1-sol", stream: true, tools: [searchTool], input: [user("find")] } as unknown as ResponsesRequest;
    const events = await drain(provider.infer(request, new AbortController().signal));
    assert.deepEqual(events.filter(event => event.type === "native-item" || event.type === "tool"), []);
    assert.equal(events.at(-1)!.type, "done");
    const bad = { ...partial, arguments: "not json", status: "completed" };
    reply = sse({ type: "response.output_item.done", output_index: 0, item: bad }, { type: "response.completed", response: { id: "r", status: "completed", output: [bad], usage } });
    await assert.rejects(drain(provider.infer(request, new AbortController().signal)), { code: "invalid_tool_call" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("toolSearch is an opt-in Codex setting, and only a bridged route advertises search", () => {
  const base = { version: 1, port: 0, stateDirectory: "." };
  const codex = (extra: Record<string, unknown>) => ({ id: "codex", type: "codex-subscription", credentialFile: "c.json", models: { "codex/sol": "gpt-6.1-sol" }, ...extra });
  assert.equal(validateConfig({ ...base, providers: [codex({ toolSearch: "bridge" })] }).providers[0].toolSearch, "bridge");
  assert.doesNotThrow(() => validateConfig({ ...base, providers: [codex({ toolSearch: "off" })] }));
  assert.throws(() => validateConfig({ ...base, providers: [codex({ toolSearch: "on" })] }), /toolSearch must be off or bridge/);
  assert.throws(() => validateConfig({ ...base, providers: [{ id: "claude", type: "claude-subscription", models: { "claude/x": "x" }, toolSearch: "bridge" }] }), /only valid for codex-subscription/);
  const rows = (extra: Record<string, unknown>) => modelCatalog({ ...base, providers: [codex(extra), { id: "claude", type: "claude-subscription", models: { "claude/x": "x" } }] } as unknown as GatewayConfig).models;
  assert.deepEqual(rows({}).map(row => row.supports_search_tool), [false, false], "off by default");
  const bridged = rows({ toolSearch: "bridge" });
  assert.equal(bridged.find(row => row.slug === "codex/sol")!.supports_search_tool, true);
  assert.equal(bridged.find(row => row.slug === "claude/x")!.supports_search_tool, false);
  const published = bridged.find(row => row.slug === "codex/sol")!;
  const native = { slug: "gpt-6.1-sol", supports_search_tool: true, node_repl_disabled: false, node_repl_auto_review_required: false };
  assert.equal(withNativeRow(published, [native]).supports_search_tool, true, "both the bridged route and the native row say search");
  assert.equal(withNativeRow(published, [{ ...native, supports_search_tool: false }]).supports_search_tool, false, "the native row decides whether Codex runs search for this model");
  assert.equal(withNativeRow(rows({}).find(row => row.slug === "codex/sol")!, [native]).supports_search_tool, false, "an unbridged route keeps it off");
  assert.equal(withNativeRow({ ...bridged.find(row => row.slug === "claude/x")!, supports_search_tool: true }, [native]).supports_search_tool, false, "a row without a native counterpart never searches");
  assert.equal(executorNativeRow(native, [native]).supports_search_tool, false, "a bare sub-agent model name never searches: its route is chosen per request");
});
