import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeToolSearch } from "../protocol/tool-search-bridge.js";
import { responsesToChatRequest } from "../protocol/request.js";
import { ResponsesAPI } from "../providers/responses-api.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";
import type { ProviderConfig } from "../config.js";

// Regressions for the independent review of #27, #30 and #31. Fixture values only.
const searchTool = { type: "tool_search", execution: "client", description: "Search deferred tools", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } };
const ownSearch = { type: "namespace", name: "functions", description: "Defaults", tools: [{ type: "function", name: "tool_search", description: "the caller's own", parameters: { type: "object", properties: {} } }] };
const user = (content: string) => ({ type: "message", role: "user", content });
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const sse = (...events: Array<Record<string, unknown>>) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
async function drain(source: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> { const events: InferenceEvent[] = []; for await (const event of source) events.push(event); return events; }
async function codexFixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-search-review-"));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  return { directory, credentialFile };
}

test("the bridge name avoids children of the default functions namespace, which are called unqualified", () => {
  const bridged = bridgeToolSearch({ model: "m", tools: [ownSearch, searchTool], input: [user("hi")] } as unknown as ResponsesRequest);
  assert.equal(bridged.name, "tool_search_");
});

test("with the bridge on, a caller's own tool_search is dispatched as a caller tool when the request declares no search", async t => {
  const { directory, credentialFile } = await codexFixture();
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "tool_search", arguments: "{}", status: "completed" };
  t.mock.method(globalThis, "fetch", async () => new Response(sse({ type: "response.output_item.done", output_index: 0, item: call },
    { type: "response.completed", response: { id: "r", status: "completed", output: [call], usage } }), { headers: { "Content-Type": "text/event-stream" } }));
  try {
    const provider = new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, toolSearch: "bridge", models: { "codex/sol": "gpt-6.1-sol" } } as ProviderConfig);
    const events = await drain(provider.infer({ model: "gpt-6.1-sol", stream: true, tools: [ownSearch], input: [user("hi")] } as unknown as ResponsesRequest, new AbortController().signal));
    assert.deepEqual(events.filter(event => event.type === "native-item"), [], "not mistaken for the client's search");
    const tools = events.filter(event => event.type === "tool") as Array<Extract<InferenceEvent, { type: "tool" }>>;
    assert.deepEqual(tools.map(event => event.call.responseTool?.name), ["tool_search"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a generic Responses route lets an additional_tools declaration win over a tool a search loaded", async t => {
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => { bodies.push(JSON.parse(String(options.body)));
    return new Response(sse({ type: "response.completed", response: { id: "r", status: "completed", usage } }), { headers: { "Content-Type": "text/event-stream" } }); });
  process.env.SEARCH_REVIEW_KEY = "fixture-only";
  try {
    const generic = new ResponsesAPI({ id: "api", type: "responses-api", baseUrl: "https://example.invalid/v1", apiKeyEnv: "SEARCH_REVIEW_KEY", models: { "api/upstream": "upstream" } } as ProviderConfig);
    const loaded = { type: "tool_search_output", call_id: "call_s1", execution: "client", status: "completed", tools: [{ type: "function", name: "lookup", description: "old", parameters: { type: "object", properties: {} } }] };
    const declared = { type: "additional_tools", role: "developer", tools: [{ type: "custom", name: "lookup", description: "new" }] };
    await drain(generic.infer({ model: "upstream", stream: true, input: [user("find"), { type: "tool_search_call", call_id: "call_s1", execution: "client", arguments: { query: "q" } }, loaded, declared, user("use it")] } as unknown as ResponsesRequest, new AbortController().signal));
    const sent = bodies[0] as { tools?: Array<{ name?: string }> };
    assert.deepEqual((sent.tools ?? []).filter(tool => tool.name === "lookup"), [], "the old function is not declared beside the newer custom tool");
  } finally { delete process.env.SEARCH_REVIEW_KEY; }
});

test("a tool_choice naming web_search is valid on the Codex route when declared, forwarded as sent, and auto elsewhere", async t => {
  const choice = { type: "web_search" };
  const declared = { model: "m", input: "x", tools: [{ type: "web_search" }], tool_choice: choice } as unknown as ResponsesRequest;
  assert.doesNotThrow(() => responsesToChatRequest(declared, { toolSearch: true, webSearch: true }));
  assert.throws(() => responsesToChatRequest({ ...declared, tools: [] } as unknown as ResponsesRequest, { toolSearch: true, webSearch: true }), { reason: "unsupported_tool_choice" });
  assert.equal(responsesToChatRequest(declared).tool_choice, "auto");
  const { directory, credentialFile } = await codexFixture();
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => { bodies.push(JSON.parse(String(options.body)));
    return new Response(sse({ type: "response.completed", response: { id: "r", status: "completed", usage } }), { headers: { "Content-Type": "text/event-stream" } }); });
  process.env.SEARCH_REVIEW_KEY = "fixture-only";
  try {
    const codex = new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, models: { "codex/sol": "gpt-6.1-sol" } } as ProviderConfig);
    await drain(codex.infer({ ...declared, model: "gpt-6.1-sol", stream: true } as ResponsesRequest, new AbortController().signal));
    assert.deepEqual(bodies[0].tool_choice, choice, "the Codex route forwards the choice unchanged");
    const generic = new ResponsesAPI({ id: "api", type: "responses-api", baseUrl: "https://example.invalid/v1", apiKeyEnv: "SEARCH_REVIEW_KEY", models: { "api/upstream": "upstream" } } as ProviderConfig);
    await drain(generic.infer({ ...declared, model: "upstream", stream: true } as ResponsesRequest, new AbortController().signal));
    assert.equal(bodies[1].tool_choice, "auto", "a route without hosted search sends no choice it cannot run");
  } finally { delete process.env.SEARCH_REVIEW_KEY; await rm(directory, { recursive: true, force: true }); }
});

test("a tool declared inside the default functions namespace also wins over a flat copy a search loaded", async t => {
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => { bodies.push(JSON.parse(String(options.body)));
    return new Response(sse({ type: "response.completed", response: { id: "r", status: "completed", usage } }), { headers: { "Content-Type": "text/event-stream" } }); });
  process.env.SEARCH_REVIEW_KEY = "fixture-only";
  try {
    const generic = new ResponsesAPI({ id: "api", type: "responses-api", baseUrl: "https://example.invalid/v1", apiKeyEnv: "SEARCH_REVIEW_KEY", models: { "api/upstream": "upstream" } } as ProviderConfig);
    const loaded = { type: "tool_search_output", call_id: "call_s1", execution: "client", status: "completed", tools: [{ type: "function", name: "lookup", description: "old", parameters: { type: "object", properties: {} } }] };
    const declared = { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", description: "Defaults", tools: [{ type: "custom", name: "lookup", description: "new" }] }] };
    await drain(generic.infer({ model: "upstream", stream: true, input: [user("find"), { type: "tool_search_call", call_id: "call_s1", execution: "client", arguments: { query: "q" } }, loaded, declared, user("use it")] } as unknown as ResponsesRequest, new AbortController().signal));
    const sent = bodies[0] as { tools?: Array<{ name?: string }> };
    assert.deepEqual((sent.tools ?? []).filter(tool => tool.name === "lookup"), [], "functions.lookup and a flat lookup are the same tool");
    // The bridge's own de-duplication uses the same identity.
    const bridged = bridgeToolSearch({ model: "m", tools: [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "lookup" }] }, searchTool], input: [{ type: "tool_search_call", call_id: "c", execution: "client", arguments: {} }, loaded] } as unknown as ResponsesRequest);
    assert.equal(bridged.counts.loaded, 0, "an already declared default-namespace tool is not loaded again");
  } finally { delete process.env.SEARCH_REVIEW_KEY; }
});
