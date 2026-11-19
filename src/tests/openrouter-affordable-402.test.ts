import test from "node:test";
import assert from "node:assert/strict";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ProviderError } from "../providers/provider.js";
import { responsesHttpError } from "../providers/responses-errors.js";

const privateMessage = "upstream secret or caller prompt must not escape";
const affordability = (affordable: number) => ({ error: { code: 402, message:
  `This request requires more credits, or fewer max_tokens. You requested up to 384000 tokens, but can only afford ${affordable}. ${privateMessage}`,
  metadata: { limit_source: "openrouter_credits", remedy_hint: privateMessage } } });
const http402 = (body: unknown) => new Response(JSON.stringify(body), { status: 402, headers: { "Content-Type": "application/json" } });

test("an OpenRouter 402 that names an affordable output keeps only that number", async () => {
  const error = await responsesHttpError(http402(affordability(103585)));
  assert.equal(error.code, "insufficient_quota"); assert.equal(error.status, 402);
  assert.equal(error.upstream?.affordableOutputTokens, 103585);
  assert.match(error.message, /can afford 103585 output tokens/);
  assert.doesNotMatch(error.message, /no usable balance/);
  assert.ok(!error.message.includes(privateMessage));
});

test("a 402 without an affordable output still reports an empty balance", async () => {
  for (const body of [{ error: { code: 402, message: "Insufficient credits" } }, affordability(0)]) {
    const error = await responsesHttpError(http402(body));
    assert.equal(error.code, "insufficient_quota");
    assert.match(error.message, /no usable balance/);
  }
});

async function openRouterCalls(responses: Response[], request: Record<string, unknown> = {}): Promise<{ bodies: Record<string, unknown>[]; error: unknown }> {
  const original = globalThis.fetch, key = "GATEWAY_OPENROUTER_402_FIXTURE_KEY"; process.env[key] = "fixture-only";
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return responses.shift() ?? new Response("{}", { status: 500 });
  }) as typeof fetch;
  const provider = new ResponsesAPI({ id: "openrouter", type: "responses-api", apiKeyEnv: key, baseUrl: "https://openrouter.ai/api/v1", models: { "or-deepseek": "deepseek/deepseek-v4.1-flash" } });
  let error: unknown;
  try { for await (const _event of provider.infer({ model: "or-deepseek", input: "fixture", ...request }, new AbortController().signal)) {} }
  catch (caught) { error = caught; }
  finally { globalThis.fetch = original; delete process.env[key]; }
  return { bodies, error };
}
const rejected = () => new Response(JSON.stringify({ error: { code: "invalid_prompt" } }), { status: 400, headers: { "Content-Type": "application/json" } });

test("OpenRouter retries once with the output limit its balance covers", async () => {
  const { bodies, error } = await openRouterCalls([http402(affordability(50000)), rejected()]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].max_output_tokens, undefined);
  assert.equal(bodies[1].max_output_tokens, 50000);
  assert.ok(error instanceof ProviderError); assert.notEqual(error.code, "insufficient_quota");
});

test("OpenRouter keeps the 402 final when the affordable output is too small or not smaller than the request's limit", async () => {
  for (const [affordable, request] of [[100, {}], [50000, { max_output_tokens: 8000 }]] as const) {
    const { bodies, error } = await openRouterCalls([http402(affordability(affordable))], request);
    assert.equal(bodies.length, 1);
    assert.ok(error instanceof ProviderError); assert.equal(error.code, "insufficient_quota");
  }
});
