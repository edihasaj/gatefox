import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "../config.js";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import { diagnosticDetails } from "../diagnostics-details.js";

const stream = (usage: Record<string, unknown>) => new Response([
  { model: "fixture", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }] },
  { model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { choices: [], usage },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });

test("chat usage carries vLLM prompt_tokens_details.cached_tokens as input_tokens_details, bounded and validated", async t => {
  const key = "GATEWAY_CACHED_USAGE_FIXTURE"; const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  let next: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async () => stream(next));
  const config: ProviderConfig = { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:4000/v1", apiKeyEnv: key,
    models: { "qwen/flash": "fixture" } };
  const done = async (usage: Record<string, unknown>) => {
    next = usage; let last: unknown;
    for await (const event of new ChatCompletionsAPI(config).infer({ model: "fixture", input: "hello" }, new AbortController().signal)) {
      if ((event as { type: string }).type === "done") last = (event as { usage: unknown }).usage;
    }
    return last as { input_tokens: number; input_tokens_details?: { cached_tokens: number } };
  };
  const base = { prompt_tokens: 7556, completion_tokens: 8, total_tokens: 7564 };
  const hit = await done({ ...base, prompt_tokens_details: { cached_tokens: 4800, created_cache_tokens: 0, multimodal_tokens: null } });
  assert.equal(hit.input_tokens, 7556);
  assert.deepEqual(hit.input_tokens_details, { cached_tokens: 4800 });
  const cold = await done({ ...base, prompt_tokens_details: { cached_tokens: 0 } });
  assert.deepEqual(cold.input_tokens_details, { cached_tokens: 0 }, "a measured cold cache is distinct from missing cache data");
  const hot = await done({ ...base, prompt_tokens_details: { cached_tokens: base.prompt_tokens } });
  const diagnostics = diagnosticDetails([cold, hot].map(usage => ({ at: new Date().toISOString(), host: "test", component: "test", pid: 1,
    event: "request_completed", model: "qwen/flash", inputTokens: usage.input_tokens, cachedTokens: usage.input_tokens_details?.cached_tokens })));
  assert.equal(diagnostics.cacheUsage["qwen/flash"].cacheHitPercent, 50);
  assert.equal((await done(base)).input_tokens_details, undefined, "a server without details is unchanged");
  for (const cached_tokens of [-5, "4800", Number.NaN, null]) {
    assert.equal((await done({ ...base, prompt_tokens_details: { cached_tokens } })).input_tokens_details, undefined, String(cached_tokens));
  }
  assert.equal((await done({ ...base, prompt_tokens_details: { cached_tokens: 99999 } })).input_tokens_details, undefined,
    "impossible cache coverage stays unknown instead of manufacturing a perfect cache hit");
});
