import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gatewayToken } from "../config.js";
import { startGateway } from "../server.js";
import { AvailabilityService } from "../availability/service.js";
import type { Provider } from "../providers/provider.js";
import type { ResponsesRequest } from "../protocol/types.js";
import { managedFixture } from "./managed-routing-fixture.js";
import { modelCatalog } from "../catalog.js";
import { gatewayModelList } from "../app-server-model-list.js";

test("the real Responses path selects a managed provider, preserves context and keeps explicit routes fixed", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-http-"));
  const config = managedFixture(root); const seen: Array<{ provider: string; request: ResponsesRequest }> = [];
  const availability = new AvailabilityService({
    probe: async () => ({ status: "healthy", observedAt: Date.now(), endpoints: { healthy: 1, total: 1 }, servedModels: ["qwen"], missingModels: [] }),
    accountEmail: async () => undefined, balance: async () => undefined,
  });
  const server = await startGateway(config, provider => ({ async *infer(request) {
    seen.push({ provider: provider.id, request }); yield { type: "text", text: "ok" };
    yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  } } satisfies Provider), undefined, { availability });
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { Authorization: `Bearer ${await gatewayToken(root)}`, "Content-Type": "application/json", "thread-id": "worker-http" };
    const body: ResponsesRequest = { model: "managed/routine", instructions: "Caller permissions and instructions", input: [{ role: "user", content: "Bounded task" }], tools: [] };
    let response = await fetch(origin + "/v1/responses", { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("x-gateway-managed-route"), "local/qwen"); assert.equal(response.headers.get("x-gateway-managed-reused"), "false"); await response.json();
    assert.equal(seen[0].provider, "local"); assert.equal(seen[0].request.instructions, body.instructions); assert.deepEqual(seen[0].request.input, body.input); assert.deepEqual(seen[0].request.tools, []);
    response = await fetch(origin + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ ...body, model: "sub/sol" }) });
    assert.equal(response.status, 200); await response.json(); assert.equal(seen[1].provider, "sub"); assert.equal(response.headers.get("x-gateway-managed-route"), null);
    response = await fetch(origin + "/v1/responses", { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("x-gateway-managed-reused"), "true"); await response.json();
    const advertised = await (await fetch(origin + "/v1/models", { headers })).json() as { data: Array<{ id: string }> };
    assert.ok(!advertised.data.some(m => m.id.startsWith("managed/")));
    assert.ok(advertised.data.some(m => m.id === "local/qwen"), "named models remain offered");
    const row = modelCatalog(config).models.find(m => m.slug === "managed/routine");
    assert.equal(row?.visibility, "hide");
    const catalog = await (await fetch(origin + "/v1/model-catalog", { headers })).json() as { models: Array<Record<string, unknown>> };
    assert.equal(catalog.models.find(m => m.slug === "managed/routine")?.visibility, "hide");
    const native = async () => ({ data: [], nextCursor: null });
    const visible = await gatewayModelList({}, native, new Set(), modelCatalog(config).models, undefined);
    assert.ok(!(visible.data as Array<Record<string, unknown>>).some(m => m.model === "managed/routine"));
    const full = await gatewayModelList({ includeHidden: true }, native, new Set(), modelCatalog(config).models, undefined);
    assert.equal((full.data as Array<Record<string, unknown>>).find(m => m.model === "managed/routine")?.hidden, true);
    assert.equal(row?.context_window, 32768); assert.deepEqual(row?.model_messages, { instructions_template: "" }); assert.equal(row?.supports_search_tool, false);
    assert.equal(row?.multi_agent_version, "v2", "managed workers retain the Gateway collaboration protocol across candidate models");
    const before = seen.length;
    response = await fetch(origin + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ ...body, input: "x".repeat(262144) }) });
    assert.equal(response.status, 400); assert.equal(seen.length, before);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "context_length_exceeded");
  } finally { availability.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("managed routing never retries another provider after a partial stream or a quota failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-stream-")); const config = managedFixture(root); const calls: string[] = [];
  const availability = new AvailabilityService({ probe: async () => ({ status: "healthy", observedAt: Date.now(), endpoints: { healthy: 1, total: 1 }, servedModels: ["qwen"], missingModels: [] }), accountEmail: async () => undefined, balance: async () => undefined });
  const { ProviderError } = await import("../providers/provider.js");
  const server = await startGateway(config, p => ({ async *infer() { calls.push(p.id); yield { type: "text", text: "partial" }; throw new ProviderError("usage_limit", "Fixture refused", 429); } }), undefined, { availability });
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/responses`, { method: "POST", headers: { Authorization: `Bearer ${await gatewayToken(root)}`, "Content-Type": "application/json", "thread-id": "partial-stream" }, body: JSON.stringify({ model: "managed/routine", input: "Task", stream: true }) });
    const text = await response.text(); assert.match(text, /partial/); assert.match(text, /response.failed/); assert.deepEqual(calls, ["local"]);
  } finally { availability.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("the real request path automatically selects a subscription when local health is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-subscription-")); const config = managedFixture(root); config.availability = { spendwatch: "/fixture/spendwatch" }; const calls: string[] = [];
  const availability = new AvailabilityService({
    probe: async () => ({ status: "unhealthy", observedAt: Date.now(), endpoints: { healthy: 0, total: 1 }, servedModels: [], missingModels: ["qwen"] }),
    accountEmail: async p => p.id + "@example.test",
    spendwatch: async (_command, kind) => JSON.stringify([{ provider: kind, account: (kind === "codex" ? "sub" : "sub2") + "@example.test", usage: { updatedAt: new Date().toISOString(), primary: { windowMinutes: 300, usedPercent: 20 } } }]),
    balance: async () => ({ source: "openrouter", observedAt: Date.now(), totalUsd: 20, remainingUsd: 20 }),
  });
  const server = await startGateway(config, p => ({ async *infer() { calls.push(p.id); yield { type: "text", text: "ok" }; yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }; } }), undefined, { availability });
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/responses`, { method: "POST", headers: { Authorization: `Bearer ${await gatewayToken(root)}`, "Content-Type": "application/json", "thread-id": "new-sub-worker" }, body: JSON.stringify({ model: "managed/routine", input: "Fresh bounded task" }) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("x-gateway-managed-route"), "sub/sol"); await response.json(); assert.deepEqual(calls, ["sub"]);
  } finally { availability.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("Messages clients receive the native compaction signal when a managed context budget is exceeded", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-messages-")); const config = managedFixture(root); let calls = 0;
  const availability = new AvailabilityService({ probe: async () => ({ status: "healthy", observedAt: Date.now(), endpoints: { healthy: 1, total: 1 }, servedModels: ["qwen"], missingModels: [] }), accountEmail: async () => undefined, balance: async () => undefined });
  const server = await startGateway(config, () => ({ async *infer() { calls++; yield { type: "text", text: "unexpected" }; } }), undefined, { availability });
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/messages`, { method: "POST", headers: { "x-api-key": await gatewayToken(root), "Content-Type": "application/json", "session-id": "messages-worker" }, body: JSON.stringify({ model: "managed/routine", max_tokens: 10, messages: [{ role: "user", content: "x".repeat(262144) }] }) });
    assert.equal(response.status, 400); const error = await response.json() as { error: { type: string; message: string } };
    assert.equal(error.error.type, "invalid_request_error"); assert.match(error.error.message, /prompt is too long/); assert.equal(calls, 0);
  } finally { availability.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
