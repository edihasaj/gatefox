import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResponsesAPI } from "../providers/responses-api.js";
import { maxTurnStateLength, type InferenceContext } from "../providers/provider.js";
import { reasoningScope } from "../protocol/reasoning-state.js";
import { maxUpstreamTurnStateLength, unwrapTurnState, wrapTurnState } from "../protocol/turn-state.js";
import type { InferenceEvent } from "../protocol/types.js";
import type { ProviderConfig } from "../config.js";

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const sse = (...frames: unknown[]) => frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("");
const completed = sse({ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: { status: "completed", usage } });
const serverError = sse({ type: "response.failed", response: { error: { code: "server_error", message: "private" } } });
type Reply = { status?: number; body: string; turnState?: string };

async function fixture(t: TestContext, replies: (attempt: number) => Reply) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-turn-state-test-"));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  const sent: Array<string | undefined> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    sent.push((options.headers as Record<string, string>)["x-codex-turn-state"]);
    const reply = replies(sent.length);
    return new Response(reply.body, { status: reply.status ?? 200, headers: { "Content-Type": reply.status ? "application/json" : "text/event-stream", ...(reply.turnState ? { "x-codex-turn-state": reply.turnState } : {}) } });
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config: ProviderConfig = { id: "codex", type: "codex-subscription", credentialFile, models: { "codex/upstream": "upstream" } };
  const provider = new ResponsesAPI(config);
  const collect = async (context: InferenceContext = {}) => {
    const events: InferenceEvent[] = [];
    for await (const event of provider.infer({ model: "upstream", input: "fixture" }, new AbortController().signal, context)) events.push(event);
    return events;
  };
  return { provider, collect, sent, scope: reasoningScope(config) };
}

test("turn-state wrapping is scoped to one account route and always fits the inbound limit", () => {
  const scope = "a".repeat(64), other = "b".repeat(64);
  const wrapped = wrapTurnState("upstream-state", scope)!;
  assert.match(wrapped, /^gts1:a{16}:/); assert.equal(unwrapTurnState(wrapped, scope), "upstream-state");
  assert.equal(unwrapTurnState(wrapped, other), undefined);
  const longest = wrapTurnState("x".repeat(maxUpstreamTurnStateLength), scope)!;
  assert.ok(longest.length <= maxTurnStateLength); assert.equal(unwrapTurnState(longest, scope), "x".repeat(maxUpstreamTurnStateLength));
  for (const value of ["", "has space", "line\nbreak", "x".repeat(maxUpstreamTurnStateLength + 1), undefined, null]) assert.equal(wrapTurnState(value, scope), undefined);
  const prefix = `gts1:${scope.slice(0, 16)}:`;
  for (const value of [prefix, `${prefix}!!!`, `${prefix}${Buffer.from("value").toString("base64")}=`, `${prefix}${Buffer.from("two words").toString("base64url")}`,
    `${prefix}${Buffer.from([0xff, 0xfe]).toString("base64url")}`, `gws1:${scope.slice(0, 16)}:${Buffer.from("value").toString("base64url")}`, "raw-upstream-value",
    `${prefix}${"A".repeat(maxTurnStateLength)}`]) assert.equal(unwrapTurnState(value, scope), undefined);
});

test("the upstream turn-state returns once as a wrapped transport event before any output", async t => {
  const f = await fixture(t, () => ({ body: completed, turnState: "sticky-backend-1" }));
  const events = await f.collect();
  assert.deepEqual(events[0], { type: "transport", turnState: wrapTurnState("sticky-backend-1", f.scope) });
  assert.equal(events.filter(event => event.type === "transport").length, 1);
  assert.deepEqual(events.slice(1).map(event => event.type), ["text", "message-done", "done"]);
});

test("the transport event still opens the response when the upstream returns no or an unusable turn-state", async t => {
  for (const turnState of [undefined, "x".repeat(maxUpstreamTurnStateLength + 1)]) {
    const f = await fixture(t, () => ({ body: completed, turnState }));
    const events = await f.collect();
    assert.deepEqual(events[0], { type: "transport" }); assert.equal(events.filter(event => event.type === "transport").length, 1);
    t.mock.restoreAll();
  }
});

test("a wrapped turn-state from the caller is sent upstream unwrapped", async t => {
  const f = await fixture(t, () => ({ body: completed }));
  await f.collect({ turnState: wrapTurnState("sticky-backend-1", f.scope) });
  assert.deepEqual(f.sent, ["sticky-backend-1"]);
});

test("a foreign, unwrapped, or malformed turn-state is dropped without failing the request", async t => {
  const f = await fixture(t, () => ({ body: completed }));
  const prefix = `gts1:${f.scope.slice(0, 16)}:`;
  for (const turnState of [wrapTurnState("other-account", "f".repeat(64))!, "sticky-backend-1", `${prefix}not*base64`, `${prefix}${Buffer.from("a b").toString("base64url")}`]) {
    const events = await f.collect({ turnState });
    assert.equal(events.at(-1)?.type, "done");
  }
  assert.deepEqual(f.sent, [undefined, undefined, undefined, undefined]);
});

test("third-party Responses routes neither send a turn-state nor emit transport events", async t => {
  const seen: Array<Record<string, string>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    seen.push({ ...(options.headers as Record<string, string>) });
    return new Response(completed, { headers: { "Content-Type": "text/event-stream", "x-codex-turn-state": "upstream-state" } });
  });
  const config: ProviderConfig = { id: "api", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "GATEWAY_TURN_STATE_FIXTURE_KEY", models: { fixture: "upstream" } };
  const provider = new ResponsesAPI(config);
  assert.equal(provider.emitsTransport, false);
  process.env.GATEWAY_TURN_STATE_FIXTURE_KEY = "fixture-only";
  try {
    const events: InferenceEvent[] = [];
    for await (const event of provider.infer({ model: "upstream", input: "fixture" }, new AbortController().signal, { turnState: wrapTurnState("value", reasoningScope(config)) })) events.push(event);
    assert.equal(seen[0]["x-codex-turn-state"], undefined); assert.ok(!events.some(event => event.type === "transport"));
  } finally { delete process.env.GATEWAY_TURN_STATE_FIXTURE_KEY; }
});

test("a transport event before a transient failure still retries once, without a second transport event", async t => {
  const f = await fixture(t, attempt => attempt === 1 ? { body: serverError, turnState: "sticky-backend-1" } : { body: completed, turnState: "sticky-backend-2" });
  assert.equal(f.provider.emitsTransport, true);
  const events = await f.collect();
  assert.deepEqual(events.filter(event => event.type === "transport"), [{ type: "transport", turnState: wrapTurnState("sticky-backend-1", f.scope) }]);
  assert.deepEqual(events.filter(event => event.type === "text").map(event => event.text), ["ok"]);
  // The retry belongs to the same turn, so it carries the turn-state the caller was given.
  assert.deepEqual(f.sent, [undefined, "sticky-backend-1"]);
});

test("an HTTP failure before any response head lets the retry supply the only transport event", async t => {
  const f = await fixture(t, attempt => attempt === 1 ? { status: 503, body: JSON.stringify({ error: { code: "server_error" } }) } : { body: completed, turnState: "sticky-backend-2" });
  const events = await f.collect({ turnState: wrapTurnState("sticky-backend-1", "f".repeat(64)) });
  assert.deepEqual(events.filter(event => event.type === "transport"), [{ type: "transport", turnState: wrapTurnState("sticky-backend-2", f.scope) }]);
  assert.deepEqual(f.sent, [undefined, undefined]);
});
