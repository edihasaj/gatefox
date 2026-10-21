import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayToken, validateConfig } from "../config.js";
import { createProvider, startGateway } from "../server.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

// Fixture values only. The shapes follow what native Codex sends on a row that carries web_search_tool_type.
const webTool = { type: "web_search", search_context_size: "medium" };
const webCall = { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "fixture query" } };
const exec = { type: "function", name: "exec_command", description: "Run", parameters: { type: "object", properties: { cmd: { type: "string" } } } };
const user = (text: string) => ({ type: "message", role: "user", content: text });
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const upstreamStream = [{ type: "response.output_item.done", output_index: 0, item: webCall },
  { type: "response.completed", response: { id: "r", status: "completed", output: [webCall], usage } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
const chatStream = "data: " + JSON.stringify({ model: "upstream", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }) + "\n\ndata: " + JSON.stringify({ choices: [], usage }) + "\n\ndata: [DONE]\n\n";

/** A gateway with the Codex route, live generic routes, and stubbed Claude and Copilot CLI providers. */
async function harness(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-web-search-server-"));
  configureTelemetry(directory, "test");
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  process.env.WEB_SEARCH_SERVER_KEY = "fixture-only";
  const realFetch = globalThis.fetch; const upstream: Array<Record<string, unknown>> = [];
  // Only the providers' upstream calls are mocked; requests to the gateway itself go through.
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    const target = String(url);
    if (!target.startsWith("http://127.0.0.1:1/") && !target.startsWith("https://api.openai.com/")) return realFetch(url, options);
    upstream.push(JSON.parse(String(options?.body)));
    return new Response(target.startsWith("http://127.0.0.1:1/") ? chatStream : upstreamStream, { headers: { "Content-Type": "text/event-stream" } });
  });
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, maxConcurrent: 2, providers: [
    { id: "codex", type: "codex-subscription", credentialFile, models: { "codex/gpt-6.1-sol": "gpt-6.1-sol" } },
    { id: "chat", type: "chat-completions-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "WEB_SEARCH_SERVER_KEY", models: { "chat/upstream": "upstream" } },
    { id: "claude", type: "claude-subscription", models: { "claude/upstream": "upstream" } },
  ] });
  // Claude would start a CLI; the stub answers the turn so the switch itself can be verified.
  const factory = (provider: Parameters<typeof createProvider>[0]) => provider.type === "claude-subscription"
    ? { async *infer() { yield { type: "done" as const, usage }; } } : createProvider(provider);
  const server = await startGateway(config, factory);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/responses`;
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  const post = (body: Record<string, unknown>) => fetch(url, { method: "POST", headers, body: JSON.stringify({ stream: true, ...body }) });
  const dropped = async () => { await flushTelemetry(); return (await readTelemetry(directory, 0)).filter(event => event.event === "web_search_dropped"); };
  const close = async () => {
    delete process.env.WEB_SEARCH_SERVER_KEY;
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    await flushTelemetry(); await rm(directory, { recursive: true, force: true });
  };
  return { post, upstream, dropped, close };
}
const events = (text: string) => text.split("\n\n").flatMap(block => block.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as Record<string, any>));

test("the Codex route sends the hosted tool as native Codex does and streams its call back", async t => {
  const h = await harness(t);
  try {
    const response = await h.post({ model: "codex/gpt-6.1-sol", input: [user("find it"), webCall, user("now use it")], tools: [exec, webTool] });
    assert.equal(response.status, 200);
    assert.equal(events(await response.text()).some(event => event.type === "response.completed"), true);
    const sent = h.upstream[0] as { tools: Array<Record<string, unknown>>; input: Array<Record<string, unknown>> };
    assert.deepEqual(sent.tools.filter(tool => tool.type === "web_search"), [webTool], "the tool is forwarded unchanged, at the top level");
    assert.equal(JSON.stringify(sent.tools.find(tool => tool.name === "gateway")).includes("web_search"), false, "never inside the gateway namespace");
    assert.equal(JSON.stringify(sent.input.find(item => item.type === "web_search_call")), JSON.stringify(webCall), "the replayed call goes upstream unchanged");
    const done = events(await (await h.post({ model: "codex/gpt-6.1-sol", input: [user("more")] })).text()).filter(event => event.type === "response.output_item.done").map(event => event.item);
    assert.deepEqual(done, [webCall]);
    assert.deepEqual(await h.dropped(), [], "the route forwards the tool, so nothing is dropped");
  } finally { await h.close(); }
});

test("a chat that switches from Codex 2 to Claude or a chat-completions route keeps working with the hosted search dropped", async t => {
  const h = await harness(t);
  try {
    for (const model of ["claude/upstream", "chat/upstream"]) {
      const response = await h.post({ model, input: [user("find it"), webCall, user("now use it")], tools: [exec, webTool] });
      assert.equal(response.status, 200, model);
      assert.equal(events(await response.text()).some(event => event.type === "response.completed"), true, model);
      const events2 = await h.post({ model, input: [{ type: "additional_tools", tools: [exec, webTool] }, user("hi")], tool_choice: { type: "web_search" } as unknown });
      assert.equal(events2.status, 200, model);
      await events2.text();
    }
    const chat = h.upstream[0] as Record<string, unknown>;
    assert.equal(JSON.stringify(chat).includes("web_search"), false, "the wire body carries nothing of the hosted tool or its item");
    const dropped = await h.dropped();
    assert.equal(dropped.length, 4, "one count per request that dropped something");
    assert.deepEqual(dropped.map(entry => [entry.provider, entry.tools, entry.items]), [["claude", 1, 1], ["claude", 1, 0], ["chat", 1, 1], ["chat", 1, 0]]);
    assert.equal(Object.keys(dropped[0]).filter(key => !["at", "host", "component", "pid", "event"].includes(key)).sort().join(","), "items,provider,tools", "exactly provider, tools and items: never a name or content");
    assert.equal(JSON.stringify(dropped).includes("fixture query"), false);
  } finally { await h.close(); }
});

test("every other hosted tool still fails on every route, before anything is dropped or sent", async t => {
  const h = await harness(t);
  try {
    for (const model of ["codex/gpt-6.1-sol", "claude/upstream", "chat/upstream"]) {
      const response = await h.post({ model, input: [user("hi")], tools: [{ type: "file_search" }, webTool] });
      assert.equal(response.status, 400, model);
    }
    assert.equal(h.upstream.length, 0, "nothing was sent upstream");
    assert.deepEqual(await h.dropped(), [], "a refused request records no drop");
  } finally { await h.close(); }
});
