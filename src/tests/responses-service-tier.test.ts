import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResponsesAPI } from "../providers/responses-api.js";
import type { InferenceEvent } from "../protocol/types.js";
import type { ProviderConfig } from "../config.js";

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const collect = async (provider: ResponsesAPI, tier: unknown) => {
  const events: InferenceEvent[] = [];
  for await (const event of provider.infer({ model: "upstream", input: "fixture", service_tier: tier }, new AbortController().signal)) events.push(event);
  return events;
};

test("Codex Fast aliases use priority on the wire and preserve the tier actually served", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-tier-test-"));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  const bodies: Record<string, unknown>[] = [];
  let actual: unknown = "default";
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    bodies.push(JSON.parse(String(options.body)));
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage, service_tier: actual } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  });
  const config: ProviderConfig = { id: "secondary", type: "codex-subscription", credentialFile, models: { "secondary/upstream": "upstream" }, modelMetadata: { "secondary/upstream": { serviceTiers: [{ id: "priority", name: "Fast", description: "Fixture" }] } } };
  try {
    const provider = new ResponsesAPI(config);
    assert.deepEqual((await collect(provider, "fast")).at(-1), { type: "done", usage, serviceTier: "default" });
    assert.equal(bodies.at(-1)?.service_tier, "priority");
    actual = "priority";
    assert.deepEqual((await collect(provider, "priority")).at(-1), { type: "done", usage, serviceTier: "priority" });
    assert.equal(bodies.at(-1)?.service_tier, "priority");
    for (const tier of [undefined, null, "default", "auto"]) {
      await collect(provider, tier);
      assert.equal(bodies.at(-1)?.service_tier, tier ?? undefined);
    }
    for (const tier of [undefined, "untrusted-private-tier", { secret: "fixture" }]) {
      actual = tier;
      assert.deepEqual((await collect(provider, "priority")).at(-1), { type: "done", usage });
    }
    const count = bodies.length;
    const unsupported = new ResponsesAPI({ ...config, modelMetadata: { "secondary/upstream": { serviceTiers: [] } } });
    await assert.rejects(collect(unsupported, "priority"), { code: "invalid_request", status: 400 });
    assert.equal(bodies.length, count, "unsupported model must not send inference");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invalid tier input fails before authentication or inference; ordinary API tiers keep their wire values", async t => {
  const env = "GATEWAY_SERVICE_TIER_FIXTURE_KEY";
  const config: ProviderConfig = { id: "api", type: "responses-api", models: { fixture: "upstream" }, baseUrl: "http://127.0.0.1:1", apiKeyEnv: env };
  const provider = new ResponsesAPI(config);
  for (const tier of [true, 1, {}, "unknown", "PRIORITY"]) await assert.rejects(collect(provider, tier), { code: "invalid_request", status: 400 });
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    bodies.push(JSON.parse(String(options.body)));
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage } })}\n\n`);
  });
  process.env[env] = "fixture-only";
  try {
    for (const tier of ["auto", "default", "flex", "scale", "priority", "fast", "ultrafast"]) {
      await collect(provider, tier);
      assert.equal(bodies.at(-1)?.service_tier, tier);
    }
  } finally { delete process.env[env]; }
});
