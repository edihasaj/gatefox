import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gatewayToken, validateConfig, type GatewayConfig, type ProviderConfig } from "../config.js";
import { createGatewayHandler, startGateway } from "../server.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { AdmissionRegistry } from "../admission-registry.js";
import type { Provider } from "../providers/provider.js";

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const provider = (id: string, maxConcurrent?: number): ProviderConfig => ({ id, type: "claude-subscription", models: { [id]: `${id}-upstream` }, ...(maxConcurrent === undefined ? {} : { maxConcurrent }) });

async function eventually(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

async function gateway(providers: ProviderConfig[], factory: (config: ProviderConfig) => Provider, reload?: (initial: GatewayConfig) => Promise<GatewayConfig>, maxConcurrent = 1) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-provider-admission-"));
  configureTelemetry(directory, "server");
  const config: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, maxConcurrent, timeoutMs: 10000, providers };
  const server = await startGateway(config, factory, reload && (() => reload(config)), { onFailure() {} });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  return {
    directory,
    base,
    headers,
    post: (model: string, path = "/v1/responses") => fetch(base + path, { method: "POST", headers, body: JSON.stringify(path === "/v1/messages"
      ? { model, max_tokens: 10, messages: [{ role: "user", content: "hello" }] }
      : { model, input: "hello" }) }),
    health: async () => (await (await fetch(base + "/health")).json()) as { active: number; running: number; queued: number },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await flushTelemetry(); await rm(directory, { recursive: true, force: true }); },
  };
}

function heldUpload(base: string, headers: Record<string, string>, model = "a") {
  const body = JSON.stringify({ model, input: "hello" }); const split = body.length - 1;
  let status: number | undefined; let resolve!: () => void;
  const settled = new Promise<void>(done => { resolve = done; });
  const client = request(base + "/v1/responses", { method: "POST", headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) } }, response => {
    status = response.statusCode; response.resume(); response.once("end", resolve);
  });
  client.on("error", resolve); client.write(body.slice(0, split));
  return { client, finish: () => client.end(body.slice(split)), settled, status: () => status };
}

class ThrowingResponse extends EventEmitter {
  headersSent = false; writableEnded = false; writableNeedDrain = false; destroyed = false;
  setHeader(): void {}
  writeHead(): never { throw new Error("injected write failure"); }
  destroy(): void { this.destroyed = true; this.emit("close"); }
}

test("a saturated provider does not delay another provider, and health sums their queues", { timeout: 10000 }, async () => {
  let releaseA = () => {}; let releaseB = () => {};
  const holdA = new Promise<void>(resolve => { releaseA = resolve; });
  const holdB = new Promise<void>(resolve => { releaseB = resolve; });
  let callsA = 0; let callsB = 0;
  const g = await gateway([provider("a", 1), provider("b", 1)], config => ({ async *infer() {
    if (config.id === "a" && ++callsA === 1) await holdA;
    if (config.id === "b") { callsB++; await holdB; }
    yield { type: "text", text: config.id }; yield { type: "done", usage };
  } }));
  try {
    const firstA = g.post("a"); await eventually(() => callsA === 1, "provider A must start");
    const queuedA = g.post("a"); await eventually(async () => (await g.health()).queued === 1, "provider A must queue");
    const firstB = g.post("b"); await eventually(() => callsB === 1, "provider B must start independently");
    const { running, queued } = await g.health(); assert.deepEqual([running, queued], [2, 1]);
    releaseB();
    const b = await Promise.race([firstB, delay(500).then(() => assert.fail("provider B waited on provider A"))]);
    assert.equal(b.status, 200);
    releaseA();
    await Promise.all([firstA, queuedA].map(async response => (await response).text()));
  } finally {
    releaseA(); releaseB(); await g.close();
  }
});

test("a provider override admits its own limit, validates its range, and updates live", { timeout: 10000 }, async () => {
  for (const maxConcurrent of [0, 65, 1.5]) assert.throws(() => validateConfig({
    version: 1, port: 0, stateDirectory: "/tmp/state", providers: [provider("a", maxConcurrent)],
  }), /a: maxConcurrent must be 1 through 64/);
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const initial: GatewayConfig = { version: 1, port: 0, stateDirectory: "/unused", maxConcurrent: 1, providers: [provider("a", 2)] };
  let current = initial;
  const directory = await mkdtemp(join(tmpdir(), "gateway-provider-live-limit-")); configureTelemetry(directory, "server");
  initial.stateDirectory = directory;
  const server = await startGateway(initial, () => ({ async *infer() { calls++; await held; yield { type: "text", text: "done" }; yield { type: "done", usage }; } }), async () => current, { onFailure() {} });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  const post = () => fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "a", input: "hello" }) });
  try {
    const first = post(); await eventually(() => calls === 1, "first request must start");
    const second = post(); await eventually(() => calls === 2, "the provider override must exceed the gateway-wide limit");
    const third = post(); await eventually(async () => (await (await fetch(base + "/health")).json() as { queued: number }).queued === 1, "the third request must queue");
    current = { ...initial, providers: [provider("a", 3)] };
    await fetch(base + "/health");
    await eventually(() => calls === 3, "the live provider limit must admit the queued request");
    release();
    await Promise.all([first, second, third].map(async response => (await response).text()));
  } finally {
    release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  }
});

test("admission settings accept twenty and sixty-four while rejecting invalid bounds", () => {
  for (const maxConcurrent of [20, 64]) {
    const config = validateConfig({ version: 1, port: 0, stateDirectory: "/tmp/state", maxConcurrent,
      providers: [provider("a", maxConcurrent)] });
    assert.equal(config.maxConcurrent, maxConcurrent);
    assert.equal(config.providers[0]!.maxConcurrent, maxConcurrent);
  }
  for (const maxConcurrent of [0, 65, 1.5]) assert.throws(() => validateConfig({
    version: 1, port: 0, stateDirectory: "/tmp/state", maxConcurrent, providers: [provider("a")],
  }), /maxConcurrent must be 1 through 64/);
});

test("twenty-slot provider stays available at sixteen and queues only after twenty", { timeout: 15000 }, async () => {
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const configured = validateConfig({ version: 1, port: 0, stateDirectory: "/tmp/state", maxConcurrent: 8,
    providers: [provider("a", 20), provider("b")] });
  const g = await gateway(configured.providers, () => ({ async *infer() {
    calls++; await held; yield { type: "text", text: "done" }; yield { type: "done", usage };
  } }), undefined, configured.maxConcurrent);
  const pending: Promise<Response>[] = [];
  const availability = async () => (await (await fetch(g.base + "/v1/availability", { headers: g.headers })).json()) as {
    providers: { id: string; status: string; load: { running: number; queued: number; limit: number } }[];
  };
  try {
    pending.push(...Array.from({ length: 16 }, () => g.post("a")));
    await eventually(() => calls === 16, "all sixteen requests must run");
    let report = await availability();
    assert.equal(report.providers.find(row => row.id === "a")!.status, "available");
    assert.equal(report.providers.find(row => row.id === "b")!.load.limit, 8);
    pending.push(...Array.from({ length: 4 }, () => g.post("a")));
    await eventually(() => calls === 20, "all twenty requests must run");
    report = await availability();
    const row = report.providers.find(row => row.id === "a")!;
    assert.equal(row.status, "busy");
    assert.deepEqual(row.load, { running: 20, queued: 0, limit: 20 });
    pending.push(g.post("a"));
    await eventually(async () => (await g.health()).queued === 1, "request twenty-one must queue");
    assert.equal(calls, 20);
    release();
    const responses = await Promise.all(pending);
    assert.ok(responses.every(response => response.status === 200));
    await Promise.all(responses.map(response => response.text()));
    assert.equal(calls, 21);
  } finally { release(); await g.close(); }
});

test("a full provider queue returns 429 without consuming another provider's capacity", { timeout: 15000 }, async () => {
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const g = await gateway([provider("a", 1), provider("b", 1)], config => ({ async *infer() {
    if (config.id === "a" && ++calls === 1) await held;
    yield { type: "text", text: "done" }; yield { type: "done", usage };
  } }));
  try {
    const running = g.post("a"); await eventually(() => calls === 1, "provider A must start");
    const queued = Array.from({ length: 32 }, () => g.post("a"));
    await eventually(async () => (await g.health()).queued === 32, "provider A queue must fill");
    const refused = await g.post("a");
    assert.equal(refused.status, 429); assert.equal((await refused.json() as { error: { code: string } }).error.code, "busy");
    assert.equal(refused.headers.get("retry-after"), "1");
    release();
    await Promise.all([running, ...queued].map(async response => (await response).text()));
  } finally {
    release(); await g.close();
  }
});

test("a throwing pre-body 429 response releases its admission snapshot", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-admission-release-"));
  const initial: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, maxConcurrent: 1, timeoutMs: 10000, providers: [provider("a", 1)] };
  let current = initial; const registry = new AdmissionRegistry();
  const handler = await createGatewayHandler(initial, () => ({ async *infer() { yield { type: "done", usage }; } }), async () => current, { admissionRegistry: registry, onFailure() {} });
  const server = createServer(handler.handle); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  const uploads = Array.from({ length: 33 }, () => heldUpload(base, headers));
  try {
    await eventually(async () => (await (await fetch(base + "/health")).json() as { active: number }).active === 33, "uploads must fill the pre-body cap");
    const response = new ThrowingResponse();
    handler.handle({ method: "POST", url: "/v1/responses", headers: { authorization: headers.Authorization }, [Symbol.asyncIterator]: async function* () {} } as unknown as IncomingMessage, response as unknown as ServerResponse);
    await eventually(() => response.destroyed, "the injected failure must reach the handler crash boundary");
    for (const upload of uploads) upload.client.destroy();
    await Promise.all(uploads.map(upload => upload.settled));
    await eventually(() => handler.isIdle(), "aborted uploads must release their snapshots");
    current = { ...initial, providers: [] };
    await fetch(base + "/health");
    assert.equal(registry.size(), 0);
  } finally {
    for (const upload of uploads) upload.client.destroy();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("admission survives a provider remove and re-add while an earlier upload still holds its snapshot", { timeout: 10000 }, async () => {
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0; let next: GatewayConfig | undefined; let snapshots = 0;
  const g = await gateway([provider("a", 1)], () => ({ async *infer() {
    calls++; await held; yield { type: "text", text: "done" }; yield { type: "done", usage };
  } }), async initial => { snapshots++; return next ?? initial; });
  try {
    const first = heldUpload(g.base, g.headers);
    await eventually(() => snapshots === 1, "the partial upload must retain its initial snapshot");
    next = { ...({ version: 1, port: 0, stateDirectory: g.directory, maxConcurrent: 1, timeoutMs: 10000 } satisfies Omit<GatewayConfig, "providers">), providers: [] };
    await fetch(g.base + "/health");
    next = { ...next, providers: [provider("a", 1)] };
    await fetch(g.base + "/health");
    const second = g.post("a"); await eventually(() => calls === 1, "the re-added provider must start the second request");
    first.finish();
    await eventually(async () => {
      const health = await g.health();
      return health.running === 1 && health.queued === 1;
    }, "the pre-removal request must queue on the re-added provider's admission");
    release();
    await Promise.all([(await second).text(), first.settled]);
    assert.equal(calls, 2);
  } finally {
    release(); await g.close();
  }
});

test("a snapshot is pinned before a same-tick reload can remove its provider", { timeout: 10000 }, async () => {
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0; let initial: GatewayConfig | undefined; let restored: GatewayConfig | undefined;
  const resolvers: Array<(config: GatewayConfig) => void> = [];
  const g = await gateway([provider("a", 1)], () => ({ async *infer() {
    calls++; await held; yield { type: "text", text: "done" }; yield { type: "done", usage };
  } }), async config => {
    initial ??= config;
    if (restored) return restored;
    return new Promise<GatewayConfig>(resolve => resolvers.push(resolve));
  });
  try {
    const first = heldUpload(g.base, g.headers);
    const removed = fetch(g.base + "/health");
    await eventually(() => resolvers.length === 2, "the upload and health reload must wait together");
    const withoutA = { ...initial!, providers: [] };
    resolvers[0](initial!); resolvers[1](withoutA);
    await removed;
    restored = { ...initial!, providers: [provider("a", 1)] };
    await fetch(g.base + "/health");
    const second = g.post("a"); await eventually(() => calls === 1, "the re-added provider must admit the second request");
    first.finish();
    await eventually(async () => {
      const health = await g.health();
      return health.running === 1 && health.queued === 1;
    }, "the old snapshot must queue on the same provider admission");
    release();
    await Promise.all([(await second).text(), first.settled]);
    assert.equal(calls, 2);
  } finally {
    release(); await g.close();
  }
});

test("the pre-body flood guard keeps the top-level capacity when a provider has a lower override", { timeout: 10000 }, async () => {
  const g = await gateway([provider("a", 1)], () => ({ async *infer() { yield { type: "done", usage }; } }), undefined, 16);
  const uploads = Array.from({ length: 48 }, () => heldUpload(g.base, g.headers));
  try {
    await eventually(async () => (await g.health()).active === 48, "requests through the top-level 16 + 32 capacity must remain accepted");
    assert.equal(uploads.slice(33).some(upload => upload.status() !== undefined), false, "requests 34 through 48 never receive a pre-body 429");
  } finally {
    for (const upload of uploads) upload.client.destroy();
    await Promise.all(uploads.map(upload => upload.settled));
    await g.close();
  }
});

test("the reviewer route uses the admission of its serving provider", { timeout: 10000 }, async () => {
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const g = await gateway([{ id: "codex", type: "codex-subscription", maxConcurrent: 1, models: { "codex/sol": "gpt-6.1-sol" } }], () => ({
    async *infer() { calls++; await held; yield { type: "text", text: "done" }; yield { type: "done", usage }; },
  }));
  try {
    const ordinary = g.post("codex/sol"); await eventually(() => calls === 1, "the provider request must occupy its slot");
    const reviewer = g.post("codex-auto-review");
    await eventually(async () => (await g.health()).queued === 1, "the reviewer must queue behind the serving provider");
    assert.equal(calls, 1);
    release();
    await Promise.all([(await ordinary).text(), (await reviewer).text()]);
  } finally {
    release(); await g.close();
  }
});

test("request telemetry uses the resolved alias and records each client protocol", async () => {
  const alias = "claude/claude-sonnet-5-5";
  const g = await gateway([{ id: "claude", type: "claude-subscription", models: { [alias]: "claude-sonnet-5-5" } }], () => ({
    async *infer() { yield { type: "text", text: "done" }; yield { type: "done", usage }; },
  }));
  try {
    assert.equal((await g.post("missing")).status, 404);
    const invalid = await fetch(g.base + "/v1/responses", { method: "POST", headers: g.headers, body: "{" });
    assert.equal(invalid.status, 400);
    assert.equal((await g.post("claude-sonnet-5-5")).status, 200);
    assert.equal((await g.post("claude-sonnet-5-5", "/v1/messages")).status, 200);
    await flushTelemetry();
    const events = (await readTelemetry(g.directory, Date.now() - 60000)).filter(event => event.event === "request_completed");
    assert.deepEqual(events.map(event => [event.model, event.requestedModel, event.clientProtocol]), [
      [alias, "claude-sonnet-5-5", "responses"],
      [alias, "claude-sonnet-5-5", "messages"],
    ]);
    const failures = (await readTelemetry(g.directory, Date.now() - 60000)).filter(event => event.event === "request_failed");
    assert.deepEqual(failures.map(event => [event.model, event.clientProtocol]), [
      [undefined, "responses"],
      [undefined, "responses"],
    ]);
  } finally {
    await g.close();
  }
});
