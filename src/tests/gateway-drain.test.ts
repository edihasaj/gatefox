import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { startGateway, type GatewayFailure, type GatewayServer } from "../server.js";
import type { Provider } from "../providers/provider.js";
import { readEvents } from "../protocol/sse.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { startErrorReports } from "../error-report.js";
import { registerActivityProbe, registerShutdownHook } from "../runtime-activity.js";
import type { InferenceEvent, WireEvent } from "../protocol/types.js";

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
delete process.env.GATEWAY_ERROR_REPORTS;
async function setup(providers: Record<string, Provider>) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-drain-"));
  configureTelemetry(directory, "server");
  const config: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, timeoutMs: 10000,
    providers: Object.keys(providers).map(id => ({ id, type: "claude-subscription" as const, models: { [id]: "upstream" } })) };
  const failures: GatewayFailure[] = [];
  const server = await startGateway(config, provider => providers[provider.id], undefined, { heartbeatMs: 5000, onFailure: failure => { failures.push(failure); } });
  const port = (server.address() as { port: number }).port; const token = await gatewayToken(directory);
  const post = (model: string) => fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, input: "hello", stream: true }) });
  const telemetry = async (event: string) => { await flushTelemetry(); return (await readTelemetry(directory, Date.now() - 60000)).filter(entry => entry.event === event); };
  const closed = (target: GatewayServer = server) => new Promise<number>(resolve => { const started = Date.now(); target.close(() => resolve(Date.now() - started)); });
  return { directory, port, token, server, post, failures, telemetry, closed, cleanup: async () => { server.closeAllConnections(); await flushTelemetry(); await rm(directory, { recursive: true, force: true }); } };
}
async function collect(response: Response) { const events: WireEvent[] = []; for await (const event of readEvents(response.body!)) events.push(event); return events; }
const failure = (event: WireEvent) => (event.response as { error: { code: string; message: string } }).error;

test("close lets a running stream finish, then calls back", { timeout: 10000 }, async () => {
  const gateway = await setup({ slow: { async *infer() { yield { type: "text", text: "first " }; await delay(300); yield { type: "text", text: "second" }; yield { type: "done", usage }; } } });
  try {
    const response = await gateway.post("slow"); const iterator = readEvents(response.body!); const events: WireEvent[] = [];
    while (!events.some(event => event.type === "response.output_text.delta")) events.push((await iterator.next()).value!);
    const closing = gateway.closed();
    for await (const event of iterator) events.push(event);
    const elapsed = await closing;
    assert.equal(events.at(-1)!.type, "response.completed"); assert.equal((events.at(-1)!.response as { output_text: string }).output_text, "first second");
    assert.ok(elapsed < 3000, `the close does not wait for the full drain deadline (${elapsed} ms)`);
    assert.equal(gateway.failures.length, 0);
    const [drain] = await gateway.telemetry("server_drain");
    assert.equal(drain.active, 1); assert.equal(drain.aborted, 0); assert.ok(Number(drain.drainedMs) >= 200);
  } finally { await gateway.cleanup(); }
});

test("the drain deadline fails endless streams as retryable, never as a reported gateway bug", { timeout: 10000 }, async () => {
  const reports: unknown[] = [];
  const glitchtip = createServer((req, res) => { req.resume(); req.on("end", () => { reports.push(req.url); res.end("{}"); }); });
  glitchtip.listen(0, "127.0.0.1"); await once(glitchtip, "listening");
  const endless: Provider = { async *infer(_request, signal): AsyncGenerator<InferenceEvent> {
    yield { type: "text", text: "partial" };
    // A raw transport error, as an aborted fetch or CLI would raise it.
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("socket hang up")), { once: true }));
  } };
  const broken: Provider = { async *infer(): AsyncGenerator<InferenceEvent> { throw new RangeError("unexpected fixture state"); } };
  const gateway = await setup({ endless, broken });
  process.env.GATEWAY_SHUTDOWN_DRAIN_MS = "200";
  try {
    await writeFile(join(gateway.directory, "glitchtip.dsn"), `http://publickey@127.0.0.1:${(glitchtip.address() as { port: number }).port}/5`, { mode: 0o600 });
    startErrorReports(gateway.directory, "server");
    assert.equal(failure((await collect(await gateway.post("broken"))).at(-1)!).code, "provider_failed");
    for (let attempt = 0; attempt < 100 && !reports.length; attempt++) await delay(20);
    assert.equal(reports.length, 1, "the spy sees an ordinary gateway bug");
    const response = await gateway.post("endless"); const iterator = readEvents(response.body!); const events: WireEvent[] = [];
    while (!events.some(event => event.type === "response.output_text.delta")) events.push((await iterator.next()).value!);
    const closing = gateway.closed();
    for await (const event of iterator) events.push(event);
    const elapsed = await closing;
    assert.equal(events.at(-1)!.type, "response.failed");
    assert.deepEqual(failure(events.at(-1)!), { code: "upstream_unavailable", message: "Gateway is restarting; retry shortly" });
    assert.ok(elapsed >= 200 && elapsed < 2000, `the abort waits for the drain deadline only (${elapsed} ms)`);
    assert.deepEqual(gateway.failures.at(-1), { ...gateway.failures.at(-1), code: "upstream_unavailable", status: 503, abortCause: "shutdown" });
    const failed = (await gateway.telemetry("request_failed")).at(-1)!;
    assert.equal(failed.code, "upstream_unavailable"); assert.equal(failed.abortCause, "shutdown");
    const [drain] = await gateway.telemetry("server_drain");
    assert.equal(drain.active, 1); assert.equal(drain.aborted, 1); assert.ok(Number(drain.drainedMs) >= 200);
    await delay(200); assert.equal(reports.length, 1, "a shutdown abort is never reported as an exception");
  } finally { delete process.env.GATEWAY_SHUTDOWN_DRAIN_MS; glitchtip.close(); await gateway.cleanup(); }
});

test("a request that arrives during the drain gets a retryable 503", { timeout: 10000 }, async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const gateway = await setup({ held: { async *infer() { await held; yield { type: "text", text: "done" }; yield { type: "done", usage }; } } });
  const socket = connect(gateway.port, "127.0.0.1");
  try {
    const running = gateway.post("held"); await once(socket, "connect");
    // Partial headers keep this connection active through close(), like a keep-alive client mid-request.
    socket.write("POST /v1/responses HTTP/1.1\r\nHost: localhost\r\n");
    await delay(50); const closing = gateway.closed(); await delay(50);
    let reply = ""; socket.on("data", chunk => { reply += chunk; });
    const body = JSON.stringify({ model: "held", input: "hello", stream: true });
    socket.write(`Authorization: Bearer ${gateway.token}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
    for (let attempt = 0; attempt < 100 && !reply.includes("}}"); attempt++) await delay(20);
    assert.match(reply, /^HTTP\/1\.1 503 /); assert.match(reply, /\r\nretry-after: 1\r\n/i);
    assert.match(reply, /"code":"upstream_unavailable"/);
    release(); assert.equal((await collect(await running)).at(-1)!.type, "response.completed", "the running stream still finishes");
    socket.destroy(); await closing;
  } finally { release(); socket.destroy(); await gateway.cleanup(); }
});

test("busy runtime work blocks an idle restart, and shutdown hooks finish before either callback", { timeout: 10000 }, async () => {
  let busy = true; const ran: string[] = [];
  const unregisterProbe = registerActivityProbe("fixture-session", () => busy);
  const unregisterHook = registerShutdownHook("fixture-hook", async () => { await delay(50); ran.push("hook"); });
  const gateway = await setup({ idle: { async *infer() { yield { type: "done", usage }; } } });
  try {
    assert.equal(gateway.server.isIdle(), false);
    assert.equal(gateway.server.restartWhenIdle(() => assert.fail("must not restart over a live session")), false);
    busy = false; assert.equal(gateway.server.isIdle(), true);
    await new Promise<void>(resolve => { assert.equal(gateway.server.restartWhenIdle(() => { ran.push("restart"); resolve(); }), true); });
    assert.deepEqual(ran, ["hook", "restart"]);
    await new Promise<void>(resolve => gateway.server.close(() => { ran.push("close"); resolve(); }));
    assert.deepEqual(ran, ["hook", "restart", "close"], "a second close reuses the finished drain");
  } finally { unregisterProbe(); unregisterHook(); await gateway.cleanup(); }
});
