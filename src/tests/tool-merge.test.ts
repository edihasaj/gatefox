import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredResponsesTools, responsesToChatRequest } from "../protocol/request.js";
import { ResponsesAPI } from "../providers/responses-api.js";
import type { ProviderConfig } from "../config.js";
import type { ResponsesRequest } from "../protocol/types.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

// Fixture values only. A long chat can declare the same tool again in a later additional_tools item or in the current tool list.
const fn = (name: string, description: string) => ({ type: "function", name, description, parameters: { type: "object", properties: {} } });
const lite = (...tools: unknown[]) => ({ type: "additional_tools", tools });
const make = (input: unknown[], tools?: unknown[]) => ({ model: "m", input, ...(tools ? { tools } : {}) }) as unknown as ResponsesRequest;
const described = (request: ResponsesRequest) => responsesToChatRequest(request).tools!.map(tool => [tool.function.name, tool.function.description]);

async function withTelemetry<T>(t: test.TestContext, run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-merge-"));
  configureTelemetry(directory, "test");
  t.after(async () => { await flushTelemetry(); await rm(directory, { recursive: true, force: true }); });
  return run(directory);
}
async function merged(directory: string) { await flushTelemetry(); return (await readTelemetry(directory, 0)).filter(event => event.event === "tool_declarations_merged"); }

test("a history declaration and a top-level one for the same tool merge, and the top level wins", async t => {
  await withTelemetry(t, async directory => {
    const request = make([lite(fn("exec", "from history")), { type: "message", role: "user", content: "go" }], [fn("exec", "current")]);
    assert.deepEqual(described(request), [["exec", "current"]]);
    assert.equal((await merged(directory)).length, 0, "translating reports nothing unless the caller asks");
    assert.deepEqual(responsesToChatRequest(request, { reportMerges: true }).tools!.map(tool => tool.function.description), ["current"]);
    const events = await merged(directory);
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].replaced, events[0].identical], [1, 0]);
  });
});

test("when two history items declare a tool, the later item wins", () => {
  assert.deepEqual(described(make([lite(fn("exec", "first"), fn("other", "kept")), lite(fn("exec", "second"))])), [["exec", "second"], ["other", "kept"]]);
});

test("an identical duplicate is dropped without an error and is counted", async t => {
  await withTelemetry(t, async directory => {
    const same = fn("exec", "same");
    const request = make([lite({ ...same }), lite({ parameters: same.parameters, description: "same", name: "exec", type: "function" })], [same]);
    assert.deepEqual(responsesToChatRequest(request, { reportMerges: true }).tools!.map(tool => [tool.function.name, tool.function.description]), [["exec", "same"]]);
    const events = await merged(directory);
    assert.deepEqual([events[0].replaced, events[0].identical], [0, 2], "key order does not make a definition differ");
  });
});

test("a repeated name inside one list merges with the last entry winning and is counted", async t => {
  await withTelemetry(t, async directory => {
    const request = make([lite(fn("a", "one"), fn("a", "two"))], [fn("b", "one"), fn("b", "two"), fn("b", "two")]);
    assert.deepEqual(responsesToChatRequest(request, { reportMerges: true }).tools!.map(tool => [tool.function.name, tool.function.description]), [["b", "two"], ["a", "two"]]);
    const events = await merged(directory);
    assert.deepEqual([events[0].replaced, events[0].identical], [2, 1]);
  });
});

test("the telemetry event carries counts only and nothing is recorded without a merge", async t => {
  await withTelemetry(t, async directory => {
    responsesToChatRequest(make([lite(fn("secret_tool_name", "private description"))], [fn("secret_tool_name", "other private text")]), { reportMerges: true });
    responsesToChatRequest(make([], [fn("alone", "x")]), { reportMerges: true });
    const events = await merged(directory);
    assert.equal(events.length, 1);
    assert.deepEqual(Object.keys(events[0]).filter(key => !["at", "host", "component", "pid", "event"].includes(key)).sort(), ["identical", "replaced"]);
    assert.equal(JSON.stringify(events[0]).includes("secret_tool_name"), false);
    assert.equal(JSON.stringify(events[0]).includes("private"), false);
  });
});

test("namespace tools with the same local name in different namespaces stay distinct, and one namespace merges per tool", () => {
  const space = (name: string, description: string, ...tools: unknown[]) => ({ type: "namespace", name, description, tools });
  const request = make([lite(space("mcp__a", "A", fn("lookup", "a-old"), fn("only_old", "kept")))],
    [space("mcp__a", "A", fn("lookup", "a-new")), space("mcp__b", "B", fn("lookup", "b"))]);
  assert.deepEqual(described(request), [["mcp__a.lookup", "A\na-new"], ["mcp__a.only_old", "A\nkept"], ["mcp__b.lookup", "B\nb"]]);
  // The default `functions` namespace is the same tool as a top-level one.
  assert.deepEqual(described(make([lite(space("functions", "F", fn("exec", "old")))], [fn("exec", "new")])), [["exec", "new"]]);
});

test("other typed tools merge by type and malformed declarations are still reported", () => {
  const search = (description: string) => ({ type: "tool_search", description });
  const declared = declaredResponsesTools(make([lite(search("old"))], [search("new")]));
  assert.deepEqual(declared, [search("new")]);
  const reason = (request: ResponsesRequest) => { try { responsesToChatRequest(request); } catch (error) { return (error as { reason: string }).reason; } return "none"; };
  assert.equal(reason(make([], [fn("ok", "x"), { type: "function" }, { type: "function" }])), "invalid_shape");
  assert.equal(reason(make([], [{ type: "namespace", name: "a", tools: [] }, { type: "namespace", name: "b", tools: "no" }])), "unsupported_tool");
  assert.equal(reason(make([lite(fn("ok", "x"))], "nope" as unknown as unknown[])), "invalid_shape");
});

test("replayed function calls still map to the tool identity of the merged catalog", () => {
  const space = { type: "namespace", name: "storage", description: "S", tools: [fn("fetch", "get")] };
  const request = make([lite(space), lite(space),
    { type: "function_call", name: "fetch", namespace: "storage", arguments: "{}", call_id: "one" },
    { type: "function_call_output", call_id: "one", output: "proof" },
    { type: "function_call", name: "exec", arguments: "{}", call_id: "two" }, { type: "function_call_output", call_id: "two", output: "ok" }],
    [fn("exec", "run")]);
  const compiled = responsesToChatRequest({ ...request, tool_choice: { type: "function", namespace: "storage", name: "fetch" } });
  assert.deepEqual(compiled.tools!.map(tool => tool.function.responseTool), [{ type: "function", name: "exec" }, { type: "function", name: "fetch", namespace: "storage" }]);
  assert.deepEqual(compiled.messages.filter(message => message.role === "tool").map(message => message.name), ["storage.fetch", "exec"]);
  assert.deepEqual(compiled.tool_choice, { type: "function", function: { name: "storage.fetch" } });
});

test("the Codex route sends a repeated declaration upstream unchanged and does not refuse it", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-merge-route-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    bodies.push(JSON.parse(String(options.body)) as Record<string, unknown>);
    const done = { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
    return new Response(`data: ${JSON.stringify(done)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  });
  const provider = new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, models: { "codex/upstream": "upstream" } } as unknown as ProviderConfig);
  const history = [lite(fn("exec", "old")), { type: "message", role: "user", content: "go" }];
  const events = [];
  for await (const event of provider.infer({ ...make(history, [fn("exec", "new")]), model: "upstream", stream: true }, new AbortController().signal)) events.push(event);
  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(bodies[0].input, history, "history items go up as the client sent them");
});

test("on the Codex route a call resolves against the list it was declared in when a tool changed type", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-merge-type-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  let call: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async () => {
    const done = { type: "response.completed", response: { id: "r", status: "completed", output: [call], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
    return new Response(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: call })}\n\ndata: ${JSON.stringify(done)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  });
  const provider = new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, models: { "codex/upstream": "upstream" } } as unknown as ProviderConfig);
  const request = { ...make([lite(fn("edit", "history function"))], [{ type: "custom", name: "edit", description: "current custom" }]), model: "upstream", stream: true };
  const identities = async (item: Record<string, unknown>) => {
    call = item; const found: unknown[] = [];
    for await (const event of provider.infer(request, new AbortController().signal)) if (event.type === "tool") found.push(event.call.responseTool);
    return found;
  };
  // Top-level tools are sent in the gateway namespace; additional_tools tools are called bare.
  assert.deepEqual(await identities({ type: "custom_tool_call", call_id: "c1", name: "edit", namespace: "gateway", input: "x" }), [{ type: "custom", name: "edit" }]);
  assert.deepEqual(await identities({ type: "function_call", call_id: "c2", name: "edit", arguments: "{}" }), [{ type: "function", name: "edit" }]);
});
