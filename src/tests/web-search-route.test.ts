import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ProviderError, type Provider } from "../providers/provider.js";
import { readEvents } from "../protocol/sse.js";
import { startGateway } from "../server.js";
import { gatewayToken, validateConfig, type ProviderConfig } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { InferenceEvent, ResponsesRequest, WireEvent } from "../protocol/types.js";

const usage = { input_tokens: 5, output_tokens: 2, total_tokens: 7 };
const hosted = { type: "web_search", external_web_access: true, search_content_types: ["text", "image"] };
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const done = { type: "web_search_call", id: "ws_0df2", status: "completed", action: { type: "search", query: "latest node release", queries: ["latest node release"] } };
const answer = { id: "msg_1", type: "message", role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "Node 26 [nodejs.org](https://nodejs.org)", annotations: [{ type: "url_citation", url: "https://nodejs.org" }] }] };
/** What api.openai.com returned in the live check, minus reasoning: progress events, a citation and end_turn: null. */
const searchStream = [
  { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { id: "ws_0df2", type: "web_search_call", status: "in_progress" } },
  { type: "response.web_search_call.in_progress", item_id: "ws_0df2", output_index: 0 },
  { type: "response.web_search_call.searching", item_id: "ws_0df2", output_index: 0 },
  { type: "response.web_search_call.completed", item_id: "ws_0df2", output_index: 0 },
  { type: "response.output_item.done", output_index: 0, item: done },
  { type: "response.output_item.added", output_index: 1, item: { ...answer, status: "in_progress", content: [] } },
  { type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: "Node 26 [nodejs.org](https://nodejs.org)" },
  { type: "response.output_text.annotation.added", item_id: "msg_1", annotation: { type: "url_citation", url: "https://nodejs.org" } },
  { type: "response.output_item.done", output_index: 1, item: answer },
  { type: "response.completed", response: { id: "resp_1", status: "completed", end_turn: null, output: [], usage, tool_usage: { web_search: { num_requests: 1 } } } },
];
async function credential(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-search-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  return { directory, credentialFile };
}
/** Replaces fetch for upstream URLs only, so the gateway's own HTTP server stays reachable. */
function upstream(t: TestContext, handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const real = globalThis.fetch; const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.startsWith("https://api.openai.com/") && !url.startsWith("https://upstream.invalid/")) return real(input, init);
    calls.push({ url, init, body: JSON.parse(String(init.body)) }); return handler(url, init);
  });
  return calls;
}
const collect = async (provider: Provider, body: Partial<ResponsesRequest>) => {
  const events: InferenceEvent[] = [];
  for await (const event of provider.infer({ model: "sol", input: "hi", ...body }, new AbortController().signal)) events.push(event);
  return events;
};
const codexProvider = (credentialFile: string) => new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, models: { "codex/sol": "sol" } } as ProviderConfig);

test("the Codex 2 route forwards the hosted tool last and unwrapped, with replayed search items unchanged", async t => {
  const { credentialFile } = await credential(t);
  const calls = upstream(t, () => new Response(searchStream.map(frame).join("")));
  const replayed = { type: "web_search_call", id: "ws_old", status: "completed", action: { type: "search", query: "old", queries: ["old"] }, extra_opaque: { kept: 1 } };
  const own = { type: "web_search_call", id: "ws_claude_toolu_1", status: "completed", action: { type: "search", query: "from claude" } };
  const tools = [{ type: "namespace", name: "mcp", tools: [{ type: "function", name: "lookup" }] }, { type: "function", name: "inspect" }, hosted];
  await collect(codexProvider(credentialFile), { tools: tools as never, input: [{ role: "user", content: "hi" }, replayed, own, { role: "user", content: "more" }] as never });
  const sent = calls[0].body;
  assert.equal(sent.tools.length, 3);
  assert.equal(sent.tools[0].name, "mcp");
  assert.deepEqual(sent.tools[1].tools.map((tool: { name: string }) => tool.name), ["inspect"]); assert.equal(sent.tools[1].type, "namespace");
  assert.deepEqual(sent.tools[2], hosted, "the caller's declaration, byte for byte, outside every namespace");
  assert.deepEqual(sent.input.filter((item: { type?: string }) => item.type === "web_search_call"), [replayed], "an OpenAI item is replayed whole; the gateway's own Claude item never leaves");
  assert.deepEqual(sent.include, ["reasoning.encrypted_content"]); assert.equal(sent.store, false);
});

test("a generic Responses upstream never receives the hosted tool or search calls", async t => {
  process.env.SEARCH_TEST_KEY = "fixture-only"; t.after(() => { delete process.env.SEARCH_TEST_KEY; });
  const calls = upstream(t, () => new Response(frame({ type: "response.completed", response: { id: "r", status: "completed", output: [], usage } })));
  const provider = new ResponsesAPI({ id: "api", type: "responses-api", baseUrl: "https://upstream.invalid/v1", apiKeyEnv: "SEARCH_TEST_KEY", models: { "api/m": "m" } } as ProviderConfig);
  await collect(provider, { tools: [{ type: "function", name: "inspect" }, hosted] as never, input: [{ role: "user", content: "hi" }, done] as never });
  assert.deepEqual(calls[0].body.tools, [{ type: "function", name: "inspect" }]);
  assert.deepEqual(calls[0].body.input, [{ role: "user", content: "hi" }]);
});

test("search items stream through, upstream progress and citations are ignored, and end_turn null counts as absent", async t => {
  const { credentialFile } = await credential(t);
  upstream(t, () => new Response(searchStream.map(frame).join("")));
  const events = await collect(codexProvider(credentialFile), { tools: [hosted] as never });
  assert.deepEqual(events.filter(event => event.type === "hosted-item"), [
    { type: "hosted-item", item: { id: "ws_0df2", type: "web_search_call", status: "in_progress" }, done: false },
    { type: "hosted-item", item: done, done: true }]);
  assert.equal(events.filter(event => event.type === "text").map(event => (event as { text: string }).text).join(""), "Node 26 [nodejs.org](https://nodejs.org)");
  const last = events.at(-1) as Extract<InferenceEvent, { type: "done" }>;
  assert.equal(last.type, "done"); assert.equal(Object.hasOwn(last, "endTurn"), false);
  assert.equal(events.some(event => event.type === "tool"), false);
});

test("the completed snapshot emits only unseen search items, once", async t => {
  const { credentialFile } = await credential(t);
  const late = { type: "web_search_call", id: "ws_late", status: "completed", action: { type: "search", query: "late" } };
  upstream(t, () => new Response([
    { type: "response.output_item.done", output_index: 0, item: done },
    { type: "response.completed", response: { id: "r", status: "completed", output: [done, late], usage } },
  ].map(frame).join("")));
  const events = (await collect(codexProvider(credentialFile), { tools: [hosted] as never })).filter(event => event.type === "hosted-item");
  assert.deepEqual(events.map(event => [(event as { item: { id: string } }).item.id, (event as { done: boolean }).done]), [["ws_0df2", true], ["ws_late", true]]);
});

test("a malformed or repeated search item fails instead of reaching Codex", async t => {
  const { credentialFile } = await credential(t);
  for (const frames of [
    [{ type: "response.output_item.done", item: { type: "web_search_call", status: "completed" } }],
    [{ type: "response.output_item.done", item: { type: "web_search_call", id: "", status: "completed" } }],
    [{ type: "response.output_item.added", item: { type: "web_search_call", id: "ws", status: 3 } }],
    [{ type: "response.output_item.done", item: done }, { type: "response.output_item.done", item: done }],
  ]) {
    upstream(t, () => new Response(frames.map(frame).join("")));
    await assert.rejects(collect(codexProvider(credentialFile), { tools: [hosted] as never }), (error: ProviderError) => error.code === "invalid_output");
    t.mock.restoreAll();
  }
});

test("a search that already started is never retried automatically", async t => {
  const { credentialFile } = await credential(t);
  const calls = upstream(t, () => new Response([
    { type: "response.output_item.added", item: { id: "ws_1", type: "web_search_call", status: "in_progress" } },
    { type: "response.failed", response: { error: { code: "server_error" } } },
  ].map(frame).join("")));
  await assert.rejects(collect(codexProvider(credentialFile), { tools: [hosted] as never }), (error: ProviderError) => error.code === "upstream_unavailable");
  assert.equal(calls.length, 1);
});

async function gateway(t: TestContext, providers: unknown[], factory?: (config: ProviderConfig) => Provider) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-search-server-")); t.after(() => rm(directory, { recursive: true, force: true }));
  configureTelemetry(directory, "gateway");
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, providers });
  const server = await startGateway(config, factory ? provider => factory(provider) : undefined);
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  return { url, headers, directory, post: (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body) }) };
}

test("a Codex 2 alias streams search items and replays them next turn; other routes reject the tool before inference", async t => {
  const { credentialFile } = await credential(t);
  const calls = upstream(t, () => new Response(searchStream.map(frame).join("")));
  const never: Provider = { async *infer() { assert.fail("a route without web search must not reach its provider"); } };
  const g = await gateway(t, [{ id: "codex", type: "codex-subscription", credentialFile, models: { "codex/sol": "sol" } },
    { id: "claude", type: "claude-subscription", models: { "claude/opus": "opus" } }, { id: "copilot", type: "copilot-subscription", models: { "copilot/sol": "sol" } },
    { id: "api", type: "chat-completions-api", baseUrl: "https://upstream.invalid/v1", apiKeyEnv: "UNUSED", models: { "api/model": "model" } },
    { id: "anthropic", type: "anthropic-api", baseUrl: "https://upstream.invalid", apiKeyEnv: "UNUSED", models: { "anthropic/model": "model" } },
  ], config => config.type === "codex-subscription" ? new ResponsesAPI(config) : never);
  const response = await g.post("/v1/responses", { model: "codex/sol", input: "latest node?", stream: true, tools: [hosted] });
  assert.equal(response.status, 200);
  const wire: WireEvent[] = []; for await (const event of readEvents(response.body!)) wire.push(event);
  const items = wire.filter(event => event.type.startsWith("response.output_item.")).map(event => `${event.type}:${(event.item as { type: string }).type}`);
  assert.deepEqual(items, ["response.output_item.added:web_search_call", "response.output_item.done:web_search_call", "response.output_item.added:message", "response.output_item.done:message"]);
  assert.ok(!wire.some(event => event.type.includes("web_search_call.")), "Codex ignores upstream progress, so it is not forwarded");
  const completed = wire.at(-1)!; assert.equal(completed.type, "response.completed");
  const output = (completed.response as { output: Array<Record<string, unknown>> }).output;
  assert.deepEqual(output[0], done); assert.equal(Object.hasOwn(completed.response as object, "end_turn"), false);
  // The next turn replays the finished search with its assistant output, as Codex does under store=false.
  const next = await g.post("/v1/responses", { model: "codex/sol", tools: [hosted], input: [{ role: "user", content: "latest node?" }, ...output, { role: "user", content: "and npm?" }] });
  assert.equal(next.status, 200);
  assert.deepEqual(calls[1].body.input.filter((item: { type?: string }) => item.type === "web_search_call"), [done]);
  for (const model of ["claude/opus", "copilot/sol", "api/model", "anthropic/model"]) {
    const rejected = await g.post("/v1/responses", { model, input: "hi", tools: [hosted] });
    assert.equal(rejected.status, 400, model); assert.equal(((await rejected.json()) as { error: { code: string } }).error.code, "invalid_request", model);
  }
  assert.equal(calls.length, 2, "rejected requests never reached an upstream");
  await flushTelemetry();
  const events = await readTelemetry(g.directory, 0);
  assert.equal(events.find(event => event.event === "request_completed" && event.webSearches === 1) !== undefined, true, "a search is counted, never described");
  assert.ok(!JSON.stringify(events).includes("latest node"));
});
