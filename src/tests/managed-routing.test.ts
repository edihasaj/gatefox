import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedRouter } from "../managed-routing.js";
import { managedFixture, managedFacts, managedNow, managedRequest, factsRows } from "./managed-routing-fixture.js";
async function fixture(run: (root: string, router: ManagedRouter) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "managed-route-"));
  try { await run(root, new ManagedRouter(root, () => managedNow)); } finally { await rm(root, { recursive: true, force: true }); }
}
test("managed routine uses local capacity, persists its affinity and never reorders an explicit model", () => fixture(async (root, router) => {
  const config = managedFixture(root), report = managedFacts(), request = managedRequest({ instructions: "Do not change my permissions", tools: [] });
  const original = structuredClone(request);
  assert.deepEqual(await router.resolve(config, { ...request, model: "sub/sol" }, {}, report), undefined);
  assert.equal((await router.resolve(config, request, { threadId: "worker-a" }, report))?.alias, "local/qwen");
  const next = new ManagedRouter(root, () => managedNow); factsRows(report)[0].status = "busy";
  assert.deepEqual(await next.resolve(config, request, { threadId: "worker-a" }, report), { alias: "local/qwen", providerId: "local", reused: true, contextBytes: Buffer.byteLength(JSON.stringify(request)) });
  assert.deepEqual(request, original);
  for (const name of await readdir(join(root, "managed-route-pins"))) {
    assert.ok(!(await readFile(join(root, "managed-route-pins", name), "utf8")).includes("worker-a"));
  }
}));
test("a new bounded worker selects subscriptions when local capacity is busy", () => fixture(async (root, router) => {
  const facts = managedFacts(); factsRows(facts)[0].status = "busy";
  assert.equal((await router.resolve(managedFixture(root), managedRequest(), { threadId: "new-worker" }, facts))?.alias, "sub/sol");
}));

test("explicit Flash priority keeps local first and can spend before available subscriptions", () => fixture(async (root, router) => {
  const config = managedFixture(root), facts = managedFacts(), rows = factsRows(facts);
  config.managedRouting!.routes["managed/flash-first"] = { ...config.managedRouting!.routes["managed/routine"]!,
    candidates: ["local/qwen", "paid/flash", "sub/sol", "sub2/sonnet"], preferPaidFlash: true };
  const request = managedRequest({ model: "managed/flash-first" });
  assert.equal((await router.resolve(config, request, { threadId: "local-first" }, facts))?.alias, "local/qwen");
  rows[0].status = "busy";
  assert.equal((await router.resolve(config, request, { threadId: "paid-before-quota" }, facts))?.alias, "paid/flash");
  delete rows[1].quota; delete rows[2].quota;
  assert.equal((await router.resolve(config, request, { threadId: "explicit-paid-unknown-quota" }, facts))?.alias, "paid/flash");
  rows[0].status = "available";
  assert.equal((await router.resolve(config, request, { threadId: "paid-before-quota" }, facts))?.alias, "paid/flash", "existing paid workers keep their binding when local capacity returns");
  assert.equal((await router.resolve(config, managedRequest(), { threadId: "legacy-local" }, facts))?.alias, "local/qwen");
}));

test("Flash priority still requires fresh balance and never replays an existing pin", () => fixture(async (root, router) => {
  const config = managedFixture(root), facts = managedFacts(), rows = factsRows(facts);
  config.managedRouting!.routes["managed/routine"]!.preferPaidFlash = true;
  config.managedRouting!.routes["managed/routine"]!.candidates = ["local/qwen", "paid/flash", "sub/sol", "sub2/sonnet"];
  rows[0].status = "unavailable";
  assert.equal((await router.resolve(config, managedRequest(), { threadId: "paid-pin" }, facts))?.alias, "paid/flash");
  rows[3].balance = { fresh: false, remainingUsd: 20, observedAt: new Date(managedNow).toISOString() };
  assert.equal((await router.resolve(config, managedRequest(), { threadId: "stale-balance" }, facts))?.alias, "sub/sol");
  await assert.rejects(router.resolve(config, managedRequest(), { threadId: "paid-pin" }, facts), { code: "managed_route_unavailable" });
  rows[3].balance = { fresh: true, remainingUsd: 0, observedAt: new Date(managedNow).toISOString() };
  assert.equal((await router.resolve(config, managedRequest(), { threadId: "zero-balance" }, facts))?.alias, "sub/sol");
}));

test("a wider coding policy admits a realistic instruction/tool scaffold without widening legacy pins", () => fixture(async (root, router) => {
  const config = managedFixture(root), old = structuredClone(config.managedRouting!.routes["managed/routine"]);
  config.managedRouting!.routes["managed/coding"] = { ...old, contextWindow: 131072, maxContextBytes: 1048576, autoCompactTokenLimit: 104857 };
  const request = managedRequest({ model: "managed/coding", instructions: "s".repeat(300000) });
  assert.equal((await router.resolve(config, request, { threadId: "wide-scaffold" }, managedFacts()))?.alias, "local/qwen");
  await assert.rejects(router.resolve(config, { ...request, model: "managed/routine" }, { threadId: "legacy-scaffold" }, managedFacts()), (error: { code?: string }) => error.code === "context_length_exceeded");
  assert.deepEqual(config.managedRouting!.routes["managed/routine"], old);
  await assert.rejects(router.resolve(config, { ...request, instructions: "s".repeat(1048576) }, { threadId: "still-bounded" }, managedFacts()), (error: { code?: string }) => error.code === "context_length_exceeded");
}));
test("xhigh workers retain exact effort and never downgrade to an incompatible Flash candidate", () => fixture(async (root, router) => {
  const config = managedFixture(root), facts = managedFacts();
  config.providers[0].modelMetadata!["local/qwen"].reasoningEfforts!.push("xhigh");
  config.providers[1].modelMetadata!["sub/sol"].reasoningEfforts!.push("xhigh");
  const request = managedRequest({ reasoning: { effort: "xhigh" } });
  assert.equal((await router.resolve(config, request, { threadId: "xhigh-local" }, facts))?.alias, "local/qwen");
  factsRows(facts)[0].status = "unavailable";
  assert.equal((await router.resolve(config, request, { threadId: "xhigh-sub" }, facts))?.alias, "sub/sol");
  for (const row of factsRows(facts).slice(1, 3)) { row.status = "unavailable"; row.reasons = ["authentication"]; }
  await assert.rejects(router.resolve(config, request, { threadId: "xhigh-refused" }, facts), (error: { code?: string }) => error.code === "managed_route_unavailable");
  assert.deepEqual(request.reasoning, { effort: "xhigh" });
}));
test("an opt-in implementation policy raises only Qwen while subscription fallback keeps medium", () => fixture(async (root, router) => {
  const config = managedFixture(root), facts = managedFacts();
  config.providers[0].modelMetadata!["local/qwen"].reasoningEfforts!.push("xhigh");
  config.managedRouting!.routes["managed/routine"].candidateReasoningEfforts = { "local/qwen": "xhigh" };
  const request = managedRequest({ reasoning: { effort: "medium", summary: "none" } });
  const selected = await router.resolve(config, request, { threadId: "implementation-qwen" }, facts);
  assert.equal(selected?.reasoningEffort, "xhigh");
  factsRows(facts)[0].status = "unavailable";
  const fallback = await router.resolve(config, request, { threadId: "implementation-sub" }, facts);
  assert.equal(fallback?.alias, "sub/sol"); assert.equal(fallback?.reasoningEffort, undefined);
  assert.deepEqual(request.reasoning, { effort: "medium", summary: "none" });
}));
test("subscription reserve and stale quota select the next known subscription, not paid capacity", () => fixture(async (root, router) => {
  const facts = managedFacts(), rows = factsRows(facts); rows[0].status = "unavailable";
  rows[1].quota = { fresh: true, observedAt: new Date(managedNow).toISOString(), remainingPercent: 2 };
  assert.equal((await router.resolve(managedFixture(root), managedRequest(), { threadId: "reserve" }, facts))?.alias, "sub2/sonnet");
  rows[1].quota = { fresh: false, observedAt: new Date(managedNow - 9999999).toISOString(), remainingPercent: 90 };
  assert.equal((await router.resolve(managedFixture(root), managedRequest(), { threadId: "stale" }, facts))?.alias, "sub2/sonnet");
}));
test("Flash requires confirmed subscription blockers and fresh positive paid balance", () => fixture(async (root, router) => {
  const config = managedFixture(root), facts = managedFacts(), rows = factsRows(facts); rows[0].status = "unavailable";
  for (const row of rows.slice(1, 3)) { row.status = "limited"; row.reasons = ["quota_exhausted"]; }
  assert.equal((await router.resolve(config, managedRequest(), { threadId: "paid-worker" }, facts))?.alias, "paid/flash");
  rows[3].balance = { fresh: false, observedAt: new Date(managedNow).toISOString(), remainingUsd: 20 };
  await assert.rejects(router.resolve(config, managedRequest(), { threadId: "stale-paid" }, facts), { code: "managed_route_unavailable" });
}));
test("unknown quota and busy subscriptions never authorize paid escalation", () => fixture(async (root, router) => {
  const config = managedFixture(root), facts = managedFacts(), rows = factsRows(facts); rows[0].status = "unavailable";
  rows[1].status = "busy"; delete rows[2].quota;
  await assert.rejects(router.resolve(config, managedRequest(), { threadId: "unknown-worker" }, facts), { code: "managed_route_unavailable" });
  rows[1].status = "limited"; rows[1].reasons = ["quota_exhausted"];
  await assert.rejects(router.resolve(config, managedRequest(), { threadId: "unknown-sub" }, facts), { code: "managed_route_unavailable" });
}));
test("an unavailable pinned route never replays the conversation onto another model", () => fixture(async (root, router) => {
  const config = managedFixture(root), facts = managedFacts(), context = { threadId: "keep-context" };
  await router.resolve(config, managedRequest(), context, facts); factsRows(facts)[0].status = "unavailable";
  await assert.rejects(router.resolve(config, managedRequest(), context, facts), { code: "managed_route_unavailable" });
  assert.equal((await router.resolve(config, managedRequest(), { threadId: "explicit-handoff" }, facts))?.alias, "sub/sol");
}));
test("identity, byte budget and unbound opaque continuation are rejected before a pin is created", () => fixture(async (root, router) => {
  const config = managedFixture(root), facts = managedFacts();
  await assert.rejects(router.resolve(config, managedRequest(), {}, facts), { code: "managed_route_identity_required" });
  await assert.rejects(router.resolve(config, managedRequest({ input: "x".repeat(262144) }), { threadId: "huge" }, facts), { code: "context_length_exceeded" });
  await assert.rejects(router.resolve(config, managedRequest({ previous_response_id: "opaque" }), { threadId: "opaque" }, facts), { code: "managed_route_state_unbound" });
}));
test("compaction has bounded recovery room on the persisted worker binding only", () => fixture(async (root, router) => {
  const config = managedFixture(root), facts = managedFacts(), context = { threadId: "compact-worker" };
  const limit = config.managedRouting!.routes["managed/routine"]!.maxContextBytes;
  const large = managedRequest({ input: "x".repeat(limit + 10) });
  await router.resolve(config, managedRequest(), context, facts);
  await assert.rejects(router.resolve(config, large, context, facts), { code: "context_length_exceeded" });
  const reopened = new ManagedRouter(root, () => managedNow);
  const recovery = { ...context, requestKind: "compaction" as const };
  assert.equal((await reopened.resolve(config, large, recovery, facts))?.alias, "local/qwen");
  assert.equal((await reopened.resolve(config, large, recovery, facts))?.reused, true);
  await assert.rejects(reopened.resolve(config, large, { ...recovery, threadId: "new-compact" }, facts), { code: "managed_route_state_unbound" });
  await assert.rejects(reopened.resolve(config, managedRequest({ input: "x".repeat(limit * 4) }), recovery, facts), { code: "context_length_exceeded" });
  factsRows(facts)[0].status = "unavailable";
  await assert.rejects(reopened.resolve(config, large, recovery, facts), { code: "managed_route_unavailable" });
}));
test("compaction recovery cannot exceed the global four MiB ceiling", () => fixture(async (root, router) => {
  const config = managedFixture(root), facts = managedFacts();
  config.managedRouting!.routes["managed/routine"]!.maxContextBytes = 4194304;
  const context = { threadId: "compact-ceiling" };
  await router.resolve(config, managedRequest(), context, facts);
  await assert.rejects(router.resolve(config, managedRequest({ input: "x".repeat(4194304) }), { ...context, requestKind: "compaction" }, facts), { code: "context_length_exceeded" });
}));
test("configuration and configured provider binding changes cannot silently move a saved worker", () => fixture(async (root, router) => {
  const config = managedFixture(root), facts = managedFacts(), context = { threadId: "bound" };
  await router.resolve(config, managedRequest(), context, facts);
  config.providers[0].baseUrl = "http://127.0.0.1:4000/v1";
  await assert.rejects(router.resolve(config, managedRequest(), context, facts), { code: "managed_route_changed" });
  config.providers[0].baseUrl = "http://127.0.0.1:3000/v1"; config.managedRouting!.routes["managed/routine"]!.maxContextBytes++;
  await assert.rejects(router.resolve(config, managedRequest(), context, facts), { code: "managed_route_changed" });
}));
test("a paid pin stops when subscription capacity returns, rather than silently changing provider", () => fixture(async (root, router) => {
  const config = managedFixture(root), facts = managedFacts(), rows = factsRows(facts), context = { threadId: "paid-pinned" };
  rows[0].status = "unavailable";
  for (const row of rows.slice(1, 3)) { row.status = "limited"; row.reasons = ["quota_exhausted"]; }
  await router.resolve(config, managedRequest(), context, facts);
  rows[1].status = "available"; rows[1].reasons = [];
  await assert.rejects(router.resolve(config, managedRequest(), context, facts), { code: "managed_route_unavailable" });
}));
test("requested reasoning and modalities select only a compatible candidate", () => fixture(async (root, router) => {
  const config = managedFixture(root), facts = managedFacts();
  config.providers[0].modelMetadata!["local/qwen"]!.reasoningEfforts = ["low"];
  assert.equal((await router.resolve(config, managedRequest({ reasoning: { effort: "high" } }), { threadId: "effort" }, facts))?.alias, "sub/sol");
  await assert.rejects(router.resolve(config, managedRequest({ reasoning: { effort: "unknown" } }), { threadId: "no-effort" }, facts), { code: "managed_route_unavailable" });
}));
test("native tool requirements cannot be silently discarded by selecting a different transport", () => fixture(async (root, router) => {
  const config = managedFixture(root), facts = managedFacts(); config.providers[1].toolSearch = "bridge";
  assert.equal((await router.resolve(config, managedRequest({ tools: [{ type: "tool_search" }] }), { threadId: "search-worker" }, facts))?.alias, "sub/sol");
  delete config.providers[1].toolSearch;
  await assert.rejects(router.resolve(config, managedRequest({ tools: [{ type: "tool_search" }] }), { threadId: "unsupported-search" }, facts), { code: "managed_route_unavailable" });
}));
