import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ProviderError } from "../providers/provider.js";
import { configureNetworkRetryTiming, resetNetworkRetryTiming } from "../providers/network-retry.js";

const env = "GATEWAY_NETWORK_RECOVERY_FIXTURE_KEY";
const reset = () => Object.assign(new Error("private socket detail"), { code: "ECONNRESET" });
const complete = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp\",\"status\":\"completed\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0,\"total_tokens\":0}}}\n\n";
const provider = () => new ResponsesAPI({ id: "fixture", type: "responses-api", apiKeyEnv: env, baseUrl: "http://fixture.invalid", models: { fixture: "fixture" } });
async function drain(api: ResponsesAPI) { for await (const _ of api.infer({ model: "fixture", input: "fixture" }, new AbortController().signal)) { /* drain */ } }
async function mocked(sequence: (() => Promise<Response>)[]) {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => sequence[calls++]!();
  try { return { calls: () => calls, result: await drain(provider()) }; }
  finally { globalThis.fetch = original; }
}

test("a raw mocked fetch reset recovers on its retry and spends the outage budget otherwise", async () => {
  process.env[env] = "fixture";
  // The connect budget runs on the suite's fake clock, so a 120 second outage costs no real seconds.
  const state = { spent: 0, started: [] as number[] };
  configureNetworkRetryTiming({ now: () => state.spent, random: () => 0.5, budgetMs: 120000, sleep: async ms => { state.spent += ms; } });
  try {
    const recovered = await mocked([async () => { throw reset(); }, async () => new Response(complete, { headers: { "content-type": "text/event-stream" } })]);
    assert.equal(recovered.calls(), 2); assert.equal(state.spent, 1000);
    state.spent = 0;
    const original = globalThis.fetch; globalThis.fetch = async () => { state.started.push(state.spent); throw reset(); };
    try { await assert.rejects(drain(provider()), (error: unknown) => error instanceof ProviderError && error.upstream?.code === "ECONNRESET"); }
    finally { globalThis.fetch = original; }
    // The budget is spent on whole waits, so the last attempt still starts inside it, never at its edge.
    assert.ok(state.started.length > 10, `the outage was not absorbed, saw ${state.started.length} attempts`);
    assert.ok(state.started.every(at => at < 120000), `an attempt started at ${Math.max(...state.started)}`);
    assert.ok(state.spent < 120000);
  } finally { resetNetworkRetryTiming(); delete process.env[env]; }
});
test("a raw body reset before output retries once, while diagnostic and abort raw failures do not", async () => {
  process.env[env] = "fixture";
  const body = (error: Error) => new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.error(error); } }), { headers: { "content-type": "text/event-stream" } });
  try {
    const recovered = await mocked([async () => body(reset()), async () => new Response(complete, { headers: { "content-type": "text/event-stream" } })]); assert.equal(recovered.calls(), 2);
    for (const error of [Object.assign(new Error("private"), { code: "ENOTFOUND" }), Object.assign(new Error("private"), { code: "ABORT_ERR" })]) {
      let calls = 0; const original = globalThis.fetch; globalThis.fetch = async () => { calls++; return body(error); };
      try { await assert.rejects(drain(provider())); assert.equal(calls, 1); } finally { globalThis.fetch = original; }
    }
  } finally { delete process.env[env]; }
});

test("a localhost socket close before headers recovers on the second request", async () => {
  let calls = 0; const server = createServer((request, response) => {
    request.resume(); calls++;
    if (calls === 1) request.socket.destroy();
    else { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(complete); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); process.env[env] = "fixture";
  const api = new ResponsesAPI({ id: "fixture", type: "responses-api", apiKeyEnv: env, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, models: { fixture: "fixture" } });
  try { await drain(api); assert.equal(calls, 2); }
  finally { delete process.env[env]; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("a native fetch wrapper with an unknown cause is diagnosed but never retried", async () => {
  const original = globalThis.fetch; let calls = 0;
  process.env[env] = "fixture";
  globalThis.fetch = async () => { calls++; throw new TypeError("fetch failed", { cause: Object.assign(new Error("private cause"), { code: "PRIVATE_CODE" }) }); };
  try {
    await assert.rejects(drain(provider()), (error: unknown) => error instanceof ProviderError && error.status === 503 && !error.upstream?.retryableNetwork && !JSON.stringify(error).includes("PRIVATE_CODE"));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; delete process.env[env]; }
});
