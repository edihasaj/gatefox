import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotSubscription } from "../providers/copilot.js";
import type { ProviderConfig } from "../config.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";

const provider: ProviderConfig = { id: "copilot", type: "copilot-subscription", models: { alias: "fixture" } };
const collect = async (input: AsyncIterable<InferenceEvent>) => { const events: InferenceEvent[] = []; for await (const event of input) events.push(event); return events; };
const request: ResponsesRequest = { model: "fixture", input: "hello" };

async function withFixture(run: (directory: string, mode: (value: string | undefined) => void) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-copilot-billing-"));
  const fixture = fileURLToPath(new URL("./copilot-fixture.js", import.meta.url));
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  await writeFile(join(directory, "copilot"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)}\n`); await chmod(join(directory, "copilot"), 0o700);
  const previous = { PATH: process.env.PATH, mode: process.env.GATEWAY_COPILOT_FIXTURE_MODE, receipt: process.env.GATEWAY_COPILOT_FIXTURE_RECEIPT };
  process.env.PATH = directory + delimiter + process.env.PATH; process.env.GATEWAY_COPILOT_FIXTURE_RECEIPT = join(directory, "receipt.json");
  try { await run(directory, value => { if (value === undefined) delete process.env.GATEWAY_COPILOT_FIXTURE_MODE; else process.env.GATEWAY_COPILOT_FIXTURE_MODE = value; }); }
  finally { for (const [key, value] of [["PATH", previous.PATH], ["GATEWAY_COPILOT_FIXTURE_MODE", previous.mode], ["GATEWAY_COPILOT_FIXTURE_RECEIPT", previous.receipt]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; } }
}

test("Copilot sums every model call of one request and reports billing detail separately from usage", async () => {
  await withFixture(async (_directory, mode) => {
    const adapter = new CopilotSubscription(provider);
    mode("billing");
    const events = await collect(adapter.infer(request, new AbortController().signal));
    const usageEvents = events.filter(event => event.type === "usage");
    assert.deepEqual(events.filter(event => event.type === "usage" || event.type === "done").map(event => event.type), ["usage", "usage", "done"]);
    assert.equal(usageEvents[0]?.type === "usage" && usageEvents[0].usage.input_tokens, 100, "the first running total is only the first call");
    const done = events.at(-1);
    assert.ok(done?.type === "done");
    assert.deepEqual(done.usage, { input_tokens: 150, output_tokens: 7, total_tokens: 157, input_tokens_details: { cached_tokens: 120 } });
    assert.deepEqual(done.accounting, { cacheWriteTokens: 10, reasoningTokens: 4, nanoAiu: 3e9, nanoAiuStatus: "complete" });
    mode("unpriced");
    const unpriced = (await collect(adapter.infer(request, new AbortController().signal))).at(-1);
    assert.ok(unpriced?.type === "done");
    assert.equal(unpriced.accounting?.nanoAiu, undefined); assert.equal(unpriced.accounting?.nanoAiuStatus, "unavailable");
    assert.equal(unpriced.usage.total_tokens, 13);
  });
});

test("Copilot marks the credit total partial when only some calls were priced or a call reports a partial figure", async () => {
  await withFixture(async (_directory, mode) => {
    const adapter = new CopilotSubscription(provider);
    mode("mixed");
    const mixed = (await collect(adapter.infer(request, new AbortController().signal))).at(-1);
    assert.ok(mixed?.type === "done");
    assert.deepEqual(mixed.accounting, { cacheWriteTokens: 0, reasoningTokens: 0, nanoAiu: 2e9, nanoAiuStatus: "partial" });
    mode("partial");
    const partial = (await collect(adapter.infer(request, new AbortController().signal))).at(-1);
    assert.ok(partial?.type === "done");
    assert.equal(partial.accounting?.nanoAiu, 5e8, "the partial figure is kept as a floor");
    assert.equal(partial.accounting?.nanoAiuStatus, "partial");
  });
});

test("Copilot reports usage before a rejected model route and keeps the temporary session private", async () => {
  await withFixture(async (directory, mode) => {
    const adapter = new CopilotSubscription(provider); const seen: InferenceEvent[] = [];
    mode("model-switch");
    await assert.rejects((async () => { for await (const event of adapter.infer(request, new AbortController().signal)) seen.push(event); })(), /instead of the requested model/);
    assert.ok(seen.some(event => event.type === "usage"), "spend before the rejection is still reported");
    mode(undefined);
    await collect(adapter.infer(request, new AbortController().signal));
    const receipt = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8"));
    assert.equal(receipt.enableSessionStore, false);
    assert.equal(receipt.configDir, receipt.workingDirectory);
    await assert.rejects(stat(receipt.workingDirectory), "the temporary directory is removed after the call");
  });
});
