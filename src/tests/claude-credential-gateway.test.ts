import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { gatewayToken, validateConfig } from "../config.js";
import { startGateway } from "../server.js";
import { readEvents } from "../protocol/sse.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { flushUsageLedger } from "../usage-ledger.js";
import type { WireEvent } from "../protocol/types.js";

test("repeated native authentication rejection stays final for JSON and SSE and records a safe reason", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-credential-"));
  const calls = join(directory, "calls");
  const privateMarker = "private-provider-and-account-diagnostic";
  const message = {
    type: "assistant", error: "authentication_failed",
    message: { content: [{ type: "text", text: `Failed to authenticate. API Error: 401 ${privateMarker}` }] },
  };
  await writeFile(join(directory, "claude"), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
for await (const _ of process.stdin) {}
appendFileSync(${JSON.stringify(calls)}, '1\\n');
console.log(JSON.stringify(${JSON.stringify(message)}));
`, { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = directory + delimiter + (previous ?? "");
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
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  const url = `http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1/responses`;
  const post = (stream: boolean) => fetch(url, {
    method: "POST", headers, body: JSON.stringify({ model: "alias", input: "fixture", stream }),
  });
  const plain = await post(false);
  assert.equal(plain.status, 401);
  const body = await plain.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, "authentication");
  assert.match(body.error.message, /Claude/i);
  assert.doesNotMatch(body.error.message, /requires login/i);
  const streamed = await post(true);
  assert.equal(streamed.status, 200);
  const events: WireEvent[] = [];
  for await (const event of readEvents(streamed.body!)) events.push(event);
  assert.deepEqual(events.map(event => event.type), ["response.created", "response.failed"]);
  const failure = events.at(-1)!.response as { error: { code: string; message: string }; output: unknown[] };
  assert.equal(failure.error.code, "invalid_prompt");
  assert.equal(failure.error.message, body.error.message);
  assert.deepEqual(failure.output, []);
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 4, "two attempts per request, then final");
  await flushTelemetry();
  const telemetry = await readTelemetry(directory, 0);
  const failures = telemetry.filter(event => event.event === "request_failed");
  assert.equal(failures.length, 2);
  assert.ok(failures.every(event => event.upstreamReason === "upstream_rejected"));
  assert.equal(telemetry.filter(event => event.event === "claude_credential_recovery" && event.outcome === "attempted").length, 2);
  assert.equal(telemetry.filter(event => event.event === "claude_credential_recovery" && event.outcome === "failed").length, 2);
  assert.ok(!JSON.stringify([body, events, telemetry]).includes(privateMarker), "private native diagnostics never leave the classifier");
});
