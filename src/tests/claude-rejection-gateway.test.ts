import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { gatewayToken, validateConfig } from "../config.js";
import { startGateway } from "../server.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { flushUsageLedger } from "../usage-ledger.js";

test("Claude native request rejections stay final across Responses and Messages without leaking or retrying", async t => {
  const root = await mkdtemp(join(tmpdir(), "claude-rejection-"));
  const calls = join(root, "calls"); const native = join(root, "native.json");
  const marker = "private-request-content-authentication-rate-limit";
  const policy = `API Error: Private diagnostic ${marker}\n\nDetails: \[reasoning_extraction\]`;
  const policyText = policy.replace("[reasoning_extraction]", "`[reasoning_extraction]`");
  await writeFile(join(root, "claude"), `#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';
for await (const _ of process.stdin) {}
appendFileSync(${JSON.stringify(calls)}, '1\\n');
console.log(readFileSync(${JSON.stringify(native)}, 'utf8'));
`, { mode: 0o700 });
  const oldPath = process.env.PATH; process.env.PATH = root + delimiter + (oldPath ?? "");
  configureTelemetry(root, "test");
  const config = validateConfig({ version: 1, port: 0, stateDirectory: root, maxConcurrent: 1,
    providers: [{ id: "fixture", type: "claude-subscription", models: { alias: "fixture" } }] });
  const gateway = await startGateway(config, undefined, undefined, { onFailure: () => {} });
  t.after(async () => {
    gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve()));
    await flushUsageLedger(); await flushTelemetry();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  });
  const headers = { Authorization: `Bearer ${await gatewayToken(root)}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
  const base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  let requests = 0;
  for (const envelope of [
    { type: "assistant", error: "invalid_request", message: { content: [{ type: "text", text: marker }] } },
    { type: "result", is_error: true, subtype: "error_during_execution", error_code: "invalid_request", result: marker },
    { type: "assistant", error: "invalid_request", message: { content: [{ type: "text", text: policyText }] } },
    { type: "result", is_error: true, subtype: "error_during_execution", errors: [policyText] },
  ]) {
    await writeFile(native, JSON.stringify(envelope));
    for (const protocol of ["responses", "messages"]) for (const stream of [false, true]) {
      const body = protocol === "responses" ? { model: "alias", input: "fixture", stream }
        : { model: "alias", max_tokens: 32, messages: [{ role: "user", content: "fixture" }], stream };
      const response = await fetch(`${base}/v1/${protocol}`, { method: "POST", headers, body: JSON.stringify(body) });
      const text = await response.text(); requests++;
      assert.ok(!text.includes(marker), `${protocol} keeps private diagnostic content hidden`);
      if (!stream) {
        assert.equal(response.status, 400, protocol);
        const error = JSON.parse(text).error;
        assert.equal(protocol === "responses" ? error.code : error.type, protocol === "responses" ? "invalid_request" : "invalid_request_error");
      } else {
        assert.equal(response.status, 200);
        const frames = text.split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(6)));
        if (protocol === "responses") {
          assert.deepEqual(frames.map(frame => frame.type), ["response.created", "response.failed"]);
          assert.equal(frames.at(-1).response.error.code, "invalid_prompt", "SDK receives a final rejection, not a retryable stream failure");
          assert.deepEqual(frames.at(-1).response.output, []);
        } else {
          const failure = frames.find(frame => frame.type === "error");
          assert.equal(failure?.error.type, "invalid_request_error");
        }
      }
      assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, requests, "exactly one provider invocation per request");
    }
  }
  await flushTelemetry(); const events = await readTelemetry(root, 0);
  assert.ok(!JSON.stringify(events).includes(marker));
  const failures = events.filter(event => event.event === "request_failed");
  assert.equal(failures.length, 16);
  assert.equal(failures.filter(failure => failure.upstreamReason === "reasoning_extraction").length, 8);
  for (const failure of failures) { assert.equal(failure.code, "invalid_request"); assert.equal(failure.upstreamCode, "invalid_request"); }
});
