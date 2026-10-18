import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ResponsesAPI } from "../providers/responses-api.js";
import type { ProviderConfig } from "../config.js";
import type { ResponsesRequest } from "../protocol/types.js";

const names = ["spawn_agent", "send_message", "followup_task"];
const encryptedMessage = (encrypted: unknown = true) => ({ type: "string", description: "caller message", encrypted });
const functionTool = (name: string, message: unknown = encryptedMessage()) => ({ type: "function", name, description: `${name} description`, parameters: {
  type: "object", description: "parameters", properties: { message, task: { type: "string", encrypted: true } }, required: ["message", "task"], additionalProperties: false,
} });
const namespace = (tools: unknown[], name = "collaboration") => ({ type: "namespace", name, description: "namespace description", tools });
const done = { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };

async function sent(t: TestContext, request: ResponsesRequest, configs: ProviderConfig[]): Promise<Record<string, unknown>[]> {
  const captured: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    captured.push(JSON.parse(String(options.body)) as Record<string, unknown>);
    return new Response(`data: ${JSON.stringify(done)}\n\n`);
  });
  for (const config of configs) {
    const provider = new ResponsesAPI(config);
    for await (const _ of provider.infer(request, new AbortController().signal)) { /* drain */ }
  }
  assert.equal(captured.length, configs.length);
  return captured;
}

async function providers(t: TestContext): Promise<ProviderConfig[]> {
  const key = "GATEWAY_COLLAB_SCHEMA_KEY";
  if (!Object.hasOwn(process.env, key)) { process.env[key] = "fixture-only"; t.after(() => { delete process.env[key]; }); }
  const directory = await mkdtemp(join(tmpdir(), "gateway-collaboration-schema-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  return [
    { id: "fixture", type: "responses-api", apiKeyEnv: key, baseUrl: "http://127.0.0.1:1", models: { fixture: "fixture" } } as ProviderConfig,
    { id: "codex", type: "codex-subscription", credentialFile, models: { fixture: "fixture" } } as ProviderConfig,
  ];
}

function messageSchema(tool: unknown): Record<string, unknown> {
  return ((tool as { parameters: { properties: { message: Record<string, unknown> } } }).parameters.properties.message);
}
function namespaceName(tool: unknown): string { return (tool as { name: string }).name; }

test("subscription schemas alias collaboration while ordinary Responses retain its namespace", async t => {
  const top = namespace(names.map(name => functionTool(name)));
  const lite = namespace(names.map(name => functionTool(name)));
  const request: ResponsesRequest = { model: "fixture", input: [{ type: "additional_tools", tools: [lite] } as never, { type: "message", role: "user", content: "go" }], tools: [top as never] };
  const original = structuredClone(request);
  const bodies = await sent(t, request, await providers(t));
  assert.deepEqual(request, original);
  for (const [index, body] of bodies.entries()) {
    const topTools = ((body.tools as Array<{ tools: unknown[] }>)[0].tools);
    const liteTools = ((((body.input as Array<{ tools?: Array<{ tools: unknown[] }> }>)[0].tools!)[0].tools));
    assert.equal(namespaceName((body.tools as unknown[])[0]), index ? "gateway_collaboration" : "collaboration");
    assert.equal(namespaceName(((body.input as Array<{ tools: unknown[] }>)[0].tools)[0]), index ? "gateway_collaboration" : "collaboration");
    for (const tools of [topTools, liteTools]) for (const tool of tools) {
      assert.equal(Object.hasOwn(messageSchema(tool), "encrypted"), false);
      assert.equal(messageSchema(tool).description, "caller message");
      assert.deepEqual((tool as { parameters: { required: string[]; properties: { task: Record<string, unknown> } } }).parameters.required, ["message", "task"]);
      assert.equal((tool as { parameters: { properties: { task: Record<string, unknown> } } }).parameters.properties.task.encrypted, true);
    }
  }
});

test("subscription aliases a collaboration result back to the caller namespace", async t => {
  const [_, subscription] = await providers(t);
  let outgoing: Record<string, unknown> | undefined;
  const completed = { type: "response.completed", response: { id: "r", status: "completed", output: [{ type: "function_call", id: "fc", call_id: "call", name: "spawn_agent", namespace: "gateway_collaboration", arguments: "{}", status: "completed" }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    outgoing = JSON.parse(String(options.body)) as Record<string, unknown>;
    return new Response(`data: ${JSON.stringify(completed)}\n\n`);
  });
  const events = [];
  for await (const event of new ResponsesAPI(subscription).infer({ model: "fixture", input: "go", tools: [namespace([functionTool("spawn_agent")]) as never] }, new AbortController().signal)) events.push(event);
  assert.equal(namespaceName((outgoing!.tools as unknown[])[0]), "gateway_collaboration");
  assert.deepEqual(events.find(event => event.type === "tool"), { type: "tool", call: { id: "call", type: "function", responseTool: { type: "function", namespace: "collaboration", name: "spawn_agent" }, function: { name: "spawn_agent", arguments: "{}" } } });
});

test("subscription aliases avoid every declared namespace and rewrite explicit collaboration replay", async t => {
  const [_, subscription] = await providers(t);
  const top = namespace([functionTool("spawn_agent")]);
  const collision = namespace([functionTool("top")], "gateway_collaboration");
  const liteCollision = namespace([functionTool("lite")], "gateway_collaboration_");
  const request: ResponsesRequest = {
    model: "fixture",
    input: [
      { type: "additional_tools", tools: [liteCollision] } as never,
      { type: "function_call", call_id: "call", name: "spawn_agent", namespace: "collaboration", arguments: "{}" },
      { type: "function_call_output", call_id: "call", name: "spawn_agent", namespace: "collaboration", output: "ok" },
      { type: "custom_tool_call", call_id: "custom", name: "custom", namespace: "collaboration", input: "literal input" },
      { type: "custom_tool_call_output", call_id: "custom", name: "custom", namespace: "collaboration", output: "literal output" },
    ],
    tools: [top as never, collision as never],
    tool_choice: { type: "function", namespace: "collaboration", name: "spawn_agent" },
  };
  const original = structuredClone(request);
  const [body] = await sent(t, request, [subscription]);
  assert.deepEqual(request, original);
  assert.equal(namespaceName((body.tools as unknown[])[0]), "gateway_collaboration__");
  const input = body.input as Array<Record<string, unknown>>;
  assert.equal(namespaceName((input[0].tools as unknown[])[0]), "gateway_collaboration_");
  assert.equal(input[1].namespace, "gateway_collaboration__");
  assert.equal(input[2].namespace, "gateway_collaboration__");
  const originalInput = original.input as Array<Record<string, unknown>>;
  assert.deepEqual(input[3], { ...originalInput[3], namespace: "gateway_collaboration__" });
  assert.deepEqual(input[4], { ...originalInput[4], namespace: "gateway_collaboration__" });
  assert.deepEqual(body.tool_choice, { type: "function", namespace: "gateway_collaboration__", name: "spawn_agent" });
});

test("outgoing schemas leave custom, unrelated, and lookalike declarations untouched", async t => {
  const exactPlain = functionTool("spawn_agent", encryptedMessage(false));
  const tools = [
    namespace([functionTool("spawn_agent_now"), { type: "custom", name: "spawn_agent", description: "custom" }]),
    namespace([functionTool("spawn_agent")], "collaboration_extra"),
    { type: "function", name: "spawn_agent", parameters: { properties: { message: encryptedMessage() } } },
    namespace([exactPlain]),
  ];
  const [body] = await sent(t, { model: "fixture", input: "go", tools: tools as never[] }, [(await providers(t))[0]]);
  const sentTools = body.tools as Array<{ name?: string; tools?: unknown[] }>;
  assert.equal(messageSchema(sentTools[0].tools![0]).encrypted, true);
  assert.equal(messageSchema(sentTools[1].tools![0]).encrypted, true);
  assert.equal(((sentTools[2] as { parameters: { properties: { message: Record<string, unknown> } } }).parameters.properties.message).encrypted, true);
  assert.equal(Object.hasOwn(messageSchema(sentTools[3].tools![0]), "encrypted"), false, "the exact function is plaintext even if a caller supplied false");
});
