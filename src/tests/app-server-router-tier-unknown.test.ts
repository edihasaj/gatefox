import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadServiceTiers } from "../thread-service-tiers.js";
import { AppServerRouter } from "../app-server-router.js";
import type { GatewayConfig } from "../config.js";
import { oldBuildAccepts } from "./thread-tier-0-4-0-parser.js";

type ObjectValue = Record<string, unknown>;
const gateway = "subscription_gateway";
const codex = "codex/model";
const oddTiers = ["auto", "Fast", "PRIORITY", "x".repeat(200)];
const label = (tier: string) => tier.slice(0, 12);
const noTier = (params: ObjectValue) => !Object.hasOwn(params, "serviceTier");

/**
 * A minimal SDK: a session start keeps the tier it is given when the model offers it, a loaded chat answers with the
 * tier it kept, and a running chat keeps any string. Announcements are sent by the test so their timing is explicit.
 */
async function fixture() {
  const state = await mkdtemp(join(tmpdir(), "gateway-tier-unknown-"));
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory: state, providers: [
    { id: "codex", type: "codex-subscription", label: "Codex", credentialFile: "unused", models: { [codex]: "model" },
      modelMetadata: { [codex]: { serviceTiers: [{ id: "priority", name: "Fast", description: "Priority routing" }] } } },
  ] };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const sdk = { tier: null as unknown };
  const control = { loaded: false, answerId: "t", during: undefined as (() => Promise<void>) | undefined };
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "model/list") return { data: [], nextCursor: null };
    if (method === "thread/read") return { thread: { id: "t", modelProvider: gateway, model: codex } };
    if (["thread/start", "thread/resume", "thread/fork"].includes(method)) {
      await control.during?.();
      if (control.loaded) return { thread: { id: control.answerId }, modelProvider: gateway, model: codex, serviceTier: sdk.tier };
      sdk.tier = Object.hasOwn(params, "serviceTier") ? params.serviceTier ?? null : null;
      return { thread: { id: control.answerId }, modelProvider: params.modelProvider, model: params.model, serviceTier: sdk.tier };
    }
    return { status: "applied" };
  };
  const nativeHome = join(state, "native-home");
  const connect = async () => { const connected = new AppServerRouter(config, backend, undefined, undefined, nativeHome); await connected.initialize(); return connected; };
  const store = new ThreadServiceTiers(state, nativeHome);
  const announce = (router: AppServerRouter, tier: string | null, emittedAtMs: number, threadId = "t") => router.observeNotification({ emittedAtMs, method: "thread/settings/updated",
    params: { threadId, threadSettings: { modelProvider: gateway, model: codex, serviceTier: tier } } });
  const last = () => calls.at(-1)!;
  const file = async () => join(state, (await readdir(state)).find(name => name.startsWith("desktop-thread-tiers-"))!);
  return { router: await connect(), connect, store, announce, control, sdk, last, calls, file };
}

// A resume answers with the tier the SDK started (Standard here), which the gateway then records, so each method gets its own chat.
const methods = ["thread/resume", "thread/fork"];

test("a cold resume or fork on a fresh connection sends no tier after an odd tier replaced Fast", async () => {
  for (const tier of oddTiers) for (const method of methods) {
    const f = await fixture();
    await f.router.request("thread/start", { model: codex, serviceTier: "priority" });
    assert.equal((await f.store.read("t"))?.serviceTier, "priority", "the chat starts Fast");
    await f.router.request("thread/settings/update", { threadId: "t", serviceTier: tier });
    await f.announce(f.router, tier, Date.now() + 100);
    // The app restarted: the chat is not loaded and the connection never saw the notification.
    f.control.loaded = false;
    const fresh = await f.connect();
    await fresh.request(method, { threadId: "t" });
    assert.equal(f.last().method, method);
    assert.ok(noTier(f.last().params), `${method} sent ${String(f.last().params.serviceTier)} after ${label(tier)}`);
    assert.equal(f.last().params.model, codex);
  }
});

test("an odd tier learned from a loaded resume answer leaves no older tier for a later cold start", async () => {
  for (const tier of oddTiers) for (const method of methods) {
    const f = await fixture();
    await f.router.request("thread/start", { model: codex, serviceTier: "priority" });
    // The SDK moved the chat to an odd tier and this process never heard about it, then answers a loaded resume with it.
    f.sdk.tier = tier; f.control.loaded = true;
    await (await f.connect()).request("thread/resume", { threadId: "t" });
    assert.equal(await f.store.read("t"), undefined, label(tier));
    f.control.loaded = false;
    await (await f.connect()).request(method, { threadId: "t" });
    assert.ok(noTier(f.last().params), `${method} sent ${String(f.last().params.serviceTier)} after ${label(tier)}`);
  }
});

test("a fork the SDK answers with an odd tier starts unknown, blocks older tiers, and leaves the parent's tier alone", async () => {
  const f = await fixture();
  await f.router.request("thread/start", { model: codex, serviceTier: "priority" });
  f.sdk.tier = "auto"; f.control.loaded = true; f.control.answerId = "fork";
  await f.router.request("thread/fork", { threadId: "t", model: codex });
  assert.equal(await f.store.read("fork"), undefined);
  assert.equal((await f.store.read("t"))?.serviceTier, "priority");
  // A notification stamped before the fork answer cannot give the new chat a tier.
  await f.announce(await f.connect(), "priority", Date.now() - 5000, "fork");
  assert.equal(await f.store.read("fork"), undefined);
  f.control.loaded = false;
  await (await f.connect()).request("thread/resume", { threadId: "fork" });
  assert.ok(noTier(f.last().params));
});

test("a late older notification after an odd one cannot bring a tier back", async () => {
  for (const tier of oddTiers) for (const method of methods) {
    const f = await fixture();
    await f.router.request("thread/start", { model: codex, serviceTier: "priority" });
    const odd = Date.now() + 800; const older = Date.now() + 400;
    await f.announce(f.router, tier, odd);
    // A slower client delivers an older Fast, and an older Standard, to a connection that never saw the odd one.
    const late = await f.connect();
    for (const stale of ["priority", null]) {
      await f.announce(late, stale, older);
      assert.equal(await f.store.read("t"), undefined, `${String(stale)} after ${label(tier)}`);
    }
    await f.announce(f.router, "priority", older);
    assert.equal(await f.store.read("t"), undefined);
    await (await f.connect()).request(method, { threadId: "t" });
    assert.ok(noTier(f.last().params), `${method} sent ${String(f.last().params.serviceTier)} after ${label(tier)}`);
    // A notification newer than the odd one is still honored.
    await f.announce(late, "priority", odd + 100);
    assert.equal((await f.store.read("t"))?.serviceTier, "priority");
  }
});

test("a valid tier chosen after an odd one is inherited again and the marker no longer applies", async () => {
  const f = await fixture();
  await f.router.request("thread/start", { model: codex, serviceTier: "priority" });
  await f.announce(f.router, "auto", Date.now() + 100);
  await f.announce(f.router, "priority", Date.now() + 200);
  await (await f.connect()).request("thread/fork", { threadId: "t", model: codex });
  assert.equal(f.last().params.serviceTier, "priority");
  await f.announce(f.router, "auto", Date.now() + 300);
  await (await f.connect()).request("thread/fork", { threadId: "t", model: codex });
  assert.ok(noTier(f.last().params));
});

test("a connection that held Fast in memory stops forwarding it once another connection records an odd tier", async () => {
  for (const tier of oddTiers) for (const method of methods) {
    const f = await fixture();
    await f.router.request("thread/start", { model: codex, serviceTier: "priority" });
    const peer = await f.connect();
    await f.announce(peer, tier, Date.now() + 100);
    await f.router.request(method, { threadId: "t", model: codex });
    assert.ok(noTier(f.last().params), `${method} sent ${String(f.last().params.serviceTier)} after ${label(tier)}`);
  }
});

test("the file written after an odd tier is accepted by the 0.4.0 parser and shows 0.4.0 no tier for the chat", async () => {
  for (const tier of oddTiers) {
    const f = await fixture();
    await f.router.request("thread/start", { model: codex, serviceTier: "priority" });
    await f.announce(f.router, tier, Date.now() + 100);
    const accepted = oldBuildAccepts(JSON.parse(await readFile(await f.file(), "utf8")));
    assert.equal(Object.hasOwn(accepted, "t"), false, `0.4.0 would still find a record for the chat after ${label(tier)}`);
    assert.ok(Object.keys(accepted).length > 0, "the watermark is stored as a row 0.4.0 accepts");
  }
});

test("a connection that held Fast stops forwarding it when the store rejects its older notification because a peer marked the chat unknown", async () => {
  for (const tier of oddTiers) for (const method of methods) {
    const f = await fixture();
    await f.router.request("thread/start", { model: codex, serviceTier: "priority" });
    const t0 = Date.now() + 100; const t1 = Date.now() + 400;
    await f.announce(await f.connect(), tier, t1);
    // The older Fast reaches the connection that still holds Fast; the store rejects it and has no tier to give back.
    await f.announce(f.router, "priority", t0);
    assert.equal(await f.store.read("t"), undefined);
    await f.router.request(method, { threadId: "t", model: codex });
    assert.ok(noTier(f.last().params), `${method} sent ${String(f.last().params.serviceTier)} after ${label(tier)}`);
  }
});

test("a resume in flight while a peer marks the chat unknown does not keep the tier the answer carried", async () => {
  for (const tier of oddTiers) for (const method of methods) {
    const f = await fixture();
    await f.router.request("thread/start", { model: codex, serviceTier: "priority" });
    const peer = await f.connect();
    f.sdk.tier = "priority"; f.control.loaded = true;
    f.control.during = async () => { f.control.during = undefined; await f.announce(peer, tier, Date.now() + 100); };
    await f.router.request("thread/resume", { threadId: "t" });
    assert.equal(await f.store.read("t"), undefined, "the peer's unknown tier stands");
    await f.router.request(method, { threadId: "t", model: codex });
    assert.ok(noTier(f.last().params), `${method} sent ${String(f.last().params.serviceTier)} after ${label(tier)}`);
  }
});
