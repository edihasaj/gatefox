import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { gatewayToken, validateConfig } from "../config.js";
import { startGateway } from "../server.js";
import { readEvents } from "../protocol/sse.js";
import { flushTelemetry, readTelemetry, configureTelemetry } from "../telemetry.js";
import { flushUsageLedger } from "../usage-ledger.js";
import type { WireEvent } from "../protocol/types.js";

test("Claude result-only billing failures reach JSON and SSE clients with safe actionable text and no retry", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-billing-"));
  const calls = join(directory, "calls");
  const privateMarker = "private-card-and-account-details";
  const privateText = `Your credit balance is too low to access the Anthropic API. ${privateMarker}`;
  const result = { type: "result", is_error: true, subtype: "error_during_execution", errors: [privateText] };
  const script = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
for await (const _ of process.stdin) {}
appendFileSync(${JSON.stringify(calls)}, '1\\n');
console.log(JSON.stringify(${JSON.stringify(result)}));
`;
  await writeFile(join(directory, "claude"), script, { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = directory + delimiter + (oldPath ?? "");
  configureTelemetry(directory, "test");
  const config = validateConfig({
    version: 1, port: 0, stateDirectory: directory, maxConcurrent: 1,
    providers: [{ id: "fixture", type: "claude-subscription", models: { alias: "fixture" } }],
  });
  const gateway = await startGateway(config, undefined, undefined, { onFailure: () => {} });
  t.after(async () => {
    gateway.closeAllConnections();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    await flushUsageLedger(); await flushTelemetry();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  });
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  const url = `http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1/responses`;
  const post = (stream: boolean) => fetch(url, {
    method: "POST", headers, body: JSON.stringify({ model: "alias", input: "fixture", stream }),
  });
  const plain = await post(false);
  assert.equal(plain.status, 429);
  const body = await plain.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, "insufficient_quota");
  assert.match(body.error.message, /Claude.*billing/i);
  assert.match(body.error.message, /payment method/i);
  assert.ok(!JSON.stringify(body).includes(privateMarker));
  const streamed = await post(true);
  assert.equal(streamed.status, 200);
  const events: WireEvent[] = [];
  for await (const event of readEvents(streamed.body!)) events.push(event);
  assert.deepEqual(events.map(event => event.type), ["response.created", "response.failed"]);
  const failure = events.at(-1)!.response as { error: { code: string; message: string }; output: unknown[] };
  assert.equal(failure.error.code, "invalid_prompt");
  assert.equal(failure.error.message, body.error.message);
  assert.deepEqual(failure.output, []);
  assert.ok(!JSON.stringify(events).includes(privateMarker));
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 2, "one CLI attempt per request");
  await flushTelemetry();
  assert.ok(!JSON.stringify(await readTelemetry(directory, 0)).includes(privateMarker), "private refusal text stays out of telemetry");
});
