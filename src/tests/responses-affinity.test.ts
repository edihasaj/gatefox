import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResponsesAPI } from "../providers/responses-api.js";
import { inferenceContext } from "../providers/provider.js";
import type { ProviderConfig } from "../config.js";

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const completed = () => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });

test("caller session and thread headers are read strictly", () => {
  assert.deepEqual(inferenceContext({ "session-id": "019a-session", "thread-id": "019a-thread" }), { sessionId: "019a-session", threadId: "019a-thread" });
  assert.deepEqual(inferenceContext({ session_id: "legacy-session" }), { sessionId: "legacy-session" });
  for (const value of ["", "a".repeat(129), "line\nbreak", "space here", ["a", "b"]]) assert.deepEqual(inferenceContext({ "session-id": value as string, "thread-id": value as string }), {});
});

test("the subscription endpoint receives the caller's routing headers so its prompt cache stays warm", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-affinity-test-"));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  const seen: Array<Record<string, string>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => { seen.push({ ...(options.headers as Record<string, string>) }); return completed(); });
  const plan = new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, models: { "codex/upstream": "upstream" } } as ProviderConfig);
  const api = new ResponsesAPI({ id: "api", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "GATEWAY_AFFINITY_FIXTURE_KEY", models: { fixture: "upstream" } } as ProviderConfig);
  process.env.GATEWAY_AFFINITY_FIXTURE_KEY = "fixture-only";
  try {
    for await (const _ of plan.infer({ model: "upstream", input: "fixture" }, new AbortController().signal, { sessionId: "s-1", threadId: "t-1" })) { /* drain */ }
    assert.equal(seen.at(-1)?.["session-id"], "s-1"); assert.equal(seen.at(-1)?.["thread-id"], "t-1");
    for await (const _ of plan.infer({ model: "upstream", input: "fixture" }, new AbortController().signal)) { /* drain */ }
    assert.equal(seen.at(-1)?.["session-id"], undefined);
    // Third-party Responses endpoints keep only the cache key Codex puts in the body.
    for await (const _ of api.infer({ model: "upstream", input: "fixture" }, new AbortController().signal, { sessionId: "s-1", threadId: "t-1" })) { /* drain */ }
    assert.equal(seen.at(-1)?.["session-id"], undefined); assert.equal(seen.at(-1)?.["thread-id"], undefined);
  } finally { delete process.env.GATEWAY_AFFINITY_FIXTURE_KEY; await rm(directory, { recursive: true, force: true }); }
});
