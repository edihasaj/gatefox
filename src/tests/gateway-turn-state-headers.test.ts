import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { startGateway } from "../server.js";
import { ProviderError, type InferenceContext, type Provider } from "../providers/provider.js";
import { readEvents } from "../protocol/sse.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { InferenceEvent, WireEvent } from "../protocol/types.js";

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const echoed = "gts1:fixture-echoed-turn-state";
async function setup(provider: Provider, maxConcurrent = 4, heartbeatMs = 5000) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-turn-state-"));
  configureTelemetry(directory, "server");
  const config: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, timeoutMs: 10000, maxConcurrent,
    providers: [{ id: "fixture", type: "codex-subscription", models: { alias: "upstream" } }] };
  const server = await startGateway(config, () => provider, undefined, { heartbeatMs, onFailure: () => {} });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  const post = async (body: Record<string, unknown> = {}, extra: Record<string, string> = {}) => {
    const started = Date.now();
    const response = await fetch(`${url}/v1/responses`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify({ model: "alias", input: "hello", stream: true, ...body }) });
    return { response, headMs: Date.now() - started };
  };
  const telemetry = async (event: string) => { await flushTelemetry(); return (await readTelemetry(directory, Date.now() - 60000)).filter(entry => entry.event === event); };
  return { post, telemetry, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await flushTelemetry(); await rm(directory, { recursive: true, force: true }); } };
}
async function collect(response: Response) { const events: WireEvent[] = []; for await (const event of readEvents(response.body!)) events.push(event); return events; }
const errorCode = (event: WireEvent) => ((event.response as { error: { code: string } }).error).code;

test("a transport event puts the turn-state in the SSE head before response.created", { timeout: 10000 }, async () => {
  const seen: InferenceContext[] = [];
  const gateway = await setup({ emitsTransport: true, async *infer(_request, _signal, context) {
    seen.push(context!); await delay(50);
    yield { type: "transport", turnState: "gts1:fixture-returned" }; yield { type: "text", text: "answer" }; yield { type: "done", usage };
  } });
  try {
    const { response } = await gateway.post({ client_metadata: { "x-codex-turn-metadata": JSON.stringify({ turn_id: "turn-1", request_kind: "turn" }) } }, { "x-codex-turn-state": echoed });
    assert.equal(response.status, 200); assert.equal(response.headers.get("x-codex-turn-state"), "gts1:fixture-returned");
    const events = await collect(response);
    assert.equal(events[0].type, "response.created"); assert.equal(events.at(-1)!.type, "response.completed");
    assert.ok(!JSON.stringify(events).includes("fixture-returned"), "a transport event is never output");
    assert.equal(seen[0].turnState, echoed); assert.equal(seen[0].turnId, "turn-1", "the context also reads the request body");
    const [completed] = await gateway.telemetry("request_completed");
    assert.equal(completed.events, 2, "the transport event is not counted");
    assert.equal(completed.turnStateEchoed, true); assert.equal(completed.turnStateReturned, true);
    assert.ok(!JSON.stringify(await gateway.telemetry("request_completed")).includes("fixture-returned"));
  } finally { await gateway.close(); }
});

test("a turn-state that arrives after 2.5 s still reaches the SSE head", { timeout: 10000 }, async () => {
  // Live upstream heads took 1.5 to 4.7 s; a head opened without the value loses it for the rest of the turn.
  const gateway = await setup({ emitsTransport: true, async *infer(_request, signal) {
    await delay(2500, undefined, { signal });
    yield { type: "transport", turnState: "gts1:slow-head" }; yield { type: "text", text: "answer" }; yield { type: "done", usage };
  } });
  try {
    const { response, headMs } = await gateway.post();
    assert.ok(headMs >= 2450, `the head waited for the provider (${headMs} ms)`);
    assert.equal(response.headers.get("x-codex-turn-state"), "gts1:slow-head");
    assert.equal((await collect(response)).at(-1)!.type, "response.completed");
    const [completed] = await gateway.telemetry("request_completed");
    assert.equal(completed.turnStateReturned, true);
  } finally { await gateway.close(); }
});

test("without a transport event the head opens one heartbeat interval after admission, without a turn-state", { timeout: 10000 }, async () => {
  const gateway = await setup({ emitsTransport: true, async *infer(_request, signal) {
    await delay(4000, undefined, { signal });
    yield { type: "transport", turnState: "gts1:too-late" }; yield { type: "text", text: "answer" }; yield { type: "done", usage };
  } }, 4, 3000);
  try {
    const { response, headMs } = await gateway.post();
    assert.ok(headMs >= 2950 && headMs < 3900, `the head waited for the heartbeat ceiling, not the provider (${headMs} ms)`);
    assert.equal(response.headers.get("x-codex-turn-state"), null);
    const events = await collect(response);
    assert.equal(events[0].type, "response.created"); assert.equal(events.at(-1)!.type, "response.completed");
    const [completed] = await gateway.telemetry("request_completed");
    assert.equal(completed.turnStateEchoed, false); assert.equal(completed.turnStateReturned, false);
  } finally { await gateway.close(); }
});

test("a queued request opens its head at once instead of waiting for a turn-state", { timeout: 10000 }, async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  const gateway = await setup({ emitsTransport: true, async *infer() {
    if (++calls === 1) { yield { type: "transport" }; await held; }
    else yield { type: "transport", turnState: "gts1:after-queue" };
    yield { type: "text", text: "answer" }; yield { type: "done", usage };
  } }, 1);
  try {
    const first = await gateway.post(); assert.equal(first.response.status, 200);
    const queued = await gateway.post();
    assert.ok(queued.headMs < 1000, `a queued request does not wait for a turn-state (${queued.headMs} ms)`);
    assert.equal(queued.response.headers.get("x-codex-turn-state"), null, "a head already sent cannot carry a later turn-state");
    assert.equal(calls, 1, "the queued provider has not started");
    release();
    for (const result of await Promise.all([collect(first.response), collect(queued.response)])) assert.equal(result.at(-1)!.type, "response.completed");
    assert.equal(calls, 2);
  } finally { release(); await gateway.close(); }
});

test("a provider that fails before any event still gives a 200 stream with response.failed", { timeout: 10000 }, async () => {
  const gateway = await setup({ emitsTransport: true, async *infer(): AsyncGenerator<InferenceEvent> {
    throw new ProviderError("usage_limit", "Provider usage limit reached", 429);
  } });
  try {
    const { response, headMs } = await gateway.post(); assert.equal(response.status, 200); assert.ok(headMs < 1000);
    const events = await collect(response);
    assert.deepEqual(events.map(event => event.type), ["response.created", "response.failed"]);
    assert.equal(errorCode(events[1]), "invalid_prompt", "a usage limit stops Codex's stream retries");
    assert.equal((await gateway.telemetry("request_failed"))[0].code, "usage_limit");
  } finally { await gateway.close(); }
});

test("a provider without transport keeps today's head, and its transport events are ignored", { timeout: 10000 }, async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const gateway = await setup({ async *infer() {
    await held; yield { type: "transport", turnState: "gts1:ignored" }; yield { type: "text", text: "answer" }; yield { type: "done", usage };
  } });
  try {
    const { response, headMs } = await gateway.post();
    assert.ok(headMs < 1000, `headers are written before the provider runs (${headMs} ms)`);
    assert.equal(response.headers.get("x-codex-turn-state"), null);
    release(); const events = await collect(response);
    assert.equal(events.at(-1)!.type, "response.completed"); assert.ok(!JSON.stringify(events).includes("gts1:ignored"));
    assert.equal((await gateway.telemetry("request_completed"))[0].events, 2);
  } finally { release(); await gateway.close(); }
});

test("a non-streaming response carries a valid turn-state and drops a malformed one", { timeout: 10000 }, async () => {
  let turnState = "gts1:non-streaming";
  const gateway = await setup({ emitsTransport: true, async *infer() { yield { type: "transport", turnState }; yield { type: "text", text: "answer" }; yield { type: "done", usage }; } });
  try {
    const valid = (await gateway.post({ stream: false })).response;
    assert.equal(valid.status, 200); assert.equal(valid.headers.get("x-codex-turn-state"), "gts1:non-streaming");
    assert.equal((await valid.json() as { output_text: string }).output_text, "answer");
    for (const malformed of ["has space", "x".repeat(8193)]) {
      turnState = malformed;
      for (const stream of [false, true]) {
        const { response } = await gateway.post({ stream });
        assert.equal(response.status, 200); assert.equal(response.headers.get("x-codex-turn-state"), null);
        if (stream) assert.equal((await collect(response)).at(-1)!.type, "response.completed"); else await response.json();
      }
    }
  } finally { await gateway.close(); }
});
