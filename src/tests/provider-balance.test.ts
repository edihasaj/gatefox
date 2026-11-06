import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "../config.js";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import type { ProviderError } from "../providers/provider.js";
import { responsesHttpError } from "../providers/responses-errors.js";

const key = "GATEWAY_BALANCE_FIXTURE";
const config: ProviderConfig = { id: "api", type: "chat-completions-api", baseUrl: "https://example.test/v1", apiKeyEnv: key, models: { alias: "model" } };
const body = { error: { message: "Insufficient Balance (request_id: secret)", type: "insufficient_balance_error", code: "invalid_request_error" } };

test("an empty account is a final, readable failure on the Responses and Chat paths", async t => {
  process.env[key] = "fixture-only"; t.after(() => { delete process.env[key]; });
  assert.equal((await responsesHttpError(Response.json(body, { status: 402 }))).code, "insufficient_quota");
  assert.equal((await responsesHttpError(Response.json({ error: { type: "insufficient_balance_error" } }, { status: 400 }))).code, "insufficient_quota");
  t.mock.method(globalThis, "fetch", async () => Response.json(body, { status: 402 }));
  const run = async () => { for await (const _ of new ChatCompletionsAPI(config).infer({ model: "model", input: "hello" }, new AbortController().signal)) { /* drain */ } };
  await assert.rejects(run(), (error: ProviderError) => {
    assert.equal(error.code, "insufficient_quota"); assert.equal(error.status, 402);
    assert.match(error.message, /no usable balance/); assert.equal(error.message.includes("secret"), false);
    return true;
  });
});
