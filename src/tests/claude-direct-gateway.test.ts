import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gatewayToken, validateConfig } from "../config.js";
import { bridgeRouteName, stableRouteNumber } from "../claude-desktop-profile.js";
import { startGateway } from "../server.js";
import type { Provider } from "../providers/provider.js";
import { readEvents } from "../protocol/sse.js";
import type { InferenceEvent, ResponsesRequest, WireEvent } from "../protocol/types.js";

const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
const opaque = (alias: string) => `claude-hg-route-${stableRouteNumber(alias)}`;
const bridge = bridgeRouteName("codex/gpt");
const input = { max_tokens: 64, messages: [{ role: "user", content: "hello" }] };
type Seen = { provider: string; request: ResponsesRequest };

/** A gateway with one account of each kind; every provider records what reached it and replies from `reply`. */
async function fixture(reply: (seen: Seen) => InferenceEvent[] = () => [{ type: "text", text: "ok" }]) {
  const state = await mkdtemp(join(tmpdir(), "gateway-claude-direct-"));
  const config = validateConfig({ version: 1, port: 0, stateDirectory: state, providers: [
    { id: "codex", type: "codex-subscription", label: "Codex", credentialFile: join(state, "unused"), models: { "codex/gpt": "gpt-x" },
      modelMetadata: { "codex/gpt": { displayName: "GPT X", contextWindow: 272000, reasoningEfforts: ["low", "medium", "high"] } } },
    { id: "claude", type: "claude-subscription", label: "Claude", models: { "claude/claude-fable-5-1": "claude-fable-5-1" } },
    { id: "qwen", type: "chat-completions-api", label: "Local", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "TEST_UNUSED_KEY", models: { "qwen/flash": "qwen-flash" } },
  ] });
  const seen: Seen[] = [];
  const server = await startGateway(config, provider => ({ async *infer(request) {
    const entry = { provider: provider.id, request }; seen.push(entry);
    yield* reply(entry); yield { type: "done", usage };
  } }) as Provider, undefined, { onFailure() {}, claudeNativeReview: false });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = await gatewayToken(state);
  const bearer = { Authorization: `Bearer ${token}` };
  return { seen, base, token, bearer,
    get: (path: string, headers: Record<string, string> = { ...bearer, "anthropic-version": "2023-06-01" }) => fetch(base + path, { headers }),
    post: (body: unknown, path = "/v1/messages") => fetch(base + path, { method: "POST", headers: { ...bearer, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test("an Anthropic client reads Claude-safe rows while other clients keep the alias list", async () => {
  const gateway = await fixture();
  try {
    const list = await gateway.get("/v1/models");
    assert.equal(list.status, 200); assert.ok(list.headers.get("request-id"));
    const body = await list.json() as any;
    assert.equal(body.type, "list");
    assert.deepEqual(body.data.map((row: any) => [row.id, row.display_name]), [["claude-fable-5-1", "Claude · claude-fable-5-1"], [opaque("codex/gpt"), "Codex · GPT X"], [opaque("qwen/flash"), "Local · qwen-flash"]]);
    assert.equal(body.data[1].gatefox.bridge_id, bridge);
    assert.ok(body.data.every((row: any) => !/gpt|qwen/i.test(row.id)));
    // The key header alone also marks an Anthropic client.
    const keyed = await gateway.get("/v1/models", { "x-api-key": gateway.token });
    assert.equal(keyed.status, 200); assert.equal((await keyed.json() as any).type, "list");
    const plain = await (await gateway.get("/v1/models", gateway.bearer)).json() as any;
    assert.equal(plain.object, "list"); assert.deepEqual(plain.data.map((row: any) => row.id), ["codex/gpt", "claude/claude-fable-5-1", "qwen/flash"]);
    for (const id of [bridge, opaque("codex/gpt"), "claude-fable-5-1"]) {
      const detail = await gateway.get(`/v1/models/${encodeURIComponent(id)}`);
      assert.equal(detail.status, 200, id); assert.equal((await detail.json() as any).id, id);
    }
    for (const id of ["codex%2Fgpt", "missing", "%E0%A4%A"]) {
      const missing = await gateway.get(`/v1/models/${id}`);
      assert.equal(missing.status, 404, id); assert.equal((await missing.json() as any).error.type, "not_found_error");
    }
    const refused = await gateway.get("/v1/models", { "x-api-key": "wrong", "anthropic-version": "2023-06-01" });
    assert.equal(refused.status, 401); assert.equal((await refused.json() as any).error.type, "authentication_error");
    assert.equal(gateway.seen.length, 0);
  } finally { await gateway.close(); }
});

test("a Claude-safe ID reaches its own alias with a clamped effort and answers under the ID the client named", async () => {
  const gateway = await fixture();
  try {
    const response = await gateway.post({ ...input, model: bridge, output_config: { effort: "max" }, thinking: { type: "adaptive" } });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.model, bridge); assert.equal(body.content[0].text, "ok");
    assert.equal(gateway.seen.length, 1);
    assert.equal(gateway.seen[0]!.provider, "codex"); assert.equal(gateway.seen[0]!.request.model, "gpt-x");
    assert.equal((gateway.seen[0]!.request.reasoning as any).effort, "high");
    const events: WireEvent[] = [];
    for await (const event of readEvents((await gateway.post({ ...input, model: opaque("qwen/flash"), stream: true })).body!)) events.push(event);
    assert.equal((events[0]!.message as any).model, opaque("qwen/flash")); assert.equal(events.at(-1)!.type, "message_stop");
    assert.equal(gateway.seen[1]!.provider, "qwen"); assert.equal(gateway.seen[1]!.request.model, "qwen-flash");
    // A native Claude ID keeps the gateway's bare-name routing.
    const native = await gateway.post({ ...input, model: "claude-fable-5-1" });
    assert.equal((await native.json() as any).model, "claude-fable-5-1");
    assert.equal(gateway.seen[2]!.provider, "claude"); assert.equal(gateway.seen[2]!.request.model, "claude-fable-5-1");
    // The IDs are a Messages spelling only, and an unknown one is still refused before any provider.
    const responses = await gateway.post({ model: bridge, input: "hello" }, "/v1/responses");
    assert.equal(responses.status, 404);
    const unknown = await gateway.post({ ...input, model: "claude-hg-route-1" });
    assert.equal(unknown.status, 404); assert.equal((await unknown.json() as any).error.type, "not_found_error");
    const counted = await gateway.post({ model: bridge, messages: input.messages }, "/v1/messages/count_tokens");
    assert.equal(counted.status, 501);
    assert.equal(gateway.seen.length, 3);
  } finally { await gateway.close(); }
});

test("optional tool properties are nullable for a Responses-backed route only, and the introduced nulls are removed", async () => {
  const tools = [{ name: "read", input_schema: { type: "object", required: ["path"], properties: { path: { type: "string" }, limit: { type: "integer" } } } }];
  const gateway = await fixture(() => [{ type: "tool", call: { type: "function", id: "call_1", function: { name: "read", arguments: JSON.stringify({ path: "a", limit: null }) } } }]);
  try {
    const converted = await (await gateway.post({ ...input, model: bridge, tools })).json() as any;
    assert.deepEqual(converted.content[0], { type: "tool_use", id: "call_1", name: "read", input: { path: "a" } });
    assert.deepEqual((gateway.seen[0]!.request.tools as any[])[0].parameters.properties.limit, { anyOf: [{ type: "integer" }, { type: "null" }] });
    const streamed: WireEvent[] = [];
    for await (const event of readEvents((await gateway.post({ ...input, model: opaque("codex/gpt"), tools, stream: true })).body!)) streamed.push(event);
    assert.equal((streamed.find(event => event.type === "content_block_delta")!.delta as any).partial_json, JSON.stringify({ path: "a" }));
    // The same alias under its own name, and a route that needs no conversion, pass tools and arguments through unchanged.
    for (const model of ["codex/gpt", opaque("qwen/flash")]) {
      const plain = await (await gateway.post({ ...input, model, tools })).json() as any;
      assert.deepEqual(plain.content[0].input, { path: "a", limit: null }, model);
      assert.deepEqual((gateway.seen.at(-1)!.request.tools as any[])[0].parameters.properties.limit, { type: "integer" }, model);
    }
  } finally { await gateway.close(); }
});
