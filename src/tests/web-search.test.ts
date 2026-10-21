import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { responsesToChatRequest, webSearchPresence } from "../protocol/request.js";
import { codexSettings } from "../codex-config.js";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import { ResponsesAPI } from "../providers/responses-api.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";
import type { ProviderConfig } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

// Fixture values only. The shapes follow what native Codex sends on a row that carries web_search_tool_type.
const webTool = { type: "web_search", search_context_size: "medium" };
const webCall = { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "fixture query" } };
const exec = { type: "function", name: "exec_command", description: "Run", parameters: { type: "object", properties: { cmd: { type: "string" } } } };
const codexOpts = { toolSearch: true, webSearch: true };
const request = (): ResponsesRequest => ({ model: "upstream", stream: true, tools: [exec, webTool, { type: "namespace", name: "ns", description: "n", tools: [] }],
  input: [{ type: "message", role: "user", content: "find it" }, webCall, { type: "message", role: "user", content: "now use it" }] } as unknown as ResponsesRequest);

async function drain(source: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> { const events: InferenceEvent[] = []; for await (const event of source) events.push(event); return events; }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-web-search-"));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  return { directory, credentialFile };
}
const sse = (...events: Array<Record<string, unknown>>) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

test("translation skips the hosted tool and its items on every route, and drops them from a switch that lands here", () => {
  for (const options of [codexOpts, {}]) {
    const chat = responsesToChatRequest(request(), options);
    assert.deepEqual(chat.tools?.map(tool => tool.function.name), ["exec_command"], "web_search never becomes a function tool");
    assert.deepEqual(chat.messages.map(message => message.role), ["user", "user"], "web_search_call is never transcript text");
    // A web_search declared in a Responses lite additional_tools item joins neither.
    assert.deepEqual(responsesToChatRequest({ model: "m", input: [{ type: "additional_tools", tools: [exec, webTool] }, { type: "message", role: "user", content: "hi" }] } as unknown as ResponsesRequest, options).tools?.map(tool => tool.function.name), ["exec_command"]);
  }
  // Only web search is skipped: every other hosted tool and item still fails, on every route.
  assert.throws(() => responsesToChatRequest({ model: "m", input: "x", tools: [{ type: "file_search" }] } as unknown as ResponsesRequest, codexOpts), { reason: "unsupported_tool" });
  assert.throws(() => responsesToChatRequest({ model: "m", input: [{ type: "file_search_call" }] } as unknown as ResponsesRequest, codexOpts), { reason: "unsupported_input_item" });
  assert.throws(() => responsesToChatRequest({ model: "m", input: [{ type: "web_search_call" }], tools: [{ type: "file_search" }] } as unknown as ResponsesRequest), { reason: "unsupported_tool" });
});

test("a forced call accepts a declared web_search only on the route that forwards it, and a choice naming it drops to auto elsewhere", () => {
  assert.doesNotThrow(() => responsesToChatRequest({ model: "m", input: "x", tool_choice: "required", tools: [webTool] } as unknown as ResponsesRequest, codexOpts), "the Codex route keeps the client's hosted search");
  assert.doesNotThrow(() => responsesToChatRequest({ model: "m", input: [{ type: "additional_tools", tools: [webTool] }], tool_choice: "required" } as unknown as ResponsesRequest, codexOpts), "a lifted declaration counts the same way");
  assert.throws(() => responsesToChatRequest({ model: "m", input: "x", tool_choice: "required", tools: [webTool] } as unknown as ResponsesRequest, { toolSearch: true }), { reason: "unsupported_tool_choice" }, "a route without web search cannot satisfy the call");
  assert.equal(responsesToChatRequest({ model: "m", input: "x", tools: [exec, webTool], tool_choice: { type: "web_search" } } as unknown as ResponsesRequest, { toolSearch: true }).tool_choice, "auto", "naming a dropped tool drops to auto instead of failing the switch");
});

test("webSearchPresence counts raw declarations only: top level, additional_tools and replayed items", () => {
  assert.deepEqual(webSearchPresence(request()), { tools: 1, items: 1 });
  assert.deepEqual(webSearchPresence({ model: "m", input: [{ type: "additional_tools", tools: [exec, webTool] }, webCall, { ...webCall, id: "ws_2" }] } as unknown as ResponsesRequest), { tools: 1, items: 2 });
  assert.deepEqual(webSearchPresence({ model: "m", input: "hi" } as ResponsesRequest), { tools: 0, items: 0 });
});

async function providerStream(t: test.TestContext, events: Array<Record<string, unknown>>, bodies: Array<Record<string, unknown>>) {
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    bodies.push(JSON.parse(String(options.body)));
    return new Response(sse(...events), { headers: { "Content-Type": "text/event-stream" } });
  });
}

test("the Codex route forwards web_search at the top level and inside additional_tools, replays its calls, and names the stream once", async t => {
  const { directory, credentialFile } = await fixture();
  configureTelemetry(directory, "test");
  const bodies: Array<Record<string, unknown>> = [];
  const lite = { type: "additional_tools", tools: [exec, webTool] };
  const call = { type: "function_call", id: "fc_1", call_id: "call_f1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}", status: "completed" };
  const input = [...request().input as unknown[], lite];
  // Hosted-search progress events arrive between the items; none of them may error the stream.
  await providerStream(t, [
    { type: "response.web_search_call.in_progress", item_id: "ws_1" }, { type: "response.web_search_call.searching", item_id: "ws_1" },
    { type: "response.output_item.done", output_index: 0, item: webCall }, { type: "response.output_item.done", output_index: 1, item: call },
    { type: "response.web_search_call.completed", item_id: "ws_1" },
    { type: "response.completed", response: { id: "r", status: "completed", output: [webCall, call], usage } },
  ], bodies);
  try {
    const provider = new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, models: { "codex/upstream": "upstream" } } as ProviderConfig);
    const events = await drain(provider.infer({ ...request(), input } as ResponsesRequest, new AbortController().signal));
    const sent = bodies[0] as { tools: Array<Record<string, unknown>>; input: Array<Record<string, unknown>> };
    assert.deepEqual(sent.tools.filter(tool => tool.type === "web_search"), [webTool], "the top-level tool is forwarded unchanged");
    const gateway = sent.tools.find(tool => tool.name === "gateway") as { tools: Array<{ name: string }> };
    assert.deepEqual(gateway.tools.map(tool => tool.name), ["exec_command"], "only the caller's function tools join the gateway namespace; the hosted tool never does");
    assert.equal(JSON.stringify(sent.tools.filter(tool => tool.name !== "gateway")).includes("web_search"), true, "the hosted tool stays outside every namespace");
    assert.equal(JSON.stringify(sent.input.find(item => item.type === "additional_tools")).includes("web_search"), true, "the tool inside the additional_tools item is forwarded as declared");
    assert.equal(JSON.stringify(sent.input.find(item => item.type === "web_search_call")), JSON.stringify(webCall), "the replayed call goes upstream unchanged");
    assert.deepEqual(events.filter(event => event.type === "native-item"), [{ type: "native-item", item: webCall }], "the produced call reaches the client once, despite the final snapshot");
    assert.equal(events.filter(event => event.type === "tool").length, 1);
    assert.equal(events.at(-1)!.type, "done");
    await flushTelemetry();
    assert.deepEqual((await readTelemetry(directory, 0)).filter(event => event.event === "web_search_dropped"), [], "the route forwards the tool, so nothing was dropped");
  } finally { await flushTelemetry(); await rm(directory, { recursive: true, force: true }); }
});

test("an interrupted final snapshot withholds a web_search_call that did not complete, like a search item", async t => {
  const { directory, credentialFile } = await fixture();
  const stuck = [{ ...webCall, id: "ws_u", status: "in_progress" }, { ...webCall, id: "ws_i", status: "incomplete" }];
  let snapshot: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async () => new Response(sse({ type: "response.incomplete", response: { id: "r", status: "incomplete", incomplete_details: { reason: "interrupted" }, output: snapshot, usage } }), { headers: { "Content-Type": "text/event-stream" } }));
  try {
    const provider = new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, models: { "codex/upstream": "upstream" } } as ProviderConfig);
    snapshot = [...stuck, webCall];
    const events = await drain(provider.infer(request(), new AbortController().signal));
    assert.deepEqual(events.filter(event => event.type === "native-item"), [{ type: "native-item", item: webCall }], "only the completed call is delivered");
    assert.equal((events.at(-1) as { interrupted?: boolean }).interrupted, true);
    // A normal completion still delivers an unfinished item: only the interrupted snapshot withholds it.
    t.mock.method(globalThis, "fetch", async () => new Response(sse({ type: "response.completed", response: { id: "r", status: "completed", output: [stuck[0]], usage } }), { headers: { "Content-Type": "text/event-stream" } }));
    assert.deepEqual((await drain(provider.infer(request(), new AbortController().signal))).filter(event => event.type === "native-item"), [{ type: "native-item", item: stuck[0] }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a Responses endpoint other than the Codex backend sends no web_search it was not asked to run", async t => {
  process.env.WEB_SEARCH_TEST_KEY = "fixture-only";
  const bodies: Array<Record<string, unknown>> = [];
  await providerStream(t, [{ type: "response.completed", response: { id: "r", status: "completed", usage } }], bodies);
  try {
    const generic = new ResponsesAPI({ id: "api", type: "responses-api", baseUrl: "https://example.invalid/v1", apiKeyEnv: "WEB_SEARCH_TEST_KEY", models: { "api/upstream": "upstream" } } as ProviderConfig);
    await drain(generic.infer({ ...request(), input: [...request().input as unknown[], { type: "additional_tools", tools: [webTool] }] } as ResponsesRequest, new AbortController().signal));
    const sent = bodies[0] as { tools: unknown[]; input: unknown[] };
    assert.equal(JSON.stringify(sent.tools).includes("web_search"), false, "the hosted tool is dropped from the wire");
    assert.equal(JSON.stringify(sent.input).includes("web_search_call"), false, "so are the replayed calls and a lifted item left with nothing");
    assert.equal(JSON.stringify((sent.input as Array<{ type?: string }>).map(item => item.type)), JSON.stringify(["message", "message"]), "the rest keeps its order");
  } finally { delete process.env.WEB_SEARCH_TEST_KEY; }
});

test("a chat-completions endpoint translates the request without the hosted tool or its items", async t => {
  process.env.WEB_SEARCH_TEST_KEY = "fixture-only";
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    bodies.push(JSON.parse(String(options.body)));
    return new Response(sse({ model: "upstream", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }, { choices: [], usage }) + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  try {
    const chat = new ChatCompletionsAPI({ id: "chat", type: "chat-completions-api", baseUrl: "https://example.invalid/v1", apiKeyEnv: "WEB_SEARCH_TEST_KEY", models: { "chat/upstream": "upstream" } } as ProviderConfig);
    await drain(chat.infer(request(), new AbortController().signal));
    assert.equal(JSON.stringify(bodies[0]).includes("web_search"), false, "the tool and the replayed item are dropped before translation");
    assert.equal((bodies[0].tools as Array<{ function: { name: string } }>).length, 1, "only the caller's function tool remains, under its bound name");
    assert.deepEqual((bodies[0].messages as Array<{ role: string }>).map(message => message.role), ["user", "user"]);
  } finally { delete process.env.WEB_SEARCH_TEST_KEY; }
});

test("the generated Codex CLI config no longer forces web_search off, so Codex's own default applies", () => {
  assert.equal(codexSettings("m", "/c.json", "http://127.0.0.1:8080/v1", []).includes("web_search"), false);
});
