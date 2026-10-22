import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayToken, validateConfig } from "../config.js";
import { createProvider, startGateway } from "../server.js";

// Fixture values only. The shapes follow what the native Codex engine sends and receives.
const searchTool = { type: "tool_search", execution: "client", description: "Search deferred tools", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false } };
const searchCall = { type: "tool_search_call", call_id: "call_s1", execution: "client", status: "completed", arguments: { query: "fixture query" } };
const searchOutput = { type: "tool_search_output", call_id: "call_s1", execution: "client", status: "completed",
  tools: [{ type: "namespace", name: "mcp__fixture__", description: "Deferred", tools: [{ type: "function", name: "lookup", description: "d", defer_loading: true, parameters: { type: "object", properties: {} } }] }] };
const user = (text: string) => ({ type: "message", role: "user", content: text });
const lite = { type: "additional_tools", tools: [searchTool] };
const emitted = { type: "tool_search_call", id: "ts_1", call_id: "call_s2", execution: "client", status: "completed", arguments: { query: "other fixture query" } };
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const upstreamStream = [{ type: "response.output_item.done", output_index: 0, item: emitted },
  { type: "response.completed", response: { id: "r", status: "completed", output: [emitted], usage } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");

/** A gateway with the Codex route on a mocked upstream and one provider of every other type that rejects search. */
async function harness(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-tool-search-server-"));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  process.env.TOOL_SEARCH_SERVER_KEY = "fixture-only";
  const realFetch = globalThis.fetch; const upstream: Array<Record<string, unknown>> = [];
  // The client sees a generic invalid_request; the reason and item type go to the failure diagnostic, which is captured here.
  const failures: Array<{ providerId?: string; reason?: string; itemType?: string }> = [];
  t.mock.method(console, "error", (line: unknown) => { try { failures.push(JSON.parse(String(line))); } catch { /* not a diagnostic */ } });
  // Only the provider's upstream call is mocked; requests to the gateway itself go through.
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    const target = String(url);
    if (!target.startsWith("http://127.0.0.1:1/") && !target.startsWith("https://api.openai.com/")) return realFetch(url, options);
    upstream.push(JSON.parse(String(options?.body)));
    return new Response(upstreamStream, { headers: { "Content-Type": "text/event-stream" } });
  });
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, maxConcurrent: 2, providers: [
    { id: "codex", type: "codex-subscription", credentialFile, models: { "codex/gpt-6.1-sol": "gpt-6.1-sol" } },
    { id: "api", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "TOOL_SEARCH_SERVER_KEY", models: { "api/upstream": "upstream" } },
    { id: "chat", type: "chat-completions-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "TOOL_SEARCH_SERVER_KEY", models: { "chat/upstream": "upstream" } },
    { id: "claude", type: "claude-subscription", models: { "claude/upstream": "upstream" } },
    { id: "copilot", type: "copilot-subscription", models: { "copilot/upstream": "upstream" } },
  ] });
  let stubbed = 0;
  // Claude and Copilot would start a CLI; the stub proves the request never reaches them.
  const factory = (provider: Parameters<typeof createProvider>[0]) => provider.type === "claude-subscription" || provider.type === "copilot-subscription"
    ? { async *infer() { stubbed++; yield { type: "done" as const, usage }; } } : createProvider(provider);
  const server = await startGateway(config, factory);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/responses`;
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  const post = (body: Record<string, unknown>) => fetch(url, { method: "POST", headers, body: JSON.stringify({ stream: true, ...body }) });
  const close = async () => {
    delete process.env.TOOL_SEARCH_SERVER_KEY;
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    await rm(directory, { recursive: true, force: true });
  };
  return { post, upstream, failures, stubbed: () => stubbed, close };
}
const events = (text: string) => text.split("\n\n").flatMap(block => block.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as Record<string, any>));
const failure = async (response: Response) => ({ status: response.status, body: (await response.json() as { error: { code?: string } }).error });

const exec = { type: "function", name: "exec_command", description: "Run", parameters: { type: "object", properties: { cmd: { type: "string" } } } };

const hasSearch = (value: unknown) => JSON.stringify(value).includes("tool_search");

test("the Codex route drops a top-level tool_search, completes the turn, and streams an upstream tool_search_call back unchanged", async t => {
  const h = await harness(t);
  try {
    const top = await h.post({ model: "codex/gpt-6.1-sol", input: [user("find it")], tools: [exec, searchTool] });
    assert.equal(top.status, 200);
    const sent = h.upstream[0] as { tools: Array<Record<string, unknown>> };
    assert.equal(hasSearch(sent.tools), false, "the ChatGPT backend refuses a forwarded tool_search, so none is sent");
    assert.equal(JSON.stringify(sent.tools.flatMap(tool => (tool.tools as Array<{ name: string }> | undefined) ?? []).map(tool => tool.name)), JSON.stringify(["exec_command"]), "the other tools are unchanged");
    const received = events(await top.text());
    assert.equal(received.some(event => event.type === "response.completed"), true, "the turn completes");
    const done = received.filter(event => event.type === "response.output_item.done").map(event => event.item);
    assert.deepEqual(done, [emitted]);
    assert.equal(JSON.stringify(done[0]), JSON.stringify(emitted));
    // Search is the only thing dropped: another unsupported tool still fails on the Codex route, and nothing else reaches upstream.
    assert.equal((await failure(await h.post({ model: "codex/gpt-6.1-sol", input: [user("hi")], tools: [{ type: "file_search" }] }))).status, 400);
    assert.equal(h.upstream.length, 1);
  } finally { await h.close(); }
});

test("the Codex route drops tool_search from a Responses lite additional_tools item, keeps its other tools and the tool choice, and completes the turn", async t => {
  const h = await harness(t);
  try {
    const both = { type: "additional_tools", tools: [searchTool, exec] };
    const response = await h.post({ model: "codex/gpt-6.1-sol", input: [both, lite, user("hi")], tool_choice: "required" });
    assert.equal(response.status, 200);
    assert.equal(events(await response.text()).some(event => event.type === "response.completed"), true);
    const sent = h.upstream[0] as { input: unknown[]; tool_choice: unknown };
    assert.equal(hasSearch(sent.input), false);
    // An item left with only the search tool goes away; one with other tools keeps them in order.
    assert.equal(JSON.stringify(sent.input), JSON.stringify([{ type: "additional_tools", tools: [exec] }, user("hi")]));
    assert.equal(sent.tool_choice, "required", "the caller's tool choice is not changed");
  } finally { await h.close(); }
});

test("the Codex route drops replayed tool_search_call and tool_search_output items, also for a sub-agent's bare model name, and completes the turn", async t => {
  const h = await harness(t);
  try {
    const input = [user("find it"), searchCall, searchOutput, user("now use it")];
    // The bare vendor name from a sub-agent resolves to the same route.
    for (const [index, model] of ["codex/gpt-6.1-sol", "gpt-6.1-sol"].entries()) {
      const response = await h.post({ model, input, tools: [searchTool] });
      assert.equal(response.status, 200, model);
      assert.equal(events(await response.text()).some(event => event.type === "response.completed"), true, model);
      const sent = h.upstream[index] as { input: unknown[]; tools?: unknown[] };
      assert.equal(JSON.stringify(sent.input), JSON.stringify([user("find it"), user("now use it")]), model);
      assert.equal(hasSearch(sent), false, model);
      assert.deepEqual(sent.tools, [], model);
    }
  } finally { await h.close(); }
});

test("a generic Responses route, a chat-completions route, Claude and Copilot drop search, keep the tools it loaded, and send no search upstream", async t => {
  const h = await harness(t);
  try {
    // A chat that switched here from a Codex route, possibly one that bridges search, must keep working.
    const cases: Array<[string, Record<string, unknown>]> = [
      ["tool", { input: [user("hi")], tools: [exec, searchTool] }],
      ["lite additional_tools", { input: [{ type: "additional_tools", tools: [exec, searchTool] }, user("hi")] }],
      ["history", { input: [user("hi"), searchCall, searchOutput, user("use it")], tools: [exec] }],
    ];
    const translation = new Set(["unsupported_tool", "unsupported_input_item", "unsupported_tool_choice"]);
    for (const [provider, model] of [["api", "api/upstream"], ["chat", "chat/upstream"], ["claude", "claude/upstream"], ["copilot", "copilot/upstream"]]) {
      for (const [name, body] of cases) {
        const before = h.upstream.length; const failed = h.failures.length;
        await (await h.post({ model, ...body })).text();
        assert.ok(!h.failures.slice(failed).some(entry => translation.has(String(entry.reason))), `${model}: ${name} translates`);
        if (provider !== "api" && provider !== "chat") continue;
        assert.equal(h.upstream.length, before + 1, `${model}: ${name} reached upstream`);
        const sent = h.upstream.at(-1)!;
        assert.equal(hasSearch(sent), false, `${model}: ${name} sends no search upstream`);
        // A chat-completions route renames tools to its own native names, so it is checked by count: exec_command and the loaded lookup.
        if (name === "history") assert.ok(provider === "chat" ? (sent.tools as unknown[]).length === 2 : JSON.stringify(sent).includes("lookup"), `${model}: the tool the search loaded stays declared`);
      }
    }
    assert.equal(h.stubbed(), 6, "Claude and Copilot each ran all three requests");
  } finally { await h.close(); }
});
