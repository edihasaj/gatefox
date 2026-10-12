import test from "node:test";
import assert from "node:assert/strict";
import { request, type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { startGateway, type GatewayFailure } from "../server.js";
import { ProviderError, type Provider } from "../providers/provider.js";
import { readEvents } from "../protocol/sse.js";
import type { InferenceEvent, WireEvent } from "../protocol/types.js";

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const secret = "stream-fixture-private-request-and-token";
const response = (event: WireEvent) => event.response as Record<string, unknown>;
async function setup(provider: Provider, timeoutMs = 2000) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-streaming-"));
  const config: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, timeoutMs, maxConcurrent: 1,
    providers: [{ id: "fixture", type: "claude-subscription", models: { alias: "upstream" } }] };
  const failures: GatewayFailure[] = [];
  const server = await startGateway(config, () => provider, undefined, { heartbeatMs: 20, onFailure: failure => { failures.push(failure); } });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  const post = (body: unknown = { model: "alias", input: secret, stream: true }, signal?: AbortSignal) => fetch(`${url}/v1/responses`, {
    method: "POST", headers, body: JSON.stringify(body), signal,
  });
  return { server, url, headers, post, failures,
    health: async () => (await (await fetch(`${url}/health`)).json()) as { active: number },
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
async function collect(stream: Response) {
  const events: WireEvent[] = [];
  for await (const event of readEvents(stream.body!)) events.push(event);
  return events;
}
async function eventually(predicate: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(10); }
  assert.fail(message);
}
function assertDiagnostics(failures: GatewayFailure[], code: string, cause?: "timeout" | "cancelled") {
  assert.equal(failures.length, 1); assert.equal(failures[0].code, code);
  assert.equal(failures[0].abortCause, cause);
  assert.equal(failures[0].event, "request_failed");
  assert.match(failures[0].requestId, /^[a-f0-9-]{36}$/);
  assert.equal(failures[0].providerId, "fixture"); assert.equal(failures[0].model, "alias");
  assert.ok(failures[0].durationMs >= 0);
  assert.ok(!JSON.stringify(failures).includes(secret));
  for (const key of ["message", "stack", "request", "input", "headers", "token"]) assert.equal(Object.hasOwn(failures[0], key), false);
}

test("quiet inference emits created and genuine progress before provider data, then completes once", { timeout: 5000 }, async () => {
  let release!: () => void; let produced = false;
  const quiet = new Promise<void>(resolve => { release = resolve; });
  const gateway = await setup({ async *infer() { await quiet; produced = true; yield { type: "text", text: "actual output" }; yield { type: "done", usage }; } });
  try {
    const stream = await gateway.post(); assert.equal(stream.status, 200);
    const iterator = readEvents(stream.body!); const events: WireEvent[] = [];
    const created = (await iterator.next()).value!; events.push(created);
    assert.equal(created.type, "response.created"); assert.equal(produced, false);
    const progress = (await iterator.next()).value!; events.push(progress);
    assert.equal(progress.type, "response.in_progress"); assert.equal(produced, false);
    assert.equal(response(progress).status, "in_progress"); assert.equal(response(progress).output_text, "");
    assert.deepEqual(response(progress).output, []); assert.equal(response(progress).id, response(created).id);
    release(); for await (const event of iterator) events.push(event);
    assert.equal(events.at(-1)!.type, "response.completed");
    assert.equal(events.filter(event => event.type === "response.completed").length, 1);
    assert.deepEqual(events.map(event => event.sequence_number), events.map((_, index) => index));
    for (const event of events.filter(event => event.response)) assert.equal(response(event).id, response(created).id);
    assert.equal(response(events.at(-1)!).output_text, "actual output");
    assert.equal((await gateway.health()).active, 0);
    assert.equal(gateway.failures.length, 0);
  } finally { release(); await gateway.close(); }
});

test("deadline classifies a raw AbortError as SSE timeout and releases capacity without leaking request data", { timeout: 5000 }, async () => {
  let stopped = false;
  const gateway = await setup({ async *infer(_request, signal): AsyncGenerator<InferenceEvent> {
    try { await delay(10000, undefined, { signal }); }
    catch { throw new DOMException(secret, "AbortError"); }
    finally { stopped = true; }
  } }, 100);
  try {
    const stream = await gateway.post(); assert.equal(stream.status, 200);
    const events = await collect(stream);
    assert.equal(events[0].type, "response.created"); assert.ok(events.some(event => event.type === "response.in_progress"));
    assert.equal(events.at(-1)!.type, "response.failed");
    assert.equal((response(events.at(-1)!).error as { code: string }).code, "timeout");
    assert.ok(!events.some(event => event.type === "response.completed"));
    assert.ok(!JSON.stringify(events).includes(secret));
    assert.equal(stopped, true); assert.equal((await gateway.health()).active, 0);
    assertDiagnostics(gateway.failures, "timeout", "timeout");
  } finally { await gateway.close(); }
});

test("client disconnect aborts its quiet provider and produces no false completion", { timeout: 5000 }, async () => {
  let aborted = false; let stopped = false;
  const gateway = await setup({ async *infer(_request, signal): AsyncGenerator<InferenceEvent> {
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    try { await delay(10000, undefined, { signal }); }
    catch { throw new DOMException(secret, "AbortError"); }
    finally { stopped = true; }
  } });
  const control = new AbortController(); const events: WireEvent[] = [];
  try {
    const stream = await gateway.post(undefined, control.signal);
    try {
      for await (const event of readEvents(stream.body!)) {
        events.push(event);
        if (event.type === "response.in_progress") control.abort();
      }
    } catch (error) { assert.equal((error as Error).name, "AbortError"); }
    await eventually(async () => aborted && stopped && (await gateway.health()).active === 0, "disconnect must stop inference and release capacity");
    assert.ok(!events.some(event => event.type === "response.completed"));
    assertDiagnostics(gateway.failures, "cancelled", "cancelled");
  } finally { control.abort(); await gateway.close(); }
});

test("context rejection before provider output is a terminal SSE failure and invalid requests remain HTTP errors", async () => {
  let called = 0;
  const gateway = await setup({ async *infer() { called++; throw new ProviderError("context_length_exceeded", "Context limit reached", 400); } });
  try {
    const stream = await gateway.post(); assert.equal(stream.status, 200);
    const events = await collect(stream);
    assert.equal(events[0].type, "response.created"); assert.equal(events.at(-1)!.type, "response.failed");
    assert.equal((response(events.at(-1)!).error as { code: string }).code, "context_length_exceeded");
    assert.ok(!events.some(event => event.type === "response.completed"));
    assert.equal((await gateway.health()).active, 0); assertDiagnostics(gateway.failures, "context_length_exceeded");
    for (const [body, status] of [
      [{ model: "missing", stream: true }, 404], [{ model: "alias", stream: 1 }, 400],
      [{ model: "alias", input: "hello", stream: true, tools: [{ type: "web_search" }] }, 400],
    ] as const) {
      const invalid = await gateway.post(body); assert.equal(invalid.status, status);
      assert.match(invalid.headers.get("content-type")!, /application\/json/);
      assert.equal(typeof ((await invalid.json()) as { error: { code: string } }).error.code, "string");
    }
    const malformed = await fetch(`${gateway.url}/v1/responses`, { method: "POST", headers: gateway.headers, body: "{invalid" });
    assert.equal(malformed.status, 400); assert.equal((await malformed.json() as { error: { code: string } }).error.code, "invalid_json");
    assert.equal(called, 1);
  } finally { await gateway.close(); }
});

test("deadline releases a backpressured response and permits idle restart without client cancellation", { timeout: 5000 }, async () => {
  let stopped = false; let produced = 0;
  const gateway = await setup({ async *infer(_request, signal): AsyncGenerator<InferenceEvent> {
    try {
      for (let index = 0; index < 32 && !signal.aborted; index++) { produced++; yield { type: "text", text: "x".repeat(2 * 1024 * 1024) }; }
      await delay(10000, undefined, { signal });
    } finally { stopped = true; }
  } }, 100);
  let client: ClientRequest | undefined; let stream: IncomingMessage | undefined;
  let outgoing: ServerResponse | undefined;
  gateway.server.once("request", (_request, reply) => { outgoing = reply; });
  try {
    await new Promise<void>((resolve, reject) => {
      client = request(`${gateway.url}/v1/responses`, { method: "POST", headers: gateway.headers }, incoming => {
        stream = incoming; incoming.pause(); incoming.on("error", () => {}); resolve();
      });
      client.on("error", error => { if (!stream) reject(error); });
      client.end(JSON.stringify({ model: "alias", input: "hello", stream: true }));
    });
    await eventually(async () => stopped && (await gateway.health()).active === 0, "deadline must release blocked inference while the raw client stays paused");
    assert.ok(produced > 0); assert.ok(produced < 32, "the provider must be stopped while still blocked on output");
    assert.equal(outgoing?.destroyed, true, "deadline cleanup owns the stalled response teardown");
    assertDiagnostics(gateway.failures, "timeout", "timeout");
    const restarted = new Promise<void>(resolve => {
      assert.equal(gateway.server.restartWhenIdle(() => resolve()), true, "the abandoned output must not keep request ownership busy");
    });
    await restarted;
  } finally { stream?.destroy(); client?.destroy(); await gateway.close(); }
});

test("deadline releases blocked terminal frames after true provider completion without inventing a failure", { timeout: 5000 }, async () => {
  let completed = false; let stopped = false;
  const gateway = await setup({ async *infer(): AsyncGenerator<InferenceEvent> {
    try {
      yield { type: "text", text: "x".repeat(512 * 1024) };
      completed = true; yield { type: "done", usage };
    } finally { stopped = true; }
  } }, 100);
  let client: ClientRequest | undefined; let stream: IncomingMessage | undefined;
  let outgoing: ServerResponse | undefined;
  gateway.server.once("request", (_request, reply) => { outgoing = reply; });
  try {
    await new Promise<void>((resolve, reject) => {
      client = request(`${gateway.url}/v1/responses`, { method: "POST", headers: gateway.headers }, incoming => {
        stream = incoming; incoming.pause(); incoming.on("error", () => {}); resolve();
      });
      client.on("error", error => { if (!stream) reject(error); });
      client.end(JSON.stringify({ model: "alias", input: "hello", stream: true }));
    });
    await eventually(async () => stopped && (await gateway.health()).active === 0, "terminal output must release inference at its deadline");
    assert.equal(completed, true, "fixture must reach real provider completion before deadline cleanup");
    assert.equal(gateway.failures.length, 0, "completed provider output must not be reclassified as failed");
    assert.equal(outgoing?.destroyed, true, "deadline tears down undelivered terminal output");
    assert.equal(outgoing?.writableFinished, false, "fixture must exercise blocked terminal delivery rather than normal completion");
    const restarted = new Promise<void>(resolve => {
      assert.equal(gateway.server.restartWhenIdle(() => resolve()), true, "undelivered terminal frames must not retain request ownership");
    });
    await restarted;
  } finally { stream?.destroy(); client?.destroy(); await gateway.close(); }
});

test("deadline covers failure-frame and nonstream JSON delivery until the owned response closes", { timeout: 5000 }, async () => {
  for (const mode of ["failure-sse", "completed-json"] as const) {
    let reachedTerminal = false; let stopped = false;
    const gateway = await setup({ async *infer(): AsyncGenerator<InferenceEvent> {
      try {
        yield { type: "text", text: "x".repeat((mode === "failure-sse" ? 1 : 2) * 1024 * 1024) };
        reachedTerminal = true;
        // Fill the final frame beyond loopback TCP buffering, after the first
        // delta has drained; the diagnostic must still omit the error body.
        if (mode === "failure-sse") throw new ProviderError("context_length_exceeded", "Context limit reached " + "x".repeat(4 * 1024 * 1024), 400);
        yield { type: "done", usage };
      } finally { stopped = true; }
    } }, 100);
    let client: ClientRequest | undefined; let stream: IncomingMessage | undefined; let outgoing: ServerResponse | undefined;
    gateway.server.once("request", (_request, reply) => { outgoing = reply; });
    try {
      await new Promise<void>((resolve, reject) => {
        client = request(`${gateway.url}/v1/responses`, { method: "POST", headers: gateway.headers }, incoming => {
          stream = incoming; incoming.pause(); incoming.on("error", () => {}); resolve();
        });
        client.on("error", error => { if (!stream) reject(error); });
        client.end(JSON.stringify({ model: "alias", input: "hello", stream: mode === "failure-sse" }));
      });
      await eventually(async () => outgoing?.destroyed === true && stopped && (await gateway.health()).active === 0,
        `${mode}: deadline must close undelivered terminal data while the client remains paused`);
      assert.equal(reachedTerminal, true, `${mode}: provider must reach its actual terminal outcome`);
      assert.equal(outgoing?.writableFinished, false, `${mode}: fixture must exercise blocked final delivery`);
      if (mode === "failure-sse") assertDiagnostics(gateway.failures, "context_length_exceeded");
      else assert.equal(gateway.failures.length, 0, "true JSON completion must not be converted into a provider failure");
      const restarted = new Promise<void>(resolve => {
        assert.equal(gateway.server.restartWhenIdle(() => resolve()), true, `${mode}: closed output must release request ownership`);
      });
      await restarted;
    } finally { stream?.destroy(); client?.destroy(); await gateway.close(); }
  }
});
