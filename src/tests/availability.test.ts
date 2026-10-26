import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayToken, writePrivateJson, type GatewayConfig, type ProviderConfig } from "../config.js";
import { startGateway } from "../server.js";
import { ProviderError } from "../providers/provider.js";
import { failureClass, ProviderOutcomes } from "../availability/outcomes.js";
import { probeLocalProvider, isLocalProvider } from "../availability/probe.js";
import { isOpenRouter, parseSpendwatch } from "../availability/quota.js";
import { gatewayQuota, newerQuota, providerRow, type ProviderFacts } from "../availability/report.js";
import { AvailabilityService } from "../availability/service.js";
import { availabilityCommand } from "../availability/cli.js";
import { closedPort } from "./tailnet-fixture.js";

process.env.AVAILABILITY_TEST_KEY = "availability-secret";
const hour = 3_600_000;

test("only failures that say something about availability are kept, without caller cancellations", () => {
  assert.equal(failureClass("usage_limit"), "quota");
  assert.equal(failureClass("upstream_error", "credit_balance_exhausted"), "quota");
  assert.equal(failureClass("upstream_error", "rate_limit_exceeded"), "throttle");
  assert.equal(failureClass("authentication"), "authentication");
  assert.equal(failureClass("upstream_unavailable"), "connection");
  assert.equal(failureClass("invalid_request"), undefined);
  let now = 1_000_000; const outcomes = new ProviderOutcomes(() => now);
  outcomes.failure("codex", "upstream_unavailable", undefined, undefined, "cancelled");
  outcomes.failure("codex", "invalid_request");
  assert.deepEqual(outcomes.get("codex"), {});
  outcomes.failure("codex", "upstream_error", "rate_limit_exceeded", 30_000);
  assert.deepEqual(outcomes.get("codex").lastFailure, { class: "throttle", code: "rate_limit_exceeded", at: now, retryAt: now + 30_000 });
  now += 1; outcomes.success("codex"); assert.equal(outcomes.get("codex").lastSuccessAt, now);
});

test("Spendwatch quota is keyed by lowercased account email and ignores other providers and bad rows", () => {
  const now = Date.parse("2026-10-26T22:00:00Z");
  const output = JSON.stringify([
    { provider: "claude", account: "Fixture@Example.test", usage: { updatedAt: "2026-10-26T21:59:00Z",
      primary: { usedPercent: 34, windowMinutes: 300, resetsAt: "2026-10-26T23:50:00Z" }, secondary: { usedPercent: 73, windowMinutes: 10080, resetsAt: "2026-10-27T01:00:00Z" } } },
    { provider: "claude", account: "expired@example.test", usage: { primary: { usedPercent: 100, windowMinutes: 300, resetsAt: "2026-10-26T20:00:00Z" } } },
    { provider: "codex", account: "other@example.test", usage: { primary: { usedPercent: 10, windowMinutes: 10080 } } },
    { provider: "claude", account: "not-an-email", usage: {} },
  ]);
  const facts = parseSpendwatch(output, "claude", now);
  assert.deepEqual([...facts.keys()], ["fixture@example.test", "expired@example.test"]);
  assert.equal(facts.get("fixture@example.test")!.remainingPercent, 27);
  assert.equal(facts.get("fixture@example.test")!.observedAt, Date.parse("2026-10-26T21:59:00Z"));
  assert.equal(facts.get("expired@example.test")!.remainingPercent, undefined, "a window past its reset proves nothing");
  assert.equal(parseSpendwatch("not json", "claude", now).size, 0);
});

const facts = (extra: Partial<ProviderFacts> = {}): ProviderFacts => ({
  provider: { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "AVAILABILITY_TEST_KEY", models: { "qwen/flash": "flash" } },
  models: ["qwen/flash"], local: true, load: { running: 0, queued: 0, limit: 4 }, outcome: {}, ...extra,
});
const health = (status: "healthy" | "degraded" | "unhealthy", observedAt: number) => ({ status, observedAt, endpoints: { healthy: 1, total: 1 }, servedModels: ["flash"], missingModels: [] });

test("status follows fresh facts only and orders unavailable, limited, unknown, busy and available", () => {
  const now = 10 * hour;
  assert.equal(providerRow(facts(), now).status, "unknown", "an unprobed local server is not known to be up");
  assert.equal(providerRow(facts({ health: health("healthy", now - 1000) }), now).status, "available");
  assert.equal(providerRow(facts({ health: health("healthy", now - 10 * 60_000) }), now).status, "unknown", "stale health");
  assert.equal(providerRow(facts({ health: health("unhealthy", now - 1000) }), now).status, "unavailable");
  assert.equal(providerRow(facts({ health: health("healthy", now - 1000), load: { running: 4, queued: 2, limit: 4 } }), now).status, "busy");
  const quota = { source: "spendwatch" as const, observedAt: now - 2 * hour, windows: [{ minutes: 10080, usedPercent: 100, resetsAt: now + hour }] };
  const limited = providerRow(facts({ local: false, quota }), now);
  assert.equal(limited.status, "limited"); assert.deepEqual(limited.reasons, ["quota_exhausted"]);
  assert.equal(providerRow(facts({ local: false, quota: { ...quota, windows: [{ ...quota.windows[0], resetsAt: now - 1 }] } }), now).status, "available");
  const quotaFailure = { lastFailure: { class: "quota" as const, code: "usage_limit", at: now - hour } };
  assert.equal(providerRow(facts({ local: false, outcome: quotaFailure }), now).status, "limited");
  assert.equal(providerRow(facts({ local: false, outcome: { ...quotaFailure, lastSuccessAt: now - 1000 } }), now).status, "available", "a later success clears it");
  const throttled = { lastFailure: { class: "throttle" as const, code: "rate_limit_exceeded", at: now - 1000, retryAt: now + 5000 } };
  assert.equal(providerRow(facts({ local: false, outcome: throttled }), now).status, "limited");
  assert.equal(providerRow(facts({ local: false, outcome: throttled }), now + 6000).status, "available");
  const balance = { source: "openrouter" as const, observedAt: now - 1000, remainingUsd: 0, totalUsd: 15 };
  assert.equal(providerRow(facts({ local: false, balance }), now).status, "limited");
  assert.equal(providerRow(facts({ local: false, balance: { ...balance, observedAt: now - hour } }), now).status, "available", "an old zero balance is not current");
  assert.equal(providerRow(facts({ local: false, outcome: { lastFailure: { class: "authentication", code: "authentication", at: now - hour } } }), now).status, "unavailable");
});

test("an allowed Claude row never makes an older refused window look newer than Spendwatch", () => {
  const now = 10 * hour; const seconds = (ms: number) => Math.floor(ms / 1000);
  const provider: ProviderConfig = { id: "claude", type: "claude-subscription", models: { "claude/opus": "opus" } };
  const rows = [
    { providerId: "claude", status: "rejected" as const, window: "seven_day" as const, resetsAt: seconds(now + hour), observedAt: seconds(now - 3 * hour) },
    { providerId: "claude", status: "allowed" as const, window: "five_hour" as const, resetsAt: seconds(now + hour), observedAt: seconds(now - 60_000) },
  ];
  const own = gatewayQuota(provider, rows, now)!;
  assert.equal(own.observedAt, seconds(now - 3 * hour) * 1000, "dated by the refused row only");
  const watched = { source: "spendwatch" as const, observedAt: now - hour, windows: [{ minutes: 10080, usedPercent: 40, resetsAt: now + hour }] };
  assert.equal(newerQuota(watched, own), watched);
  assert.equal(providerRow(facts({ provider, local: false, quota: newerQuota(watched, own) }), now).status, "available");
});

test("a tailnet provider never has its balance read from the public OpenRouter API", () => {
  const openrouter: ProviderConfig = { id: "openrouter", type: "responses-api", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "AVAILABILITY_TEST_KEY", models: { "or-x": "x" } };
  assert.equal(isOpenRouter(openrouter), true);
  assert.equal(isOpenRouter({ ...openrouter, type: "chat-completions-api", tailnet: true }), false);
  assert.equal(isOpenRouter({ ...openrouter, baseUrl: "http://openrouter.ai/api/v1" }), false);
});

test("a reload discards in-flight results for the old configuration, and a retired service stops collecting", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const service = new AvailabilityService({ probe: async () => { await gate; return health("healthy", Date.now()); }, accountEmail: async () => undefined, balance: async () => undefined });
  const qwen = local(1); const before: GatewayConfig = { version: 1, port: 0, stateDirectory: "/unused", providers: [qwen] };
  const after: GatewayConfig = { ...before, providers: [{ ...qwen, baseUrl: "http://127.0.0.1:2/v1" }] };
  const load = () => ({ running: 0, queued: 0, limit: 4 });
  try {
    const warming = service.touch(before); service.configure(after); release(); await warming;
    const row = (service.report(after, load, [], new Set()).providers as Array<Record<string, unknown>>)[0];
    assert.equal(row.health, undefined, "a probe of the old base URL is not reported for the new one");
    service.retire(); assert.equal(service.collecting, false);
    await service.touch(after); assert.equal(service.collecting, false, "touch never restarts a retired service");
  } finally { service.stop(); }
});

test("facts about a provider are dropped when its login changes under the same id", async () => {
  const emails = new Map([["/old", "old@example.test"], ["/new", "new@example.test"]]);
  const service = new AvailabilityService({ accountEmail: async provider => emails.get(provider.authDirectory ?? ""), balance: async () => undefined, probe: async () => health("healthy", Date.now()) });
  const claude = (authDirectory: string): GatewayConfig => ({ version: 1, port: 0, stateDirectory: "/unused", availability: { spendwatch: "/fixture/spendwatch" },
    providers: [{ id: "claude", type: "claude-subscription", authDirectory, models: { "claude/opus": "opus" } }] });
  const load = () => ({ running: 0, queued: 0, limit: 4 });
  try {
    const before = claude("/old"); await service.touch(before);
    service.outcomes.failure("claude", "usage_limit");
    assert.equal((service.report(before, load, [], new Set()).providers as Array<Record<string, any>>)[0].status, "limited");
    const after = claude("/new"); service.configure(after);
    const row = (service.report(after, load, [], new Set()).providers as Array<Record<string, any>>)[0];
    assert.equal(row.status, "available"); assert.equal(row.lastFailure, undefined, "the old account's refusal is not the new one's");
  } finally { service.stop(); }
});

test("a request routed before a reload never records its outcome against the replacement account", () => {
  const service = new AvailabilityService();
  const claude = (authDirectory: string): GatewayConfig => ({ version: 1, port: 0, stateDirectory: "/unused",
    providers: [{ id: "claude", type: "claude-subscription", authDirectory, models: { "claude/opus": "opus" } }] });
  service.configure(claude("/old"));
  const routedAs = service.identityOf("claude");
  service.configure(claude("/new"));
  service.recordFailure("claude", routedAs, "usage_limit");
  assert.deepEqual(service.outcomes.get("claude"), {}, "the old account's failure is dropped");
  service.recordFailure("claude", service.identityOf("claude"), "usage_limit");
  assert.equal(service.outcomes.get("claude").lastFailure?.class, "quota");
});

test("an empty Spendwatch row is no observation and never clears a quota refusal", () => {
  const now = 10 * hour;
  const empty = JSON.stringify([{ provider: "claude", account: "fixture@example.test", usage: { updatedAt: new Date(now).toISOString() } }]);
  assert.equal(parseSpendwatch(empty, "claude", now).size, 0);
  const failure = { lastFailure: { class: "quota" as const, code: "usage_limit", at: now - hour } };
  const expired = { source: "spendwatch" as const, observedAt: now - 1000, windows: [{ minutes: 300, usedPercent: 10, resetsAt: now - 1 }] };
  assert.equal(providerRow(facts({ local: false, outcome: failure, quota: expired }), now).status, "limited", "a reading without a live window says nothing");
});

async function modelServer(status = 200, ids = ["flash"]) {
  const seen: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ object: "list", data: ids.map(id => ({ id })) }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { seen, port: (server.address() as { port: number }).port, close: () => { server.closeAllConnections(); server.close(); } };
}
const local = (port: number, extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: "qwen", type: "chat-completions-api", baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "AVAILABILITY_TEST_KEY", models: { "qwen/flash": "flash" }, ...extra });

test("the probe reads served models and reports missing models, rejected keys and unreachable servers", async () => {
  const served = await modelServer(); const empty = await modelServer(200, ["other"]); const rejecting = await modelServer(401);
  try {
    assert.equal(isLocalProvider(local(1)), true);
    assert.equal(isLocalProvider({ ...local(1), baseUrl: "https://openrouter.ai/api/v1" }), false);
    const healthy = await probeLocalProvider(local(served.port));
    assert.equal(healthy.status, "healthy"); assert.deepEqual(healthy.servedModels, ["flash"]); assert.deepEqual(served.seen, ["Bearer availability-secret"]);
    assert.deepEqual(await probeLocalProvider(local(empty.port)).then(fact => [fact.status, fact.reason]), ["unhealthy", "model_missing"]);
    assert.deepEqual(await probeLocalProvider(local(rejecting.port)).then(fact => [fact.status, fact.reason]), ["unhealthy", "rejected"]);
    assert.deepEqual(await probeLocalProvider(local(await closedPort())).then(fact => [fact.status, fact.reason]), ["unhealthy", "unreachable"]);
    assert.deepEqual(await probeLocalProvider(local(served.port, { apiKeyEnv: "AVAILABILITY_MISSING_KEY" })).then(fact => [fact.status, fact.reason]), ["unhealthy", "no_credential"]);
  } finally { served.close(); empty.close(); rejecting.close(); }
});

test("a tailnet probe checks every router address and never sends the key off the tailnet", async () => {
  const served = await modelServer(); const closed = await closedPort();
  const provider = local(0, { baseUrl: "http://dgx.example:4000/v1", tailnet: true });
  const dial = (address: string) => ({ host: "127.0.0.1", port: address === "100.64.0.1" ? served.port : closed });
  try {
    const outside = await probeLocalProvider(provider, { resolve: async () => ["203.0.113.5"], dial });
    assert.deepEqual([outside.status, outside.reason], ["unhealthy", "not_tailnet"]); assert.deepEqual(served.seen, []);
    const both = await probeLocalProvider(provider, { resolve: async () => ["100.64.0.1", "100.64.0.2"], dial });
    assert.equal(both.status, "degraded"); assert.deepEqual(both.endpoints, { healthy: 1, total: 2 }); assert.equal(both.reason, "unreachable");
    assert.deepEqual(served.seen, ["Bearer availability-secret"]);
  } finally { served.close(); }
});

test("the endpoint joins Spendwatch quota by account email and reflects request failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-availability-"));
  const config: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, availability: { spendwatch: "/fixture/spendwatch" }, providers: [
    { id: "claude", type: "claude-subscription", authDirectory: join(directory, "claude"), models: { "claude/opus": "opus" } },
    { id: "qwen", type: "chat-completions-api", baseUrl: "http://dgx.example:4000/v1", tailnet: true, apiKeyEnv: "AVAILABILITY_TEST_KEY", models: { "qwen/flash": "flash" } },
  ] };
  const resetsAt = new Date(Date.now() + hour).toISOString(); const calls: string[] = [];
  const service = new AvailabilityService({
    probe: async () => health("healthy", Date.now() - 5000),
    accountEmail: async provider => provider.id === "claude" ? "fixture@example.test" : undefined,
    spendwatch: async (command, kind) => { calls.push(`${command} ${kind}`); return JSON.stringify([{ provider: "claude", account: "fixture@example.test",
      usage: { updatedAt: new Date().toISOString(), secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt } } }]); },
    balance: async () => undefined,
  });
  const server = await startGateway(config, () => ({ async *infer() { throw new ProviderError("upstream_unavailable", "Provider connection failed", 503); } }), undefined, { availability: service });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  try {
    assert.equal((await fetch(base + "/v1/availability")).status, 401);
    assert.equal((await fetch(base + "/v1/availability?wait=abc", { headers })).status, 400);
    const first = await fetch(base + "/v1/availability?wait=2000", { headers });
    assert.equal(first.headers.get("cache-control"), "no-store");
    const report = await first.json() as { providers: Array<Record<string, any>>; sources: Record<string, string> };
    assert.deepEqual(calls, ["/fixture/spendwatch claude"]); assert.equal(report.sources.spendwatch, "configured");
    const claude = report.providers.find(row => row.id === "claude")!; const qwen = report.providers.find(row => row.id === "qwen")!;
    assert.equal(claude.status, "limited"); assert.equal(claude.quota.account, "fixture@example.test"); assert.equal(claude.quota.remainingPercent, 0);
    assert.equal(qwen.status, "available"); assert.deepEqual(qwen.load, { running: 0, queued: 0, limit: 4 });
    assert.ok(!JSON.stringify(report).includes("availability-secret"));
    const failed = await fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "qwen/flash", input: "fixture" }) });
    await failed.body?.cancel();
    const after = await (await fetch(base + "/v1/availability", { headers })).json() as { providers: Array<Record<string, any>> };
    const row = after.providers.find(entry => entry.id === "qwen")!;
    assert.equal(row.status, "unavailable"); assert.deepEqual(row.reasons, ["connection_failed"]); assert.equal(row.lastFailure.class, "connection");
  } finally { service.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

test("the CLI prints unknown and exits 0 when the gateway cannot answer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-availability-cli-")); const path = join(directory, "gateway.json");
  await writePrivateJson(path, { version: 1, port: await closedPort(), stateDirectory: directory, providers: [{ id: "claude", type: "claude-subscription", models: { "claude/opus": "opus" } }] });
  await gatewayToken(directory);
  try {
    let printed = "";
    assert.equal(await availabilityCommand(["--json", "--wait", "0"], { configPath: async () => path, stdout: text => { printed += text; } }), 0);
    assert.deepEqual(JSON.parse(printed), { object: "availability", status: "unknown", reason: "gateway unreachable", providers: [] });
    printed = "";
    const answer = { providers: [{ id: "qwen", status: "available", reasons: [], load: { running: 1, queued: 0, limit: 4 }, health: { status: "healthy", latencyMs: 12, fresh: true } }] };
    assert.equal(await availabilityCommand([], { configPath: async () => path, stdout: text => { printed += text; }, fetch: async () => new Response(JSON.stringify(answer)) }), 0);
    assert.match(printed, /^qwen\s+available\s+load 1\/4\s+health healthy 12ms\n$/);
    assert.equal(await availabilityCommand(["--bogus"], { configPath: async () => path, stderr: () => {} }), 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
