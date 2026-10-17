import test from "node:test";
import assert from "node:assert/strict";
import { compactionSdkFixture, largeModel, smallModel, until } from "./compaction-sdk-fixture.js";
import type { Message } from "../app-server-connection.js";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { identityTest } from "./identity-cases.js";

// The recovery cases that read the chat's own record run for both provider ids a gateway chat can be saved with.
let gateway = "subscription_gateway";
const bothIdentities = identityTest(identity => { gateway = identity.provider; });
const sent = { input: [{ type: "text", text: "caller message remains unchanged" }], effort: "high", approvalPolicy: "never", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/fixture"] } };

bothIdentities("long model downshifts select the target and complete manual compaction before the original turn", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(false, true, gateway); const id = "downshift";
  try {
    await f.start(id); await f.usage(id);
    const request = { threadId: id, model: smallModel, ...structuredClone(sent) };
    await f.backends.request("turn/start", request);
    const calls = await f.ledger(id);
    const settings = calls.findIndex(call => call.method === "thread/settings/update");
    const compact = calls.findIndex(call => call.method === "thread/compact/start");
    const turn = calls.findIndex(call => call.method === "turn/start");
    assert.ok(settings >= 0 && compact > settings && turn > compact);
    assert.equal(calls[compact].model, smallModel); assert.deepEqual(calls[turn].params, request);
    assert.ok(f.events.some(event => event.method === "item/completed" && (event.params as Message)?.turnId?.toString().startsWith("owned-compact")));
    assert.equal(await f.nativeUnchanged(), true);
  } finally { await f.clean(); }
});

test("loaded model context metadata remains frozen after a live catalog refresh", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(); const id = "frozen-window";
  try {
    await f.start(id); await f.usage(id); f.nextCatalog();
    await f.backends.request("turn/start", { threadId: id, model: smallModel, ...sent });
    assert.equal((await f.ledger(id)).filter(call => call.method === "thread/compact/start").length, 1);
  } finally { await f.clean(); }
});

test("short model changes do not create unnecessary compaction even with large cumulative usage", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(); const id = "short-chat";
  try {
    await f.start(id); await f.usage(id, 1000);
    await f.backends.request("turn/start", { threadId: id, model: smallModel, ...sent });
    const calls = await f.ledger(id); assert.equal(calls.some(call => call.method === "thread/compact/start"), false);
    assert.equal(calls.filter(call => call.method === "turn/start").length, 1);
  } finally { await f.clean(); }
});

bothIdentities("a failed compaction retries on the next selected-model turn without a model change", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(false, true, gateway); const id = "same-model-retry";
  try {
    await f.start(id, smallModel); await f.usage(id, 1000, 27000);
    await f.backends.request("fixture/failedCompact", { threadId: id });
    await until(() => f.events.some(event => event.method === "turn/completed" && ((event.params as Message)?.turn as Message)?.status === "failed"));
    await f.backends.request("turn/start", { threadId: id, model: smallModel, ...sent });
    const calls = await f.ledger(id); assert.equal(calls.filter(call => call.method === "thread/compact/start").length, 1);
    assert.equal(calls.find(call => call.method === "thread/compact/start")?.model, smallModel);
  } finally { await f.clean(); }
});

test("active steering and active turn/start retain their SDK path without replacing work", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(); const id = "active-steering";
  try {
    await f.start(id); const first = await f.backends.request("turn/start", { threadId: id, model: largeModel, input: sent.input, fixtureKeepActive: true });
    const turnId = String((first.turn as Message).id); await f.usage(id);
    const steer = { threadId: id, expectedTurnId: turnId, input: sent.input };
    assert.equal((await f.backends.request("turn/steer", steer)).turnId, turnId);
    assert.equal((await f.backends.request("turn/start", { threadId: id, model: smallModel, ...sent })).steered, true);
    assert.equal((await f.ledger(id)).some(call => call.method === "thread/compact/start"), false);
    await f.backends.request("turn/interrupt", { threadId: id, turnId });
  } finally { await f.clean(); }
});

test("primary-account turns and their native config remain untouched by recovery", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(); const id = "native-chat";
  try {
    await f.backends.request("thread/start", { fixtureId: id, model: "native-original", modelProvider: "openai" });
    await f.backends.request("fixture/usage", { threadId: id, lastTokens: 40010, contextWindow: 45000 });
    const request = { threadId: id, model: "native-original", ...sent };
    await f.backends.request("turn/start", request);
    const nativeCalls = (await f.backends.native.request("fixture/ledger", {})).calls as { method: string; params: Message }[];
    assert.equal(nativeCalls.some(call => call.method === "thread/compact/start"), false);
    assert.deepEqual(nativeCalls.find(call => call.method === "turn/start")?.params, request);
    assert.equal(await f.nativeUnchanged(), true);
  } finally { await f.clean(); }
});

test("interrupting recovery cancels only its observed compact turn and never submits the waiting user turn", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(); const id = "cancel-recovery";
  try {
    await f.start(id); await f.usage(id); await f.backends.request("fixture/holdCompact", { threadId: id, value: true });
    const pending = f.backends.request("turn/start", { threadId: id, model: smallModel, ...sent });
    const rejected = assert.rejects(pending, /interrupted/);
    await until(() => f.events.some(event => event.method === "item/started" && (event.params as Message)?.turnId?.toString().startsWith("owned-compact")));
    await f.backends.request("turn/interrupt", { threadId: id, turnId: "unrelated-caller-turn" }); await rejected;
    const calls = await f.ledger(id); const interrupted = calls.filter(call => call.method === "turn/interrupt");
    assert.equal(interrupted.length, 1); assert.match(String(interrupted[0].params.turnId), /^owned-compact-/);
    assert.equal(calls.some(call => call.method === "turn/start"), false);
  } finally { await f.clean(); }
});

test("mutations during a recovery barrier fail without reaching the SDK", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(); const id = "busy-recovery";
  try {
    await f.start(id); await f.usage(id); await f.backends.request("fixture/holdCompact", { threadId: id, value: true });
    const pending = f.backends.request("turn/start", { threadId: id, model: smallModel, ...sent });
    const rejected = assert.rejects(pending, /interrupted/);
    await until(() => f.events.some(event => event.method === "item/started" && (event.params as Message)?.turnId?.toString().startsWith("owned-compact")));
    for (const method of ["turn/start", "turn/steer", "thread/settings/update"]) {
      await assert.rejects(f.backends.request(method, { threadId: id, model: smallModel, input: sent.input }), /busy|compaction recovery/i);
    }
    await f.backends.request("turn/interrupt", { threadId: id }); await rejected;
    const calls = await f.ledger(id); assert.equal(calls.some(call => call.method === "turn/start" || call.method === "turn/steer"), false);
    assert.equal(calls.filter(call => call.method === "thread/settings/update").length, 1);
  } finally { await f.clean(); }
});

bothIdentities("shared executors refuse automatic recovery until host-wide admission is available", { timeout: 20000 }, async () => {
  const f = await compactionSdkFixture(true, true, gateway); const id = "shared-needs-recovery";
  try {
    await f.start(id); await f.usage(id);
    await assert.rejects(f.backends.request("turn/start", { threadId: id, model: smallModel, ...sent }), /shared|compaction.*recovery|exclusive/i);
    assert.equal((await f.ledger(id)).some(call => call.method === "thread/compact/start"), false);
  } finally { await f.clean(); }
});

test("an active goal refuses recovery without pausing, clearing, or interrupting it", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(); const id = "active-goal";
  try {
    await f.start(id); await f.usage(id); await f.backends.request("fixture/goal", { threadId: id, status: "active" });
    await assert.rejects(f.backends.request("turn/start", { threadId: id, model: smallModel, ...sent }), /Pause or finish the active goal/);
    const calls = await f.ledger(id);
    assert.equal(calls.some(call => ["thread/compact/start", "turn/start", "turn/interrupt", "thread/goal/set", "thread/goal/clear"].includes(call.method)), false);
    assert.equal(((await f.backends.request("thread/goal/get", { threadId: id })).goal as Message).status, "active");
  } finally { await f.clean(); }
});

test("goal-disabled executor recovery skips the unavailable goal RPC", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(false, false); const id = "goals-disabled";
  try {
    await f.start(id); await f.usage(id);
    await f.backends.request("turn/start", { threadId: id, model: smallModel, ...sent });
    const calls = await f.ledger(id);
    assert.equal(calls.some(call => call.method === "thread/goal/get"), false);
    assert.equal(calls.filter(call => call.method === "thread/compact/start").length, 1);
  } finally { await f.clean(); }
});

test("healthy metadata checks do not block concurrent settings while waiting for an SDK read", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(); const id = "healthy-parallel-settings";
  try {
    await f.start(id); await f.usage(id, 1000); await f.backends.request("fixture/readDelay", { threadId: id, milliseconds: 80 });
    const offset = f.events.length;
    const pending = f.backends.request("turn/start", { threadId: id, model: smallModel, ...sent });
    await until(() => f.events.slice(offset).some(event => event.method === "fixture/readStarted"));
    const settings = { threadId: id, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
    await f.backends.request("thread/settings/update", settings); await pending;
    const calls = await f.ledger(id);
    assert.ok(calls.some(call => call.method === "thread/settings/update" && call.params.sandboxPolicy));
    assert.equal(calls.some(call => call.method === "thread/compact/start"), false);
  } finally { await f.clean(); }
});

test("successful rollback clears an obsolete failed-compaction recovery requirement", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(); const id = "rollback-clears-failure";
  try {
    await f.start(id, smallModel); await f.usage(id, 1000, 27000);
    await f.backends.request("fixture/failedCompact", { threadId: id });
    await until(() => f.events.some(event => event.method === "turn/completed" && ((event.params as Message)?.turn as Message)?.status === "failed"));
    await f.backends.request("thread/rollback", { threadId: id, numTurns: 1 });
    await f.backends.request("turn/start", { threadId: id, model: smallModel, ...sent });
    assert.equal((await f.ledger(id)).some(call => call.method === "thread/compact/start"), false);
  } finally { await f.clean(); }
});

test("malformed optional recovery metadata does not prevent healthy SDK work", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(); const id = "invalid-recovery-metadata";
  try {
    await f.start(id); await f.usage(id, 1000);
    await f.backends.request("turn/start", { threadId: id, model: largeModel, ...sent });
    await until(() => f.events.some(event => event.method === "turn/completed" && String(((event.params as Message)?.turn as Message)?.id).startsWith("ordinary-turn")));
    const files = (await readdir(f.config.stateDirectory)).filter(file => /^desktop-compaction-.*\.json$/.test(file));
    assert.equal(files.length, 1); await writeFile(join(f.config.stateDirectory, files[0]), "not-json", { mode: 0o600 });
    await f.backends.request("turn/start", { threadId: id, model: largeModel, ...sent });
    assert.equal((await f.ledger(id)).filter(call => call.method === "turn/start").length, 2);
  } finally { await f.clean(); }
});

test("loaded resume ignores proposed compaction overrides that the SDK did not apply", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(); const id = "warm-resume-policy";
  try {
    await f.start(id); await f.usage(id, 1000);
    await f.backends.request("thread/resume", { threadId: id, config: { model_auto_compact_token_limit: 1 } });
    await f.backends.request("turn/start", { threadId: id, model: smallModel, ...sent });
    assert.equal((await f.ledger(id)).some(call => call.method === "thread/compact/start"), false);
  } finally { await f.clean(); }
});

test("a cold resume without overrides replaces an earlier per-chat compaction policy", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(); const id = "cold-resume-policy";
  try {
    await f.backends.request("thread/start", { fixtureId: id, model: largeModel, modelProvider: "subscription_gateway", config: { model_auto_compact_token_limit: 1 } }, { engine: "gateway" });
    await f.usage(id, 1000); await f.backends.request("thread/unsubscribe", { threadId: id });
    await f.backends.request("thread/resume", { threadId: id });
    await f.backends.request("turn/start", { threadId: id, model: smallModel, ...sent });
    assert.equal((await f.ledger(id)).some(call => call.method === "thread/compact/start"), false);
  } finally { await f.clean(); }
});

test("Stop during a pending metadata read prevents both compaction and the original user turn", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(); const id = "stop-before-admission";
  try {
    await f.start(id); await f.usage(id);
    await f.backends.request("fixture/readDelay", { threadId: id, milliseconds: 100 });
    const offset = f.events.length;
    const pending = f.backends.request("turn/start", { threadId: id, model: smallModel, ...sent });
    const rejected = assert.rejects(pending, /interrupted/);
    await until(() => f.events.slice(offset).some(event => event.method === "fixture/readStarted"));
    await f.backends.request("turn/interrupt", { threadId: id, turnId: "not-an-active-sdk-turn" }); await rejected;
    const calls = await f.ledger(id);
    assert.equal(calls.some(call => ["thread/compact/start", "turn/start", "turn/interrupt"].includes(call.method)), false);
  } finally { await f.clean(); }
});

// The goal guard reads the per-chat override the executor remembered, so it shows whether the chat is still held.
const override = { features: { goals: false } };
const remembered = async (f: Awaited<ReturnType<typeof compactionSdkFixture>>, id: string) => {
  const engine = (f.backends as unknown as { engines: Array<{ compaction?: { policy: { goalsEnabled(id: string): boolean } } }> }).engines.find(entry => entry.compaction);
  return engine!.compaction!.policy.goalsEnabled(id) === false;
};
const startWithOverride = (f: Awaited<ReturnType<typeof compactionSdkFixture>>, id: string) =>
  f.backends.request("thread/start", { fixtureId: id, model: largeModel, modelProvider: "subscription_gateway", config: override }, { engine: "gateway" });

for (const method of ["thread/unsubscribe", "thread/archive", "thread/delete"]) test(`${method} forgets the executor's per-chat compaction overrides`, { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(); const id = `forget-${method.split("/")[1]}`;
  try {
    await startWithOverride(f, id);
    assert.equal(await remembered(f, id), true, "the override is held while the chat is loaded");
    await f.backends.request(method, { threadId: id });
    assert.equal(await remembered(f, id), false);
  } finally { await f.clean(); }
});

test("thread/unsubscribe forgets the overrides on its own, with no thread/closed from the engine", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(); const id = "forget-silent";
  try {
    await startWithOverride(f, id);
    assert.equal(await remembered(f, id), true);
    await f.backends.request("thread/unsubscribe", { threadId: id, fixtureNoClosed: true });
    assert.equal(f.events.some(event => event.method === "thread/closed"), false, "the engine announced nothing");
    assert.equal(await remembered(f, id), false);
  } finally { await f.clean(); }
});

test("a thread/closed notification forgets the executor's per-chat compaction overrides", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(); const id = "forget-closed";
  try {
    await startWithOverride(f, id);
    assert.equal(await remembered(f, id), true);
    const engine = (f.backends as unknown as { engines: Array<{ connection: unknown; compaction?: unknown }> }).engines.find(entry => entry.compaction)!;
    await (f.backends as unknown as { forward(connection: unknown, message: Message): Promise<void> }).forward(engine.connection, { method: "thread/closed", params: { threadId: id } });
    assert.equal(await remembered(f, id), false);
  } finally { await f.clean(); }
});
