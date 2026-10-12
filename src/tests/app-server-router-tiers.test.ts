import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerRouter } from "../app-server-router.js";
import type { GatewayConfig } from "../config.js";
import { ThreadServiceTiers } from "../thread-service-tiers.js";

type ObjectValue = Record<string, unknown>;
type Call = { method: string; params: ObjectValue };
type Hook = (method: string, params: ObjectValue, result: ObjectValue, router: AppServerRouter) => Promise<ObjectValue>;
const gateway = "subscription_gateway"; const fastModel = "codex/sol"; const standardModel = "codex/standard";
const threadId = (result: ObjectValue) => String((result.thread as ObjectValue).id);
let notificationClock = Date.now();
const emittedAt = () => notificationClock = Math.max(notificationClock + 1, Date.now());
const afterTimestamp = (timestamp: number) => delay(Math.max(2, timestamp - Date.now() + 2));
const choice = (value: { model: string; serviceTier: string | null } | undefined) => value && ({ model: value.model, serviceTier: value.serviceTier });
const applied = (router: AppServerRouter, id: string, tier: string | null, model = fastModel, emittedAtMs = emittedAt()) => router.observeNotification({
  emittedAtMs,
  method: "thread/settings/updated", params: { threadId: id, threadSettings: { modelProvider: gateway, model, serviceTier: tier } },
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-router-tiers-"));
  const nativeHome = join(directory, "native-home");
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: directory, providers: [{
    id: "codex", type: "codex-subscription", label: "Codex", credentialFile: "unused",
    models: { [fastModel]: "sol", [standardModel]: "standard" },
    modelMetadata: { [fastModel]: { serviceTiers: [{ id: "priority", name: "Fast", description: "Priority routing" }] } },
  }] };
  const metadata = new Map<string, { model: string; modelProvider: string }>();
  const connect = async (home = nativeHome, hook?: Hook) => {
    const calls: Call[] = []; let router: AppServerRouter;
    const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
      calls.push({ method, params: structuredClone(params) });
      let result: ObjectValue;
      if (["thread/start", "thread/resume", "thread/fork"].includes(method)) {
        const previous = metadata.get(String(params.threadId));
        const model = String(params.model || previous?.model || "native");
        const modelProvider = String(params.modelProvider || previous?.modelProvider || "openai");
        const id = method === "thread/resume" ? String(params.threadId) : randomUUID();
        metadata.set(id, { model, modelProvider });
        // A cold SDK knows no gateway tier; only an explicit forwarded tier changes Standard.
        const serviceTier = Object.hasOwn(params, "serviceTier") ? params.serviceTier : (params.config as ObjectValue | undefined)?.service_tier ?? null;
        result = { thread: { id }, model, modelProvider, serviceTier };
      } else if (method === "thread/read") {
        const saved = metadata.get(String(params.threadId));
        assert.ok(saved, "thread/read must target an existing chat");
        result = { thread: { id: params.threadId, ...saved } };
      } else if (method === "turn/start") result = { turn: { id: randomUUID() } };
      else if (method === "turn/settings/update") result = { status: "applied" };
      else if (method === "thread/settings/update") result = { status: "queued" };
      else if (method === "config/read") result = { config: { model: "native", model_provider: "openai" } };
      else result = { status: "ok" };
      return hook ? hook(method, params, result, router) : result;
    };
    router = new AppServerRouter(config, backend, undefined, undefined, home); await router.initialize();
    return { router, calls };
  };
  const store = (home = nativeHome) => new ThreadServiceTiers(directory, home);
  const ledgerBytes = async () => {
    const filename = (await readdir(directory)).find(name => name.startsWith("desktop-thread-tiers-"));
    assert.ok(filename, "expected a durable ledger"); return readFile(join(directory, filename), "utf8");
  };
  return { directory, nativeHome, connect, store, ledgerBytes };
}

type Connection = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>>;
function last(connection: Connection, method: string): ObjectValue {
  const call = connection.calls.filter(call => call.method === method).at(-1);
  assert.ok(call, `expected ${method} to reach the SDK`); return call.params;
}
const start = async (connection: Connection, tier: string | null, model = fastModel) => threadId(await connection.router.request("thread/start", { model, serviceTier: tier }));
const preferences = (connection: Connection, tier: string | null) => connection.router.request("config/batchWrite", { edits: [
  { keyPath: "model", value: fastModel, mergeStrategy: "upsert" },
  { keyPath: "service_tier", value: tier, mergeStrategy: "upsert" },
] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}

test("Fast saved chats resume and fork after new-chat preferences change to Standard", async () => {
  const f = await fixture(); const first = await f.connect();
  await preferences(first, "priority");
  const id = threadId(await first.router.request("thread/start", {}));
  assert.deepEqual(choice(await f.store().read(id)), { model: fastModel, serviceTier: "priority" });
  await preferences(first, null);
  const fresh = await f.connect();
  const resumed = await fresh.router.request("thread/resume", { threadId: id });
  assert.equal(last(fresh, "thread/resume").serviceTier, "priority"); assert.equal(resumed.serviceTier, "priority");
  const fork = await fresh.router.request("thread/fork", { threadId: id });
  assert.notEqual(threadId(fork), id); assert.equal(last(fresh, "thread/fork").serviceTier, "priority");
  assert.deepEqual(choice(await f.store().read(threadId(fork))), { model: fastModel, serviceTier: "priority" });
  assert.equal((await fresh.router.request("thread/start", {})).serviceTier, null);
});

test("saved Standard survives Fast new-chat defaults across independent connections", async () => {
  const f = await fixture(); const first = await f.connect(); const id = await start(first, null);
  await preferences(first, "priority"); const fresh = await f.connect();
  assert.equal((await fresh.router.request("thread/resume", { threadId: id })).serviceTier, null);
  assert.ok(Object.hasOwn(last(fresh, "thread/resume"), "serviceTier"));
  assert.equal(last(fresh, "thread/resume").serviceTier, null);
  const fork = await fresh.router.request("thread/fork", { threadId: id });
  assert.equal(last(fresh, "thread/fork").serviceTier, null);
  assert.deepEqual(choice(await f.store().read(threadId(fork))), { model: fastModel, serviceTier: null });
  assert.equal((await fresh.router.request("thread/start", {})).serviceTier, "priority");
});

test("an old connection rereads a peer's applied Standard before resume, fork and model guards", async () => {
  const f = await fixture(); const old = await f.connect(); const id = await start(old, "priority");
  const peer = await f.connect(); await peer.router.request("thread/resume", { threadId: id });
  await applied(peer.router, id, null);
  await old.router.request("thread/resume", { threadId: id });
  assert.equal(last(old, "thread/resume").serviceTier, null);
  await old.router.request("thread/fork", { threadId: id }); assert.equal(last(old, "thread/fork").serviceTier, null);
  await old.router.request("turn/start", { threadId: id, model: standardModel, input: [] });
  assert.equal(last(old, "turn/start").model, standardModel);
  assert.deepEqual(choice(await f.store().read(id)), { model: fastModel, serviceTier: null });
});

test("a queued thread settings acknowledgement cannot establish a durable tier", async () => {
  const f = await fixture(); const first = await f.connect(); const id = await start(first, "priority");
  assert.equal((await first.router.request("thread/settings/update", { threadId: id, serviceTier: null })).status, "queued");
  assert.deepEqual(choice(await f.store().read(id)), { model: fastModel, serviceTier: "priority" });
  const fresh = await f.connect(); await fresh.router.request("thread/resume", { threadId: id });
  assert.equal(last(fresh, "thread/resume").serviceTier, "priority");
  await applied(first.router, id, null);
  const afterApplied = await f.connect(); await afterApplied.router.request("thread/resume", { threadId: id });
  assert.equal(last(afterApplied, "thread/resume").serviceTier, null);
});

test("one-turn Fast and applied active-turn settings remain separate from durable Standard", async () => {
  const f = await fixture(); const first = await f.connect(); const id = await start(first, null);
  const result = await first.router.request("turn/start", { threadId: id, serviceTierForTurn: "priority", input: [] });
  const turnId = String((result.turn as ObjectValue).id);
  await first.router.request("turn/settings/update", { threadId: id, turnId, serviceTier: "priority" });
  await first.router.observeNotification({ emittedAtMs: emittedAt(), method: "turn/settings/updated", params: { threadId: id, turnId, serviceTier: "priority" } });
  assert.deepEqual(choice(await f.store().read(id)), { model: fastModel, serviceTier: null });
  const fresh = await f.connect(); await fresh.router.request("thread/resume", { threadId: id });
  assert.equal(last(fresh, "thread/resume").serviceTier, null);
  await first.router.observeNotification({ emittedAtMs: emittedAt(), method: "turn/completed", params: { threadId: id, turn: { id: turnId } } });
  await first.router.request("turn/start", { threadId: id, model: standardModel, input: [] });
  assert.equal(last(first, "turn/start").model, standardModel);
});

test("active-turn Standard cannot clear a saved Fast chat's durable guard", async () => {
  const f = await fixture(); const first = await f.connect(); const id = await start(first, "priority");
  const result = await first.router.request("turn/start", { threadId: id, input: [] });
  await first.router.request("turn/settings/update", { threadId: id, turnId: (result.turn as ObjectValue).id, serviceTier: null });
  const fresh = await f.connect(); await fresh.router.request("thread/resume", { threadId: id });
  assert.equal(last(fresh, "thread/resume").serviceTier, "priority");
  const count = fresh.calls.length;
  await assert.rejects(fresh.router.request("turn/start", { threadId: id, model: standardModel, input: [] }), /does not support/);
  assert.equal(fresh.calls.length, count); assert.equal((await f.store().read(id))!.serviceTier, "priority");
});

test("a stale SDK resume snapshot cannot replace a newer peer Standard setting", async () => {
  const f = await fixture(); const entered = deferred<void>(); const release = deferred<void>();
  const first = await f.connect(f.nativeHome, async (method, _params, result) => {
    if (method === "thread/resume") { entered.resolve(); await release.promise; }
    return result;
  });
  const id = await start(first, "priority"); const peer = await f.connect();
  await peer.router.request("thread/resume", { threadId: id });
  const pending = first.router.request("thread/resume", { threadId: id }); await entered.promise;
  await applied(peer.router, id, null); release.resolve();
  assert.equal((await pending).serviceTier, "priority", "the delayed SDK response actually contains stale Fast");
  assert.deepEqual(choice(await f.store().read(id)), { model: fastModel, serviceTier: null });
  const fresh = await f.connect(); await fresh.router.request("thread/resume", { threadId: id });
  assert.equal(last(fresh, "thread/resume").serviceTier, null);
  await first.router.request("thread/resume", { threadId: id }); assert.equal(last(first, "thread/resume").serviceTier, null);
});

test("applied settings received before thread/start returns beat its earlier SDK snapshot", async () => {
  const f = await fixture();
  const first = await f.connect(f.nativeHome, async (method, _params, result, router) => {
    if (method === "thread/start") await applied(router, threadId(result), null);
    return result;
  });
  const id = await start(first, "priority"); assert.equal(last(first, "thread/start").serviceTier, "priority");
  assert.deepEqual(choice(await f.store().read(id)), { model: fastModel, serviceTier: null });
  await first.router.request("turn/start", { threadId: id, model: standardModel, input: [] });
  const fresh = await f.connect(); await fresh.router.request("thread/resume", { threadId: id });
  assert.equal(last(fresh, "thread/resume").serviceTier, null);
});

test("a thread update arriving before turn/start returns keeps its confirmed model and tier", async () => {
  const f = await fixture();
  const first = await f.connect(f.nativeHome, async (method, params, result, router) => {
    if (method === "turn/start") await applied(router, String(params.threadId), null, standardModel);
    return result;
  });
  const id = await start(first, "priority");
  await first.router.request("turn/start", { threadId: id, model: fastModel, serviceTier: "priority", input: [] });
  assert.deepEqual(choice(await f.store().read(id)), { model: standardModel, serviceTier: null });
  await first.router.request("thread/fork", { threadId: id });
  assert.equal(last(first, "thread/fork").model, standardModel); assert.equal(last(first, "thread/fork").serviceTier, null);
  const fresh = await f.connect(); await fresh.router.request("thread/resume", { threadId: id });
  assert.equal(last(fresh, "thread/resume").model, standardModel); assert.equal(last(fresh, "thread/resume").serviceTier, null);
});

test("late duplicate Fast notifications cannot undo another connection's newer Standard", async () => {
  const f = await fixture(); const first = await f.connect(); const id = await start(first, "priority");
  const oldTimestamp = emittedAt(); await applied(first.router, id, "priority", fastModel, oldTimestamp);
  const delayed = await f.connect(); await delayed.router.request("thread/resume", { threadId: id });
  const standardTimestamp = emittedAt(); await applied(first.router, id, null, fastModel, standardTimestamp);
  await delayed.router.request("thread/resume", { threadId: id });
  assert.ok((await f.store().read(id))!.emittedAtMs! >= standardTimestamp, "an SDK snapshot preserves or advances notification ordering metadata");
  const confirmed = await f.store().read(id); const before = await f.ledgerBytes();
  await applied(delayed.router, id, "priority", fastModel, oldTimestamp);
  assert.deepEqual(await f.store().read(id), confirmed); assert.equal(await f.ledgerBytes(), before);
  const unknown = await f.connect(); await applied(unknown.router, id, "priority", fastModel, oldTimestamp);
  assert.deepEqual(await f.store().read(id), confirmed, "a first notification is not permission to overwrite known Standard");
  assert.equal(await f.ledgerBytes(), before);
  const fresh = await f.connect(); await fresh.router.request("thread/resume", { threadId: id });
  assert.equal(last(fresh, "thread/resume").serviceTier, null);
  await delayed.router.request("thread/settings/update", { threadId: id, serviceTier: "priority" });
  await applied(delayed.router, id, "priority");
  assert.deepEqual(choice(await f.store().read(id)), { model: fastModel, serviceTier: "priority" }, "a newly requested Fast selection can apply after refreshing Standard");
});

test("a delayed Standard snapshot cannot undo Fast after a peer changes Fast to Standard to Fast", async () => {
  const f = await fixture(); const entered = deferred<void>(); const release = deferred<void>(); let hold = true;
  const old = await f.connect(f.nativeHome, async (method, _params, result) => {
    if (method === "thread/resume" && hold) { hold = false; entered.resolve(); await release.promise; }
    return result;
  });
  const id = await start(old, "priority"); const peer = await f.connect();
  await peer.router.request("thread/resume", { threadId: id }); const before = (await f.store().read(id))!;
  const pending = old.router.request("thread/resume", { threadId: id, serviceTier: null }); await entered.promise;
  await applied(peer.router, id, null);
  await peer.router.request("thread/settings/update", { threadId: id, serviceTier: "priority" });
  const latestTimestamp = emittedAt(); await applied(peer.router, id, "priority", fastModel, latestTimestamp);
  const latest = (await f.store().read(id))!; const bytes = await f.ledgerBytes();
  assert.deepEqual(choice(latest), choice(before)); assert.notEqual(latest.revision, before.revision);
  assert.equal(latest.emittedAtMs, latestTimestamp); release.resolve();
  assert.equal((await pending).serviceTier, null, "the stale SDK response actually contains Standard");
  assert.deepEqual(await f.store().read(id), latest); assert.equal(await f.ledgerBytes(), bytes);
  await old.router.request("thread/fork", { threadId: id }); assert.equal(last(old, "thread/fork").serviceTier, "priority");
  await assert.rejects(old.router.request("turn/start", { threadId: id, model: standardModel, input: [] }), /does not support/);
});

test("same-millisecond Fast and Standard conflicts resolve to Standard in either delivery order", async () => {
  for (const initial of ["priority", null] as const) {
    const f = await fixture(); const first = await f.connect(); const id = await start(first, null); const timestamp = emittedAt();
    await applied(first.router, id, initial, fastModel, timestamp);
    const peer = await f.connect(); await peer.router.request("thread/settings/update", { threadId: id, serviceTier: null });
    await applied(peer.router, id, initial === null ? "fast" : null, fastModel, timestamp);
    const standard = (await f.store().read(id))!; const bytes = await f.ledgerBytes();
    assert.deepEqual(choice(standard), { model: fastModel, serviceTier: null }); assert.equal(standard.emittedAtMs, timestamp);
    await peer.router.request("thread/settings/update", { threadId: id, serviceTier: "priority" });
    await applied(peer.router, id, "priority", fastModel, timestamp);
    assert.deepEqual(await f.store().read(id), standard); assert.equal(await f.ledgerBytes(), bytes);
    await applied(peer.router, id, "priority"); assert.equal((await f.store().read(id))!.serviceTier, "priority");
  }
});

test("a delayed older Standard notification cannot replace a newer Fast choice", async () => {
  const f = await fixture(); const first = await f.connect(); const id = await start(first, null);
  const oldTimestamp = emittedAt(); await applied(first.router, id, null, fastModel, oldTimestamp);
  await first.router.request("thread/settings/update", { threadId: id, serviceTier: "priority" });
  const latestTimestamp = emittedAt(); await applied(first.router, id, "priority", fastModel, latestTimestamp);
  const delayed = await f.connect(); await delayed.router.request("thread/settings/update", { threadId: id, serviceTier: null });
  const latest = await f.store().read(id); const bytes = await f.ledgerBytes();
  await applied(delayed.router, id, null, fastModel, oldTimestamp);
  assert.deepEqual(await f.store().read(id), latest); assert.equal(await f.ledgerBytes(), bytes);
  await applied(first.router, id, "priority", fastModel, latestTimestamp);
  assert.deepEqual(await f.store().read(id), latest); assert.equal(await f.ledgerBytes(), bytes, "an identical event is a durable no-op");
});

test("missing, invalid, future and misplaced envelope timestamps cannot establish durable settings", async () => {
  const f = await fixture(); const first = await f.connect(); const id = await start(first, null);
  await applied(first.router, id, null); const confirmed = await f.store().read(id); const bytes = await f.ledgerBytes();
  const unknownId = randomUUID();
  for (const timestamp of [undefined, null, 0, -1, 1.5, "123", NaN, Infinity, Date.now() + 10000]) {
    for (const target of [id, unknownId]) await first.router.observeNotification({
      ...(timestamp === undefined ? {} : { emittedAtMs: timestamp }), method: "thread/settings/updated", params: {
        threadId: target, threadSettings: { modelProvider: gateway, model: fastModel, serviceTier: "priority" },
      },
    });
    assert.deepEqual(await f.store().read(id), confirmed); assert.equal(await f.store().read(unknownId), undefined);
    assert.equal(await f.ledgerBytes(), bytes);
  }
  await first.router.observeNotification({ method: "thread/settings/updated", params: {
    emittedAtMs: emittedAt(), threadId: id, threadSettings: { modelProvider: gateway, model: fastModel, serviceTier: "priority" },
  } });
  assert.deepEqual(await f.store().read(id), confirmed); assert.equal(await f.ledgerBytes(), bytes);
  await first.router.request("thread/fork", { threadId: id }); assert.equal(last(first, "thread/fork").serviceTier, null);
});

test("a genuinely newer Fast notification wins over its receiver's stale local baseline", async () => {
  const f = await fixture(); const stale = await f.connect(); const id = await start(stale, "priority");
  const peer = await f.connect(); await peer.router.request("thread/resume", { threadId: id });
  const standardTimestamp = Math.max(emittedAt(), (await f.store().read(id))!.emittedAtMs! + 1);
  await applied(peer.router, id, null, fastModel, standardTimestamp);
  const standard = (await f.store().read(id))!; const calls = stale.calls.length;
  const newerTimestamp = Math.max(emittedAt(), standardTimestamp + 1);
  await applied(stale.router, id, "priority", fastModel, newerTimestamp);
  const latest = (await f.store().read(id))!;
  assert.equal(stale.calls.length, calls, "the receiver has not refreshed its old route through an RPC");
  assert.deepEqual(choice(latest), { model: fastModel, serviceTier: "priority" });
  assert.equal(latest.emittedAtMs, newerTimestamp); assert.notEqual(latest.revision, standard.revision);
  await stale.router.request("thread/fork", { threadId: id }); assert.equal(last(stale, "thread/fork").serviceTier, "priority");
});

test("same-millisecond Standard wins even when its receiver still knows an older Standard row", async () => {
  const f = await fixture(); const stale = await f.connect(); const id = await start(stale, null);
  const peer = await f.connect(); await peer.router.request("thread/resume", { threadId: id });
  const timestamp = Math.max(emittedAt(), (await f.store().read(id))!.emittedAtMs! + 1);
  await applied(peer.router, id, "priority", fastModel, timestamp); const fast = (await f.store().read(id))!;
  const calls = stale.calls.length; await applied(stale.router, id, null, fastModel, timestamp);
  const standard = (await f.store().read(id))!; const bytes = await f.ledgerBytes();
  assert.equal(stale.calls.length, calls); assert.deepEqual(choice(standard), { model: fastModel, serviceTier: null });
  assert.equal(standard.emittedAtMs, timestamp); assert.notEqual(standard.revision, fast.revision);
  await applied(peer.router, id, "priority", fastModel, timestamp);
  assert.deepEqual(await f.store().read(id), standard); assert.equal(await f.ledgerBytes(), bytes);
  await stale.router.request("thread/fork", { threadId: id }); assert.equal(last(stale, "thread/fork").serviceTier, null);
});

test("a confirmed Standard snapshot fences out Fast emitted before that resume RPC began", async () => {
  const f = await fixture(); const entered = deferred<void>(); const release = deferred<void>(); let sdkEnteredAt = 0;
  const first = await f.connect(f.nativeHome, async (method, _params, result) => {
    if (method === "thread/resume") { sdkEnteredAt = Date.now(); entered.resolve(); await release.promise; }
    return result;
  });
  const id = await start(first, "priority"); const previous = (await f.store().read(id))!;
  const oldFastTimestamp = Math.max(emittedAt(), previous.emittedAtMs! + 1);
  await afterTimestamp(oldFastTimestamp);
  const pending = first.router.request("thread/resume", { threadId: id, serviceTier: null }); await entered.promise;
  release.resolve(); assert.equal((await pending).serviceTier, null);
  const confirmed = (await f.store().read(id))!; const bytes = await f.ledgerBytes();
  assert.ok(confirmed.emittedAtMs! > oldFastTimestamp, "the RPC start advances beyond the old notification and previous watermark");
  assert.ok(confirmed.emittedAtMs! <= sdkEnteredAt, "the fence records request start, not response completion");
  await applied(first.router, id, "priority", fastModel, oldFastTimestamp);
  assert.deepEqual(await f.store().read(id), confirmed); assert.equal(await f.ledgerBytes(), bytes);
  await first.router.request("thread/fork", { threadId: id }); assert.equal(last(first, "thread/fork").serviceTier, null);
});

test("Fast emitted after resume RPC start survives delivery after its delayed Standard response", async () => {
  const f = await fixture(); const entered = deferred<void>(); const release = deferred<void>(); let sdkEnteredAt = 0;
  const first = await f.connect(f.nativeHome, async (method, _params, result) => {
    if (method === "thread/resume") { sdkEnteredAt = Date.now(); entered.resolve(); await release.promise; }
    return result;
  });
  const id = await start(first, "priority");
  const pending = first.router.request("thread/resume", { threadId: id, serviceTier: null }); await entered.promise;
  const newerTimestamp = Math.max(emittedAt(), sdkEnteredAt + 1); await afterTimestamp(newerTimestamp);
  release.resolve(); assert.equal((await pending).serviceTier, null);
  const standard = (await f.store().read(id))!; assert.equal(standard.serviceTier, null);
  assert.ok(standard.emittedAtMs! < newerTimestamp, "a slow response cannot fence events emitted after its RPC began");
  await applied(first.router, id, "priority", fastModel, newerTimestamp);
  const latest = (await f.store().read(id))!; assert.equal(latest.serviceTier, "priority");
  assert.equal(latest.emittedAtMs, newerTimestamp); assert.notEqual(latest.revision, standard.revision);
});

test("a different native home cannot restore a paid tier from the same gateway state", async () => {
  const f = await fixture(); const first = await f.connect(); const id = await start(first, "priority");
  await preferences(first, "priority"); const otherHome = join(f.directory, "other-native-home");
  const other = await f.connect(otherHome); const resumed = await other.router.request("thread/resume", { threadId: id });
  assert.equal(resumed.serviceTier, null); assert.equal(Object.hasOwn(last(other, "thread/resume"), "serviceTier"), false);
  assert.deepEqual(choice(await f.store(otherHome).read(id)), { model: fastModel, serviceTier: null });
  assert.deepEqual(choice(await f.store().read(id)), { model: fastModel, serviceTier: "priority" });
  await first.router.request("thread/resume", { threadId: id }); assert.equal(last(first, "thread/resume").serviceTier, "priority");
});

test("native chats and native or incomplete notifications never create a gateway tier ledger", async () => {
  const f = await fixture(); const first = await f.connect(); const id = await start(first, "priority", "native");
  await first.router.request("thread/resume", { threadId: id });
  const fork = await first.router.request("thread/fork", { threadId: id });
  for (const thread of [id, threadId(fork)]) await first.router.observeNotification({ emittedAtMs: emittedAt(), method: "thread/settings/updated", params: {
    threadId: thread, threadSettings: { modelProvider: "openai", model: "native", serviceTier: "priority" },
  } });
  await first.router.observeNotification({ emittedAtMs: emittedAt(), method: "thread/settings/updated", params: {
    threadId: id, threadSettings: { model: fastModel, serviceTier: "priority" },
  } });
  await first.router.observeNotification({ emittedAtMs: emittedAt(), method: "thread/settings/updated", params: {
    threadId: id, threadSettings: { modelProvider: gateway, model: fastModel },
  } });
  assert.deepEqual((await readdir(f.directory)).filter(name => name.startsWith("desktop-thread-tiers-")), []);
  assert.equal(await f.store().read(id), undefined); assert.equal(await f.store().read(threadId(fork)), undefined);
  const gatewayId = await start(first, "priority");
  const path = join(f.directory, (await readdir(f.directory)).find(name => name.startsWith("desktop-thread-tiers-"))!);
  const before = await readFile(path, "utf8");
  const nativeParams = { threadId: id, serviceTier: "priority", config: { nativeFlag: true } };
  await first.router.request("thread/resume", nativeParams); assert.deepEqual(last(first, "thread/resume"), nativeParams);
  await first.router.observeNotification({ emittedAtMs: emittedAt(), method: "thread/settings/updated", params: {
    threadId: gatewayId, threadSettings: { modelProvider: "openai", model: "native", serviceTier: null },
  } });
  assert.equal(await readFile(path, "utf8"), before);
  const saved = JSON.parse(before); assert.equal(saved.version, 1); assert.deepEqual(Object.keys(saved.threads), [gatewayId]);
  assert.deepEqual(choice(saved.threads[gatewayId]), { model: fastModel, serviceTier: "priority" });
  for (const key of Object.keys(saved.threads[gatewayId])) assert.ok(["model", "serviceTier", "revision", "emittedAtMs"].includes(key));
});
