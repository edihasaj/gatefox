import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayToken, validateConfig } from "../config.js";
import { adoptGatewayHandler, startGateway } from "../server.js";
import { stopServing } from "../serve-shutdown.js";
import type { Provider } from "../providers/provider.js";
import type { InferenceEvent, UsageAccounting } from "../protocol/types.js";
import { flushRecords, resetUsageLedger } from "../usage-ledger.js";
import { configureTelemetry } from "../telemetry.js";

// A stopping server process exits at its deadline even when a stopped request's provider has not ended. The request's row
// and failure record, with the usage it reported so far, must be written before that exit; the late end of the request, if
// the process were still alive, must not write them a second time.
const usage = { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 80 } };
const accounting: UsageAccounting = { cacheWriteTokens: 10, reasoningTokens: 3, nanoAiu: 2e9, nanoAiuStatus: "complete" };

async function gateway(t: TestContext, infer: Provider["infer"], release: () => void = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-serve-shutdown-")); resetUsageLedger(); configureTelemetry(directory, "test");
  const previous = process.env.GATEWAY_SHUTDOWN_DRAIN_MS; process.env.GATEWAY_SHUTDOWN_DRAIN_MS = "100";
  t.after(async () => {
    if (previous === undefined) delete process.env.GATEWAY_SHUTDOWN_DRAIN_MS; else process.env.GATEWAY_SHUTDOWN_DRAIN_MS = previous;
    await flushRecords(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, providers: [{ id: "fake", type: "copilot-subscription", models: { alias: "actual" } }] });
  const server = await startGateway(config, () => ({ infer }) as Provider, undefined, { onFailure: () => {} });
  // A failed assertion must not leave a silent provider and a listening server behind: they would keep the test process alive.
  t.after(async () => { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  // What the files hold right now, read without any flush of this test.
  const read = (folder: string, pattern: RegExp) => { const path = join(directory, folder); try { return readdirSync(path).filter(name => pattern.test(name)).map(name => readFileSync(join(path, name), "utf8")).join(""); } catch { return ""; } };
  const lines = (text: string) => text.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  return { directory, server, post: () => fetch(`${url}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "alias", input: "hi", stream: true }) }),
    ledger: () => lines(read("usage", /^usage-.*\.jsonl$/)).filter(entry => entry.origin === "gateway"), events: () => lines(read("telemetry", /^events-.*\.jsonl$/)) };
}

/** A provider that reports a billed call, then stays silent: it does not end, abort or not, until `release` is called. */
function silentProvider() {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let reportedUsage!: () => void; const reported = new Promise<void>(resolve => { reportedUsage = resolve; });
  const infer: Provider["infer"] = async function* (): AsyncGenerator<InferenceEvent> {
    yield { type: "text", text: "partial" };
    yield { type: "usage", usage, accounting };
    // The server asks for the next event only after it has taken the usage.
    reportedUsage();
    await gate;
    yield { type: "done", usage, accounting };
  };
  return { infer, release, reported };
}

test("the exit deadline records the requests still running, with the usage they reported, before the process exits", { timeout: 20000 }, async t => {
  const provider = silentProvider(); const gw = await gateway(t, provider.infer, provider.release);
  const response = await gw.post(); const reader = response.body!.getReader(); await reader.read(); await provider.reported;
  const exits: Array<{ code: number; ledger: Array<Record<string, unknown>>; events: Array<Record<string, unknown>> }> = [];
  const exited = new Promise<void>(resolve => stopServing(gw.server, code => { exits.push({ code, ledger: gw.ledger(), events: gw.events() }); resolve(); }, 400));
  const started = Date.now(); await exited;
  assert.equal(exits.length, 1); assert.equal(exits[0].code, 0);
  assert.ok(Date.now() - started < 2500, "the deadline ended it, not the drain, which waits for a silent provider for 3 s");
  const [row, ...rest] = exits[0].ledger;
  assert.equal(rest.length, 0);
  assert.deepEqual([row?.status, row?.inputTokens, row?.cacheWriteTokens, row?.nanoAiu, row?.nanoAiuStatus], ["failed", 100, 10, 2e9, "complete"], "the billed call is in the ledger when the process exits");
  const failed = exits[0].events.find(event => event.event === "request_failed");
  assert.ok(failed, "and so is the request's failure record");
  assert.equal(failed.nanoAiu, 2e9); assert.equal(failed.abortCause, "shutdown");
  // The provider ends after all: the request must not be recorded a second time.
  provider.release();
  await new Promise<void>(resolve => gw.server.close(() => resolve()));
  await flushRecords();
  assert.equal(gw.ledger().length, 1, "one ledger row for the request");
  assert.equal(gw.events().filter(event => event.event === "request_failed" || event.event === "request_completed").length, 1, "one outcome record for the request");
  assert.equal(exits.length, 1, "the process exits once");
  await reader.cancel().catch(() => {});
});

test("recordPending writes a running request's record once, and its late end does not write another", { timeout: 20000 }, async t => {
  const provider = silentProvider(); const gw = await gateway(t, provider.infer, provider.release);
  const response = await gw.post(); const reader = response.body!.getReader(); await reader.read(); await provider.reported;
  assert.equal(gw.server.recordPending(), 1);
  assert.equal(gw.server.recordPending(), 0, "a request already recorded is not recorded again");
  await flushRecords();
  assert.deepEqual(gw.ledger().map(entry => [entry.status, entry.inputTokens, entry.nanoAiu]), [["failed", 100, 2e9]]);
  // No abort reached the request first, so the stop it is about to suffer is named by the record itself.
  assert.equal(gw.events().find(event => event.event === "request_failed")?.abortCause, "shutdown", "a request recorded at exit says it was stopped by the shutdown");
  provider.release();
  for (let attempt = 0; !gw.server.isIdle() && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  await reader.cancel().catch(() => {});
  await flushRecords();
  assert.equal(gw.ledger().length, 1); assert.equal(gw.events().filter(event => event.event === "request_completed" || event.event === "request_empty").length, 0, "the request that completed afterwards left no second outcome");
});

// The drain records what still runs when its wait is over, just before its final flush.
test("the drain records the requests still running before it flushes and reports the server closed", { timeout: 20000 }, async t => {
  const provider = silentProvider(); const gw = await gateway(t, provider.infer, provider.release);
  let stillRunning = 0; let recorded = 0; let flushedBefore = false;
  // A request that no abort reaches: the handler of an older generation, say, that reports itself busy until the drain gives up on it.
  adoptGatewayHandler(gw.server, { handle: () => {}, isIdle: () => false, abortAll: () => 0, recordPending: () => { recorded++; stillRunning = 1; flushedBefore = gw.events().some(event => event.event === "server_drain"); return 1; } });
  let atClose: Array<Record<string, unknown>> = [];
  await new Promise<void>(resolve => gw.server.close(() => { atClose = gw.events(); resolve(); }));
  assert.equal(recorded, 1, "recordPending ran once, in the drain"); assert.equal(stillRunning, 1);
  assert.equal(flushedBefore, false, "and before the drain's own record and flush");
  assert.ok(atClose.some(event => event.event === "server_drain"), "the drain's record was flushed when the server reported itself closed");
});

// Whoever starts the server waits for its "Listening" line and may stop it at once (a test, a supervisor). A signal that
// arrives before the handlers exist kills the process without a drain, a flush or an exit code, so the line comes last.
const cliSource = fileURLToPath(new URL("../../src/cli-main.ts", import.meta.url));
test("the CLI says it listens only after its signal handlers are installed", { skip: !existsSync(cliSource) }, () => {
  const source = readFileSync(cliSource, "utf8"); const listening = source.indexOf("Listening on http");
  assert.ok(listening > 0);
  for (const handler of ['process.on("SIGINT", shutdown)', 'process.on("SIGTERM", shutdown)', 'process.on("SIGUSR2"', 'process.on("SIGUSR1"']) {
    const at = source.indexOf(handler); assert.ok(at > 0, handler); assert.ok(at < listening, `${handler} comes before the Listening line`);
  }
});
