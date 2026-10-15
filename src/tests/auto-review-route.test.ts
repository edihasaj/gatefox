import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayToken, type GatewayConfig, type ProviderConfig } from "../config.js";
import { modelCatalog } from "../catalog.js";
import { summarizeTelemetry } from "../diagnostics.js";
import { autoReviewTarget, startGateway } from "../server.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { ProviderError, type Provider } from "../providers/provider.js";
import { ResponsesAPI } from "../providers/responses-api.js";
import type { ResponsesRequest } from "../protocol/types.js";

const marker = "POLICY-MARKER-TEXT-THE-SDK-WRITES";
// The request the SDK sends for a review (core/src/client.rs, ext/guardian-reviewer): base instructions as a developer message,
// the tools as an additional_tools item, a strict JSON output schema, low effort, and client metadata.
const reviewRequest = (model: string): ResponsesRequest => ({
  model, stream: true, store: false, tool_choice: "auto", parallel_tool_calls: false, include: ["reasoning.encrypted_content"], prompt_cache_key: "thread-1",
  reasoning: { effort: "low", summary: "auto" }, text: { verbosity: "low", format: { type: "json_schema", name: "codex_output_schema", strict: true, schema: { type: "object", properties: { outcome: { type: "string" } }, required: ["outcome"], additionalProperties: false } } },
  client_metadata: { "x-codex-turn-metadata": "{\"turn_id\":\"t\"}" }, tools: [],
  input: [{ type: "additional_tools", id: "at_1", role: "developer", tools: [] }, { type: "message", role: "developer", content: [{ type: "input_text", text: marker }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "action" }] }],
} as unknown as ResponsesRequest);
const codex = (id: string, models: Record<string, string>, credentialFile = "unused"): ProviderConfig => ({ id, type: "codex-subscription", credentialFile, models });
const claude: ProviderConfig = { id: "claude", type: "claude-subscription", models: { "claude/opus": "opus" } };
const config = (stateDirectory: string, ...providers: ProviderConfig[]): GatewayConfig => ({ version: 1, port: 0, stateDirectory, providers });
const login = { scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], access_token: "fixture-only", expires_at: Date.now() + 3600000 };

async function gateway(directory: string, providers: ProviderConfig[], fail = false) {
  const seen = new Map<string, ResponsesRequest[]>();
  const factory = (provider: ProviderConfig): Provider => ({ async *infer(request) {
    seen.set(provider.id, [...(seen.get(provider.id) ?? []), structuredClone(request)]);
    if (fail) throw new ProviderError("upstream_unavailable", "unavailable", 503);
    yield { type: "text", text: "{\"outcome\":\"allow\"}" }; yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  } });
  const server = await startGateway(config(directory, ...providers), factory);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; const token = await gatewayToken(directory);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return { seen, post: (body: unknown) => fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify(body) }), get: (path: string) => fetch(`${base}${path}`, { headers }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-auto-review-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("the reviewer slug is served through the one Codex route with the request unchanged apart from the model", () => withDirectory(async directory => {
  const g = await gateway(directory, [claude, codex("codex", { "codex/sol": "gpt-6.1-sol" })]);
  try {
    const sent = reviewRequest("codex-auto-review");
    assert.equal((await g.post(sent)).status, 200);
    const [received] = g.seen.get("codex")!; assert.equal(received.model, "codex-auto-review");
    assert.deepEqual({ ...received, model: undefined }, { ...sent, model: undefined }, "text, reasoning, tools, metadata and every input item are unchanged");
    assert.equal(g.seen.has("claude"), false);
    assert.equal(((await (await g.get("/v1/models")).json()) as { data: Array<{ id: string }> }).data.some(row => row.id === "codex-auto-review"), false, "the reviewer is not a chat model");
  } finally { await g.close(); }
}));

test("no Codex route, several Codex accounts, or any other model name give 404 and never reach another provider", () => withDirectory(async directory => {
  const cases: Array<[string, ProviderConfig[], string]> = [
    ["no Codex provider", [claude], "codex-auto-review"],
    ["two Codex accounts", [claude, codex("a", { "a/sol": "gpt-6.1-sol" }), codex("b", { "b/sol": "gpt-6.1-sol" })], "codex-auto-review"],
    ["the API-key reviewer is never routed", [claude, codex("a", { "a/sol": "gpt-6.1-sol" })], "gpt-5.6-luna"],
    ["a near name", [claude, codex("a", { "a/sol": "gpt-6.1-sol" })], "codex-auto-review-2"],
  ];
  for (const [name, providers, model] of cases) {
    const g = await gateway(directory, providers);
    try {
      const response = await g.post(reviewRequest(model));
      assert.equal(response.status, 404, name); assert.equal(((await response.json()) as { error: { code: string } }).error.code, "model_not_found");
      assert.deepEqual([...g.seen.keys()], [], `${name}: no adapter was called`);
    } finally { await g.close(); }
  }
}));

test("an explicit alias for the reviewer keeps its precedence, also with two Codex accounts", () => withDirectory(async directory => {
  const providers = [codex("a", { "a/review": "codex-auto-review", "a/sol": "gpt-6.1-sol" }), codex("b", { "b/sol": "gpt-6.1-sol" })];
  const g = await gateway(directory, providers);
  try {
    assert.equal((await g.post(reviewRequest("codex-auto-review"))).status, 200);
    assert.deepEqual([...g.seen.keys()], ["a"]); assert.equal(g.seen.get("a")![0].model, "codex-auto-review");
    assert.equal(autoReviewTarget(config(directory, ...providers), "codex-auto-review")?.id, "a");
  } finally { await g.close(); }
}));

test("the catalog advertises the reviewer only with a unique Codex route and a stored plan login", () => withDirectory(async directory => {
  const file = (name: string, value: unknown) => writeFile(join(directory, name), JSON.stringify(value), { mode: 0o600 }).then(() => join(directory, name));
  const good = await file("good.json", login); const noScope = await file("scope.json", { ...login, scopes: ["resource.invoke"] });
  await writeFile(join(directory, "broken.json"), "{ not json"); const broken = join(directory, "broken.json");
  const advertised = async (providers: ProviderConfig[]) => {
    const g = await gateway(directory, providers);
    try {
      const body = (await (await g.get("/v1/model-catalog")).json()) as { models: unknown[]; auto_review?: unknown };
      assert.deepEqual(body.models, modelCatalog(config(directory, ...providers)).models, "the rows are the ordinary catalog");
      assert.deepEqual(Object.keys(body).filter(key => key !== "models"), "auto_review" in body ? ["auto_review"] : []);
      return body.auto_review;
    } finally { await g.close(); }
  };
  assert.deepEqual(await advertised([claude, codex("a", { "a/sol": "gpt-6.1-sol" }, good)]), { models: ["codex-auto-review"] });
  assert.equal(await advertised([claude, codex("a", { "a/sol": "gpt-6.1-sol" }, noScope)]), undefined, "a login without the plan scopes");
  assert.equal(await advertised([codex("a", { "a/sol": "gpt-6.1-sol" }, join(directory, "missing.json"))]), undefined, "no login");
  assert.equal(await advertised([codex("a", { "a/sol": "gpt-6.1-sol" }, broken)]), undefined, "an unreadable credential file");
  assert.equal(await advertised([claude]), undefined, "no Codex route");
  assert.equal(await advertised([codex("a", { "a/sol": "gpt-6.1-sol" }, good), codex("b", { "b/sol": "gpt-6.1-sol" }, good)]), undefined, "two accounts: which one is not decided");
  assert.deepEqual(await advertised([codex("a", { "a/review": "codex-auto-review" }, good), codex("b", { "b/sol": "gpt-6.1-sol" }, good)]), { models: ["codex-auto-review"] }, "an alias decides");
  assert.equal(await advertised([{ ...claude, models: { "codex-auto-review": "opus" } }]), undefined, "an alias on another vendor's provider is not a Codex login");
}));

test("telemetry marks reviewer requests with fixed fields only, on success, on 404 and on failure, and diagnostics count them", () => withDirectory(async directory => {
  configureTelemetry(directory, "gateway"); const since = Date.now() - 1000;
  const ok = await gateway(directory, [codex("a", { "a/sol": "gpt-6.1-sol" })]);
  try {
    assert.equal((await ok.post(reviewRequest("codex-auto-review"))).status, 200);
    assert.equal((await ok.post({ model: "a/sol", input: "hello" })).status, 200);
    assert.equal((await ok.post(reviewRequest("gpt-5.6-luna"))).status, 404);
  } finally { await ok.close(); }
  const none = await gateway(directory, [claude]);
  try { assert.equal((await none.post(reviewRequest("codex-auto-review"))).status, 404); } finally { await none.close(); }
  const failing = await gateway(directory, [codex("a", { "a/sol": "gpt-6.1-sol" })], true);
  try { assert.equal((await failing.post({ ...reviewRequest("codex-auto-review"), stream: false })).status, 503); } finally { await failing.close(); }
  await flushTelemetry();
  const events = (await readTelemetry(directory, since)).filter(event => event.event.startsWith("request_"));
  const marked = events.filter(event => event.autoReview === true);
  assert.deepEqual(marked.map(event => [event.event, event.model, event.code ?? null]), [["request_completed", "codex-auto-review", null], ["request_failed", "codex-auto-review", "model_not_found"], ["request_failed", "codex-auto-review", "upstream_unavailable"]]);
  assert.equal(events.filter(event => event.autoReview === undefined).length, 2, "ordinary requests and other names lack the field");
  assert.equal(events.some(event => event.model === "gpt-5.6-luna"), false, "a name outside the allowlist is never recorded");
  assert.equal(JSON.stringify(events).includes(marker), false, "no prompt or policy text reaches telemetry");
  assert.deepEqual((summarizeTelemetry(events, new Date(since)) as { autoReview: Record<string, number> }).autoReview, { completed: 1, "failed:model_not_found": 1, "failed:upstream_unavailable": 1 });
}));

test("ResponsesAPI sends the reviewer request to the subscription endpoint with its model, schema, effort and policy text intact", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-auto-review-wire-"));
  const credentialFile = join(directory, "registration.json"); await writeFile(credentialFile, JSON.stringify(login), { mode: 0o600 });
  const bodies: Array<Record<string, any>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    bodies.push(JSON.parse(String(options.body)));
    const done = { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
    return new Response(`data: ${JSON.stringify(done)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  });
  try {
    const sent = reviewRequest("codex-auto-review");
    for await (const _ of new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, models: {} } as ProviderConfig).infer(structuredClone(sent), new AbortController().signal)) { /* drain */ }
    const body = bodies[0];
    assert.equal(body.model, "codex-auto-review"); assert.deepEqual(body.text, sent.text); assert.deepEqual(body.reasoning, { effort: "low", summary: "auto" });
    assert.deepEqual(body.client_metadata, sent.client_metadata); assert.equal(body.prompt_cache_key, "thread-1"); assert.equal(body.tool_choice, "auto");
    assert.equal(body.input[1].content[0].text, marker, "the SDK's own policy text is byte-equal");
    assert.equal(body.input[0].type, "additional_tools");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
