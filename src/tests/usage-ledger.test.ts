import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayToken, validateConfig } from "../config.js";
import { startGateway } from "../server.js";
import { ProviderError, type Provider } from "../providers/provider.js";
import type { InferenceEvent, UsageAccounting } from "../protocol/types.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { flushUsageLedger, ledgerFields, readUsageLedger, recordUsage, resetUsageLedger } from "../usage-ledger.js";

const usage = { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 80 } };
const accounting: UsageAccounting = { cacheWriteTokens: 10, reasoningTokens: 3, nanoAiu: 2e9, nanoAiuStatus: "complete" };
type Kind = "copilot-subscription" | "claude-subscription" | "codex-subscription";

async function start(type: Kind, events: (signal: AbortSignal) => AsyncGenerator<InferenceEvent>) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-ledger-")); resetUsageLedger(); configureTelemetry(directory, "test");
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, providers: [{ id: "fake", type, models: { alias: "actual" }, ...(type === "codex-subscription" ? { credentialFile: join(directory, "credentials.json") } : {}) }] });
  const server = await startGateway(config, () => ({ infer: (_request: unknown, signal: AbortSignal) => events(signal) }) as Provider);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  const post = (body: Record<string, unknown>, signal?: AbortSignal) => fetch(`${url}/v1/responses`, { method: "POST", headers, signal, body: JSON.stringify({ model: "alias", ...body }) });
  return { directory, post, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
const answer = (): (() => AsyncGenerator<InferenceEvent>) => async function* () {
  yield { type: "usage", usage, accounting }; yield { type: "text", text: "hello" }; yield { type: "done", usage, accounting };
};
const rows = async (directory: string) => { await flushUsageLedger(); return readUsageLedger(directory, 0); };

test("a Copilot failure after billed usage keeps the spend in telemetry and the ledger", async () => {
  const gateway = await start("copilot-subscription", async function* () {
    yield { type: "usage", usage, accounting }; throw new ProviderError("model_route", "Copilot returned an unexpected model instead of the requested model");
  });
  try {
    const response = await gateway.post({ input: "hi" }); const requestId = response.headers.get("x-request-id")!; await response.text();
    await flushTelemetry();
    const failed = (await readTelemetry(gateway.directory, 0)).find(event => event.event === "request_failed" && event.requestId === requestId);
    assert.ok(failed, "request_failed is recorded");
    assert.equal(failed.inputTokens, 100); assert.equal(failed.nanoAiu, 2e9); assert.equal(failed.nanoAiuStatus, "complete"); assert.equal(failed.cacheWriteTokens, 10); assert.equal(failed.providerType, "copilot-subscription");
    const [row, ...rest] = await rows(gateway.directory); assert.equal(rest.length, 0);
    assert.deepEqual({ status: row.status, requestId: row.requestId, providerType: row.providerType, nanoAiu: row.nanoAiu, inputTokens: row.inputTokens, cachedTokens: row.cachedTokens, cacheWriteTokens: row.cacheWriteTokens, reasoningTokens: row.reasoningTokens, origin: row.origin },
      { status: "failed", requestId, providerType: "copilot-subscription", nanoAiu: 2e9, inputTokens: 100, cachedTokens: 80, cacheWriteTokens: 10, reasoningTokens: 3, origin: "gateway" });
  } finally { await gateway.close(); }
});

test("billing detail never reaches the client and the response id carries the ledger marker", async () => {
  for (const [type, marked] of [["copilot-subscription", true], ["claude-subscription", true], ["codex-subscription", false]] as const) {
    const gateway = await start(type, answer());
    try {
      for (const stream of [false, true]) {
        const response = await gateway.post({ input: "hi", stream }); const requestId = response.headers.get("x-request-id")!.replaceAll("-", ""); const text = await response.text();
        for (const word of ["nanoAiu", "cacheWriteTokens", "reasoningTokens", "nanoAiuStatus", '"type":"usage"', "event: usage"]) assert.ok(!text.includes(word), `${word} stays local`);
        const id = stream ? /"id":"(resp_[0-9a-z_]+)"/.exec(text)?.[1] : (JSON.parse(text) as { id: string }).id;
        assert.equal(id, marked ? `resp_gl_${requestId}` : id); assert.match(id!, marked ? /^resp_gl_[0-9a-f]{32}$/ : /^resp_[0-9a-f]{32}$/);
      }
    } finally { await gateway.close(); }
  }
});

test("the off switch removes the marker, the directory and every row", async () => {
  process.env.GATEWAY_USAGE_LEDGER = "off";
  const gateway = await start("copilot-subscription", answer());
  try {
    const response = await gateway.post({ input: "hi" }); const body = await response.json() as { id: string };
    assert.match(body.id, /^resp_[0-9a-f]{32}$/);
    recordUsage(gateway.directory, { requestId: "r", status: "completed", inputTokens: 5 }); await flushUsageLedger();
    assert.deepEqual((await readdir(gateway.directory)).filter(name => name === "usage"), []);
  } finally { delete process.env.GATEWAY_USAGE_LEDGER; await gateway.close(); }
});

test("the ledger holds only counts and identifiers, privately", async () => {
  const gateway = await start("copilot-subscription", answer());
  try {
    const response = await gateway.post({ instructions: "SENTINEL_INSTRUCTIONS", tools: [{ type: "function", name: "lookup_tool", parameters: { type: "object", properties: {} } }],
      input: [{ type: "message", role: "user", content: "SENTINEL_PROMPT" }, { type: "function_call", call_id: "c1", name: "lookup_tool", arguments: '{"a":"SENTINEL_ARGS"}' }, { type: "function_call_output", call_id: "c1", output: "SENTINEL_OUTPUT" }] });
    assert.equal(response.status, 200); await response.text(); await flushUsageLedger();
    const folder = join(gateway.directory, "usage"); const files = await readdir(folder);
    assert.equal((await stat(folder)).mode & 0o777, 0o700);
    assert.ok(files.some(name => /^usage-\d{4}-\d{2}\.jsonl$/.test(name)));
    for (const name of files) {
      assert.equal((await stat(join(folder, name))).mode & 0o777, 0o600, name);
      if (!name.endsWith(".jsonl")) continue;
      const content = await readFile(join(folder, name), "utf8");
      for (const sentinel of ["SENTINEL_", "lookup_tool", "hello"]) assert.ok(!content.includes(sentinel), `${sentinel} is never stored`);
      for (const line of content.split("\n").filter(Boolean)) for (const key of Object.keys(JSON.parse(line))) assert.ok(ledgerFields.has(key), `${key} is an allowed field`);
    }
    const [row] = await rows(gateway.directory); assert.match(row.responseId!, /^resp_gl_[0-9a-f]{32}$/); assert.equal(row.nanoAiuStatus, "complete");
  } finally { await gateway.close(); }
});

test("rows rotate by UTC month and months older than a year are pruned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-ledger-rotate-")); resetUsageLedger();
  const folder = join(directory, "usage"); await mkdir(folder, { recursive: true });
  for (const month of ["2025-01", "2025-02", "2025-03"]) await writeFile(join(folder, `usage-${month}.jsonl`), "{}\n");
  const row = { status: "completed" as const, inputTokens: 1 };
  recordUsage(directory, { ...row, requestId: "a" }, new Date("2026-02-28T23:59:59Z"));
  recordUsage(directory, { ...row, requestId: "b" }, new Date("2026-03-01T00:00:01Z"));
  await flushUsageLedger();
  const names = (await readdir(folder)).filter(name => name.startsWith("usage-")).sort();
  // Keep 2026-03 and the 12 months before it (2025-03 on); 2025-01 and 2025-02 are gone.
  assert.deepEqual(names, ["usage-2025-03.jsonl", "usage-2026-02.jsonl", "usage-2026-03.jsonl"]);
  assert.deepEqual((await readUsageLedger(directory, Date.parse("2026-03-01T00:00:00Z"))).map(entry => entry.requestId), ["b"]);
});

test("the telemetry history is imported once, without zero-token rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-ledger-import-")); resetUsageLedger();
  const day = new Date().toISOString().slice(0, 10); const at = new Date().toISOString();
  await mkdir(join(directory, "telemetry"), { recursive: true });
  const line = (fields: Record<string, unknown>) => JSON.stringify({ at, host: "mac", component: "gateway", pid: 1, ...fields });
  await writeFile(join(directory, "telemetry", `events-${day}.jsonl`), [
    line({ event: "request_completed", requestId: "t1", provider: "copilot", model: "copilot/x", inputTokens: 50, cachedTokens: 40, outputTokens: 3, session: true }),
    line({ event: "request_failed", requestId: "t2", provider: "known", model: "m", inputTokens: 9, outputTokens: 0, session: false }),
    line({ event: "request_completed", requestId: "t3", provider: "copilot", model: "copilot/x", inputTokens: 0, outputTokens: 0, session: true }),
    line({ event: "turn_started", requestId: "t4", inputTokens: 10 }),
  ].join("\n") + "\n");
  recordUsage(directory, { requestId: "live", status: "completed", inputTokens: 7 }, new Date(), new Map([["known", "claude-subscription"]]));
  await flushUsageLedger();
  const imported = (await readUsageLedger(directory, 0)).filter(entry => entry.origin === "telemetry");
  assert.deepEqual(imported.map(entry => [entry.requestId, entry.session, entry.providerType, entry.status, entry.host, entry.cachedTokens, entry.nanoAiu]),
    [["t1", true, undefined, "completed", "mac", 40, null], ["t2", false, "claude-subscription", "failed", "mac", 0, null]]);
  assert.ok(imported.every(entry => entry.responseId === undefined));
  const marker = JSON.parse(await readFile(join(directory, "usage", "telemetry-import.json"), "utf8")) as { rows: number }; assert.equal(marker.rows, 2);
  resetUsageLedger(); recordUsage(directory, { requestId: "later", status: "completed", inputTokens: 1 }); await flushUsageLedger();
  assert.equal((await readUsageLedger(directory, 0)).filter(entry => entry.origin === "telemetry").length, 2, "a second run does not import again");
});

async function telemetryHistory(directory: string, ids: string[]): Promise<void> {
  const day = new Date().toISOString().slice(0, 10); const at = new Date().toISOString();
  await mkdir(join(directory, "telemetry"), { recursive: true });
  await writeFile(join(directory, "telemetry", `events-${day}.jsonl`), ids.map(requestId => JSON.stringify({ at, host: "mac", component: "gateway", pid: 1, event: "request_completed", requestId, provider: "copilot", model: "m", inputTokens: 50, outputTokens: 3 })).join("\n") + "\n");
}

test("two requests that finish while the telemetry import runs each get exactly one gateway row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-ledger-race-")); resetUsageLedger();
  // Both requests are already in telemetry when the first write triggers the one-time import.
  await telemetryHistory(directory, ["a", "b", "old"]);
  recordUsage(directory, { requestId: "a", status: "completed", inputTokens: 7 });
  recordUsage(directory, { requestId: "b", status: "completed", inputTokens: 8 });
  await flushUsageLedger();
  const all = await readUsageLedger(directory, 0);
  assert.deepEqual(all.map(row => [row.requestId, row.origin]).sort(), [["a", "gateway"], ["b", "gateway"], ["old", "telemetry"]]);
  const files = (await readdir(join(directory, "usage"))).filter(name => name.startsWith("usage-"));
  const lines = (await Promise.all(files.map(name => readFile(join(directory, "usage", name), "utf8")))).join("").split("\n").filter(Boolean);
  assert.equal(lines.length, 3, "no request is written twice");
});

test("an import that failed before its marker is retried without repeating rows, and readers keep the gateway row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-ledger-retry-")); resetUsageLedger();
  await telemetryHistory(directory, ["x", "y"]);
  // A first run appended x but died before writing the marker; its copy of y was lost.
  await mkdir(join(directory, "usage"), { recursive: true });
  const at = new Date().toISOString();
  const row = { v: 1, at, host: "mac", requestId: "x", provider: "copilot", model: "m", status: "completed", origin: "telemetry", inputTokens: 50, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 0, nanoAiu: null };
  await writeFile(join(directory, "usage", `usage-${at.slice(0, 7)}.jsonl`), JSON.stringify(row) + "\n" + JSON.stringify({ ...row, origin: "gateway", inputTokens: 51 }) + "\n");
  recordUsage(directory, { requestId: "later", status: "completed", inputTokens: 1 }); await flushUsageLedger();
  const all = await readUsageLedger(directory, 0);
  assert.deepEqual(all.map(entry => [entry.requestId, entry.origin]).sort(), [["later", "gateway"], ["x", "gateway"], ["y", "telemetry"]]);
  assert.equal(all.find(entry => entry.requestId === "x")?.inputTokens, 51, "the gateway row wins over the imported one");
});

test("usage a provider reports after the client disconnected is still recorded", async () => {
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  const gateway = await start("copilot-subscription", async function* (signal) {
    began(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    // The provider had already paid for this call when the caller left.
    yield { type: "usage", usage, accounting }; yield { type: "done", usage, accounting };
  });
  try {
    const client = new AbortController();
    const pending = gateway.post({ input: "hi", stream: true }, client.signal).then(response => response.text()).catch(() => "");
    await started; client.abort(); await pending;
    for (let attempt = 0; attempt < 50; attempt++) { if ((await rows(gateway.directory)).length) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    const [row, ...rest] = await rows(gateway.directory); assert.equal(rest.length, 0);
    assert.equal(row.status, "failed"); assert.equal(row.inputTokens, 100); assert.equal(row.nanoAiu, 2e9); assert.equal(row.nanoAiuStatus, "complete");
    await flushTelemetry();
    const failed = (await readTelemetry(gateway.directory, 0)).find(event => event.event === "request_failed");
    assert.equal(failed?.nanoAiu, 2e9, "telemetry keeps the spend too");
  } finally { await gateway.close(); }
});

test("the telemetry import keeps cache-write, reasoning and credit figures that the event carries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-ledger-figures-")); resetUsageLedger();
  const at = new Date().toISOString();
  await mkdir(join(directory, "telemetry"), { recursive: true });
  await writeFile(join(directory, "telemetry", `events-${at.slice(0, 10)}.jsonl`), JSON.stringify({ at, host: "mac", component: "gateway", pid: 1, event: "request_completed", requestId: "k", provider: "copilot", model: "m",
    inputTokens: 50, cachedTokens: 40, outputTokens: 3, cacheWriteTokens: 6, reasoningTokens: 2, nanoAiu: 2.5e9, nanoAiuStatus: "partial" }) + "\n");
  recordUsage(directory, { requestId: "later", status: "completed", inputTokens: 1 }); await flushUsageLedger();
  const row = (await readUsageLedger(directory, 0)).find(entry => entry.requestId === "k");
  assert.deepEqual([row?.origin, row?.cacheWriteTokens, row?.reasoningTokens, row?.nanoAiu, row?.nanoAiuStatus], ["telemetry", 6, 2, 2.5e9, "partial"]);
});
