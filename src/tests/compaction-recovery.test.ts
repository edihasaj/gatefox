import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { CompactionRecovery, CompactionRecoveryError } from "../compaction-recovery.js";
import type { Message } from "../app-server-connection.js";

const threadId = "fixture-thread";
const target = "claude/target";
const source = "codex/source";
const compactTurn = "actual-sdk-compaction-turn";
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await delay(2); }
  assert.fail("Coordinator fixture condition did not arrive");
}
function fixture(options: { recover?: boolean; model?: string; provider?: string; timeoutMs?: number; cleanupMs?: number; checkGoal?: boolean | ((threadId: string) => boolean | Promise<boolean>); allowFailedState?: (threadId: string) => boolean | Promise<boolean>; shouldRecover?: (threadId: string, model: string) => boolean | Promise<boolean> } = {}) {
  let model = options.model || source; let status = "idle"; let active = false; let effort: string | null = "ultra";
  const calls: { method: string; params: Message }[] = [];
  const hook: { run?: (method: string, params: Message) => Promise<Message | undefined> | Message | undefined } = {};
  const recovery = new CompactionRecovery({ aliases: new Set([source, target]), isActive: () => active,
    shouldRecover: options.shouldRecover ?? (() => options.recover !== false), timeoutMs: options.timeoutMs || 1000, cleanupMs: options.cleanupMs || 50, checkGoal: options.checkGoal, allowFailedState: options.allowFailedState,
    request: async (method, params) => {
      calls.push({ method, params });
      const custom = await hook.run?.(method, params); if (custom !== undefined) return custom;
      if (method === "thread/read") return { thread: { id: threadId, modelProvider: options.provider || "subscription_gateway", model, reasoningEffort: effort, status: { type: status } } };
      if (method === "thread/goal/get") return { goal: null };
      if (method === "thread/settings/update") {
        if (typeof params.model === "string") model = params.model;
        if (typeof params.effort === "string") effort = params.effort;
        if (params.collaborationMode) {
          const selected = (params.collaborationMode as { settings: { model: string; reasoning_effort: string | null } }).settings;
          model = selected.model; effort = selected.reasoning_effort ?? null;
        }
        return { status: "applied" };
      }
      if (method === "thread/compact/start") { start(); return {}; }
      if (method === "turn/interrupt") { finish("interrupted"); return {}; }
      return {};
    } });
  const notify = (method: string, params: Message) => recovery.observe({ method, params: { threadId, ...params } });
  const start = () => {
    active = true; status = "active"; notify("turn/started", { turn: { id: compactTurn, status: "inProgress" } });
    notify("item/started", { turnId: compactTurn, item: { id: "real-compact-item", type: "contextCompaction" } });
  };
  const item = () => notify("item/completed", { turnId: compactTurn, item: { id: "real-compact-item", type: "contextCompaction" } });
  const finish = (terminal = "completed", turnId = compactTurn) => {
    active = false; status = "idle"; notify("turn/completed", { turn: { id: turnId, status: terminal } });
  };
  return { recovery, calls, hook, start, item, finish, notify, sdkSettings: () => ({ model, effort }),
    setActive(value: boolean) { active = value; }, setStatus(value: string) { status = value; }, setModel(value: string) { model = value; } };
}
const reason = (expected: string) => (error: unknown): boolean => error instanceof CompactionRecoveryError && error.code === -32001 && error.reason === expected;

test("native models and healthy gateway histories pass through without metadata or SDK calls", async () => {
  const f = fixture({ recover: false });
  await f.recovery.prepare(threadId, target); await f.recovery.prepare(threadId, "native-gpt");
  assert.deepEqual(f.calls, []); assert.equal(await f.recovery.interceptInterrupt(threadId, "native-turn"), undefined);
  await f.recovery.close();
});

test("policy refusals retain their clear shared, incompatible, and active-goal application errors", async () => {
  for (const selected of ["shared", "incompatible", "goal"] as const) {
    let calls = 0;
    const recovery = new CompactionRecovery({ aliases: new Set([target]), isActive: () => false,
      shouldRecover: () => { throw new CompactionRecoveryError(selected); },
      request: async () => { calls++; return {}; } });
    await assert.rejects(recovery.prepare(threadId, target), reason(selected));
    assert.equal(calls, 0); assert.equal(recovery.isBusy(threadId), false); await recovery.close();
  }
});

test("cancellation winning a healthy-policy race still prevents the original user turn", async () => {
  const f = fixture({ recover: false }); const prepared = f.recovery.prepare(threadId, target);
  const rejected = assert.rejects(prepared, reason("interrupted"));
  await f.recovery.interceptInterrupt(threadId); await rejected;
  assert.deepEqual(f.calls, []); await f.recovery.close();
});

test("a stale gateway binding never applies settings or compaction to the primary account", async () => {
  const f = fixture({ provider: "openai" }); await f.recovery.prepare(threadId, target);
  assert.deepEqual(f.calls.map(call => call.method), ["thread/read"]); await f.recovery.close();
});

test("selected-model recovery waits actual item and completed turn, including notifications before RPC ACK", async () => {
  const f = fixture(); const ack = deferred<Message>(); let userTurnSent = false;
  f.hook.run = method => { if (method === "thread/compact/start") { f.start(); return ack.promise; } };
  const prepared = f.recovery.prepare(threadId, target).then(() => { userTurnSent = true; });
  await until(() => f.calls.some(call => call.method === "thread/compact/start"));
  assert.equal(f.recovery.isBusy(threadId), true); assert.equal(userTurnSent, false);
  f.item(); f.finish(); await delay(1); assert.equal(userTurnSent, false);
  ack.resolve({}); await prepared; assert.equal(userTurnSent, true);
  assert.deepEqual(f.calls.map(call => call.method), ["thread/read", "thread/goal/get", "thread/settings/update", "thread/read", "thread/goal/get", "thread/read", "thread/compact/start"]);
  assert.deepEqual(f.calls.find(call => call.method === "thread/settings/update")?.params, { threadId, model: target });
  assert.equal(f.recovery.isBusy(threadId), false); await f.recovery.close();
});

test("no-op target selection needs no nonexistent settings notification", async () => {
  const f = fixture({ model: target });
  f.hook.run = method => { if (method === "thread/compact/start") { f.start(); f.item(); f.finish(); return {}; } };
  await f.recovery.prepare(threadId, target);
  assert.deepEqual(f.calls.map(call => call.method), ["thread/read", "thread/goal/get", "thread/goal/get", "thread/read", "thread/compact/start"]);
  await f.recovery.close();
});

test("explicit thread Standard follows a model change; active-turn tier and access fields remain untouched", async () => {
  for (const settings of [
    { serviceTier: null, serviceTierForTurn: "priority", effort: "max", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
    { config: { service_tier: null }, serviceTierForTurn: "priority" },
    { serviceTier: null, config: { service_tier: "priority" } },
  ]) {
    const f = fixture(); const original = structuredClone(settings);
    f.hook.run = method => { if (method === "thread/compact/start") { f.start(); f.item(); f.finish(); return {}; } };
    await f.recovery.prepare(threadId, target, settings);
    assert.deepEqual(f.calls.find(call => call.method === "thread/settings/update")?.params, { threadId, model: target, serviceTier: null, ...("effort" in settings ? { effort: settings.effort } : {}) });
    assert.deepEqual(settings, original); await f.recovery.close();
  }
  const temporary = fixture();
  temporary.hook.run = method => { if (method === "thread/compact/start") { temporary.start(); temporary.item(); temporary.finish(); return {}; } };
  await temporary.recovery.prepare(threadId, target, { serviceTierForTurn: "priority" });
  assert.deepEqual(temporary.calls.find(call => call.method === "thread/settings/update")?.params, { threadId, model: target });
  await temporary.recovery.close();
});

test("explicit no-op thread tier needs no notification when model already matches", async () => {
  const f = fixture({ model: target });
  f.hook.run = method => { if (method === "thread/compact/start") { f.start(); f.item(); f.finish(); return {}; } };
  await f.recovery.prepare(threadId, target, { serviceTier: null });
  assert.deepEqual(f.calls.find(call => call.method === "thread/settings/update")?.params, { threadId, model: target, serviceTier: null });
  await f.recovery.close();
});

test("manual recovery uses explicit target effort rather than the previous model's Ultra", async () => {
  const f = fixture(); const selected = { effort: "max", serviceTierForTurn: "priority", approvalPolicy: "never" };
  f.hook.run = method => {
    if (method === "thread/compact/start") { assert.deepEqual(f.sdkSettings(), { model: target, effort: "max" }); f.start(); f.item(); f.finish(); return {}; }
  };
  await f.recovery.prepare(threadId, target, selected);
  assert.deepEqual(f.calls.find(call => call.method === "thread/settings/update")?.params, { threadId, model: target, effort: "max" });
  assert.deepEqual(selected, { effort: "max", serviceTierForTurn: "priority", approvalPolicy: "never" }); await f.recovery.close();
});

test("the complete explicit collaboration mode wins effort, retaining automatic null and chosen instructions", async () => {
  for (const effort of ["max", null]) {
    const f = fixture();
    const selected = { effort: "ultra", collaborationMode: { mode: "plan", settings: { model: target, reasoning_effort: effort, developer_instructions: "Selected mode instruction" } } };
    const original = structuredClone(selected);
    f.hook.run = method => {
      if (method === "thread/compact/start") { assert.deepEqual(f.sdkSettings(), { model: target, effort }); f.start(); f.item(); f.finish(); return {}; }
    };
    await f.recovery.prepare(threadId, target, selected);
    assert.deepEqual(f.calls.find(call => call.method === "thread/settings/update")?.params, { threadId, model: target, ...selected });
    assert.deepEqual(selected, original); await f.recovery.close();
  }
  const topLevelNull = fixture();
  topLevelNull.hook.run = method => { if (method === "thread/compact/start") { assert.equal(topLevelNull.sdkSettings().effort, "ultra"); topLevelNull.start(); topLevelNull.item(); topLevelNull.finish(); return {}; } };
  await topLevelNull.recovery.prepare(threadId, target, { effort: null }); await topLevelNull.recovery.close();
});

test("an inferred model follows the current SDK default without restoring a stale selection", async () => {
  const qualified: string[] = [];
  const f = fixture({ model: source, shouldRecover: (_id, model) => { qualified.push(model); return true; } });
  f.hook.run = method => { if (method === "thread/compact/start") { assert.equal(f.sdkSettings().model, source); f.start(); f.item(); f.finish(); return {}; } };
  await f.recovery.prepare(threadId, target, { serviceTier: null }, true);
  assert.deepEqual(qualified, [target, source]);
  assert.deepEqual(f.calls.find(call => call.method === "thread/settings/update")?.params, { threadId, serviceTier: null }); await f.recovery.close();
  const healthy = fixture({ model: source, shouldRecover: (_id, model) => model === target });
  await healthy.recovery.prepare(threadId, target, {}, true);
  assert.deepEqual(healthy.calls.map(call => call.method), ["thread/read"]); await healthy.recovery.close();
});

test("an inferred default changed after confirmation refuses compaction without forcing its old model", async () => {
  const f = fixture({ model: source }); let goals = 0;
  f.hook.run = method => {
    if (method === "thread/goal/get" && ++goals === 2) f.setModel(target);
    return undefined;
  };
  await assert.rejects(f.recovery.prepare(threadId, source, {}, true), reason("unconfirmed"));
  assert.equal(f.calls.some(call => ["thread/settings/update", "thread/compact/start"].includes(call.method)), false);
  assert.equal(f.sdkSettings().model, target); await f.recovery.close();
});

test("queued model updates wait applied state and never compact with the old model", async () => {
  const f = fixture();
  f.hook.run = async method => {
    if (method === "thread/settings/update") return { status: "queued" };
    if (method === "thread/compact/start") { assert.equal(appliedModel, target); f.start(); f.item(); f.finish(); return {}; }
  };
  let appliedModel = source;
  const prepared = f.recovery.prepare(threadId, target);
  await until(() => f.calls.filter(call => call.method === "thread/read").length === 2);
  assert.equal(f.calls.some(call => call.method === "thread/compact/start"), false);
  appliedModel = target; f.setModel(target);
  f.notify("thread/settings/updated", { threadSettings: { modelProvider: "subscription_gateway", model: target } });
  await prepared; await f.recovery.close();
});

test("local active turns and SDK-active goal work are never aborted for recovery", async () => {
  const local = fixture(); local.setActive(true);
  await assert.rejects(local.recovery.prepare(threadId, target), reason("busy")); assert.deepEqual(local.calls, []);
  const sdk = fixture(); sdk.setStatus("active");
  await assert.rejects(sdk.recovery.prepare(threadId, target), reason("busy"));
  assert.deepEqual(sdk.calls.map(call => call.method), ["thread/read"]);
  await Promise.all([local.recovery.close(), sdk.recovery.close()]);
});

test("known terminal compaction failure permits SDK SystemError recovery while unknown or active errors still refuse", async () => {
  const known = fixture({ model: target, allowFailedState: async id => { assert.equal(id, threadId); return true; } });
  known.setStatus("systemError");
  known.hook.run = method => { if (method === "thread/compact/start") { known.start(); known.item(); known.finish(); return {}; } };
  await known.recovery.prepare(threadId, target);
  assert.equal(known.calls.filter(call => call.method === "thread/compact/start").length, 1);
  const unknown = fixture({ model: target }); unknown.setStatus("systemError");
  await assert.rejects(unknown.recovery.prepare(threadId, target), reason("unconfirmed"));
  const active = fixture({ model: target, allowFailedState: () => true }); active.setStatus("systemError"); active.setActive(true);
  await assert.rejects(active.recovery.prepare(threadId, target), reason("busy"));
  assert.equal(active.calls.some(call => call.method === "thread/compact/start"), false);
  await Promise.all([known.recovery.close(), unknown.recovery.close(), active.recovery.close()]);
});

test("cancel and activity still win while asynchronous failure provenance is being read", async () => {
  const pending = deferred<boolean>(); const f = fixture({ model: target, allowFailedState: () => pending.promise }); f.setStatus("systemError");
  const prepared = f.recovery.prepare(threadId, target); const rejected = assert.rejects(prepared, reason("interrupted"));
  await until(() => f.calls.length === 1); await f.recovery.interceptInterrupt(threadId); await rejected;
  pending.resolve(true); await delay(1); assert.equal(f.calls.some(call => call.method === "thread/compact/start"), false); await f.recovery.close();
});

test("active goals are never paused or changed; unknown goal state conservatively refuses recovery", async () => {
  for (const goal of [{ threadId, status: "active" }, { threadId, status: "unknown" }, undefined]) {
    const f = fixture(); f.hook.run = method => method === "thread/goal/get" ? { goal } : undefined;
    await assert.rejects(f.recovery.prepare(threadId, target), reason(goal?.status === "active" ? "goal" : "unconfirmed"));
    assert.deepEqual(f.calls.map(call => call.method), ["thread/read", "thread/goal/get"]);
    await f.recovery.close();
  }
});

test("a goal activated after the first idle check refuses compact without a goal mutation", async () => {
  const f = fixture({ model: target }); let checks = 0;
  f.hook.run = method => method === "thread/goal/get" ? { goal: ++checks === 1 ? null : { threadId, status: "active" } } : undefined;
  await assert.rejects(f.recovery.prepare(threadId, target), reason("goal"));
  assert.equal(f.calls.some(call => ["thread/compact/start", "thread/goal/set", "thread/goal/clear", "thread/settings/update"].includes(call.method)), false);
  await f.recovery.close();
});

test("confirmed disabled goals skip the unsupported RPC; paused goals retain their state", async () => {
  for (const checkGoal of [false, (id: string) => { assert.equal(id, threadId); return false; }]) {
    const f = fixture({ model: target, checkGoal });
    f.hook.run = method => { if (method === "thread/goal/get") assert.fail("Disabled goals queried"); if (method === "thread/compact/start") { f.start(); f.item(); f.finish(); return {}; } };
    await f.recovery.prepare(threadId, target); assert.equal(f.calls.some(call => call.method === "thread/goal/get"), false); await f.recovery.close();
  }
  const paused = fixture({ model: target });
  paused.hook.run = method => {
    if (method === "thread/goal/get") return { goal: { threadId, status: "paused" } };
    if (method === "thread/compact/start") { paused.start(); paused.item(); paused.finish(); return {}; }
  };
  await paused.recovery.prepare(threadId, target);
  assert.equal(paused.calls.some(call => ["thread/goal/set", "thread/goal/clear"].includes(call.method)), false);
  await paused.recovery.close();
});

test("late idle-check races and competing turn notifications refuse compaction without interrupting that work", async () => {
  for (const useNotification of [false, true]) {
    const f = fixture({ model: target }); let reads = 0;
    f.hook.run = method => {
      if (method === "thread/read" && ++reads === 2) {
        if (useNotification) f.notify("turn/started", { turn: { id: "unrelated-goal-turn", status: "inProgress" } });
        else f.setStatus("active");
      }
      return undefined;
    };
    await assert.rejects(f.recovery.prepare(threadId, target), reason("busy"));
    assert.equal(f.calls.some(call => ["thread/compact/start", "turn/interrupt"].includes(call.method)), false);
    await f.recovery.close();
  }
});

test("barrier rejects a second user turn; unrelated completion cannot release it", async () => {
  const f = fixture({ model: target }); const prepared = f.recovery.prepare(threadId, target);
  await until(() => f.calls.some(call => call.method === "thread/compact/start"));
  await assert.rejects(f.recovery.prepare(threadId, target), reason("busy"));
  f.finish("completed", "unrelated-turn"); f.item(); await delay(2);
  assert.equal(f.recovery.isBusy(threadId), true);
  f.finish(); await prepared; await f.recovery.close();
});

test("turn completion alone does not fabricate successful compaction", async () => {
  const f = fixture({ model: target }); const prepared = f.recovery.prepare(threadId, target);
  await until(() => f.calls.some(call => call.method === "thread/compact/start"));
  f.finish(); await delay(2); assert.equal(f.recovery.isBusy(threadId), true);
  f.item(); await prepared; await f.recovery.close();
});

test("failed manual recovery returns one safe error and a later explicit retry succeeds", async () => {
  const f = fixture({ model: target }); const prepared = f.recovery.prepare(threadId, target);
  await until(() => f.calls.some(call => call.method === "thread/compact/start"));
  f.finish("failed"); await assert.rejects(prepared, reason("failed"));
  assert.equal(f.calls.filter(call => call.method === "thread/compact/start").length, 1);
  assert.equal(f.recovery.isBusy(threadId), false);
  f.hook.run = method => { if (method === "thread/compact/start") { f.start(); f.item(); f.finish(); return {}; } };
  await f.recovery.prepare(threadId, target);
  assert.equal(f.calls.filter(call => call.method === "thread/compact/start").length, 2);
  await f.recovery.close();
});

test("interrupt during recovery cancels its actual SDK turn instead of a supplied old turn", async () => {
  const f = fixture({ model: target }); const prepared = f.recovery.prepare(threadId, target);
  const rejected = assert.rejects(prepared, reason("interrupted"));
  await until(() => f.calls.some(call => call.method === "thread/compact/start"));
  assert.deepEqual(await f.recovery.interceptInterrupt(threadId, "old-user-turn"), {});
  await rejected;
  assert.deepEqual(f.calls.filter(call => call.method === "turn/interrupt").map(call => call.params), [{ threadId, turnId: compactTurn }]);
  await f.recovery.close();
});

test("cancel before compact ACK waits its real turn ID; duplicate interrupts share one cleanup", async () => {
  const f = fixture({ model: target }); const ack = deferred<Message>();
  f.hook.run = method => method === "thread/compact/start" ? ack.promise : undefined;
  const prepared = f.recovery.prepare(threadId, target); const rejected = assert.rejects(prepared, reason("interrupted"));
  await until(() => f.calls.some(call => call.method === "thread/compact/start"));
  const first = f.recovery.interceptInterrupt(threadId); const second = f.recovery.interceptInterrupt(threadId, "anything");
  assert.equal(f.calls.some(call => call.method === "turn/interrupt"), false);
  f.start(); ack.resolve({}); await Promise.all([first, second, rejected]);
  assert.equal(f.calls.filter(call => call.method === "turn/interrupt").length, 1);
  assert.deepEqual(f.calls.find(call => call.method === "turn/interrupt")?.params, { threadId, turnId: compactTurn });
  await f.recovery.close();
});

test("cancel during model confirmation starts no compaction, even if the pending read later resolves", async () => {
  const f = fixture(); const read = deferred<Message>();
  f.hook.run = method => method === "thread/read" ? read.promise : undefined;
  const prepared = f.recovery.prepare(threadId, target); const rejected = assert.rejects(prepared, reason("interrupted"));
  await until(() => f.calls.length === 1);
  await f.recovery.interceptInterrupt(threadId); await rejected;
  read.resolve({ thread: { id: threadId, modelProvider: "subscription_gateway", model: source, status: { type: "idle" } } });
  await delay(1); assert.deepEqual(f.calls.map(call => call.method), ["thread/read"]);
  await f.recovery.close();
});

test("missing compact turn ID never interrupts an unrelated requested ID or reports cancellation success", async () => {
  const f = fixture({ model: target, cleanupMs: 10 }); const ack = deferred<Message>();
  f.hook.run = method => method === "thread/compact/start" ? ack.promise : undefined;
  const prepared = f.recovery.prepare(threadId, target); const rejected = assert.rejects(prepared, reason("interrupted"));
  await until(() => f.calls.some(call => call.method === "thread/compact/start"));
  await assert.rejects(f.recovery.interceptInterrupt(threadId, "unrelated-turn"), reason("timeout"));
  await rejected;
  assert.equal(f.calls.some(call => call.method === "turn/interrupt"), false);
  ack.resolve({}); await f.recovery.close();
});

test("a competing turn after compact request is never an interrupt target without a compaction marker", async () => {
  const f = fixture({ model: target, cleanupMs: 10 }); const ack = deferred<Message>();
  f.hook.run = method => method === "thread/compact/start" ? ack.promise : undefined;
  const prepared = f.recovery.prepare(threadId, target); const rejected = assert.rejects(prepared, reason("interrupted"));
  await until(() => f.calls.some(call => call.method === "thread/compact/start"));
  f.notify("turn/started", { turn: { id: "unrelated-goal-turn", status: "inProgress" } });
  await assert.rejects(f.recovery.interceptInterrupt(threadId, "unrelated-goal-turn"), reason("timeout"));
  await rejected; assert.equal(f.calls.some(call => call.method === "turn/interrupt"), false);
  assert.equal(f.recovery.isBusy(threadId), true);
  ack.resolve({}); await f.recovery.close();
});

test("uncertain late compact starts keep admission blocked until actual cancellation completes", async () => {
  const f = fixture({ model: target, timeoutMs: 10, cleanupMs: 10 }); const ack = deferred<Message>();
  f.hook.run = method => method === "thread/compact/start" ? ack.promise : undefined;
  await assert.rejects(f.recovery.prepare(threadId, target), reason("timeout"));
  assert.equal(f.recovery.isBusy(threadId), true);
  await assert.rejects(f.recovery.prepare(threadId, target), reason("reconnect"));
  assert.equal(f.calls.filter(call => call.method === "thread/compact/start").length, 1);
  ack.resolve({}); f.start();
  await until(() => !f.recovery.isBusy(threadId));
  assert.deepEqual(f.calls.filter(call => call.method === "turn/interrupt").map(call => call.params), [{ threadId, turnId: compactTurn }]);
  f.hook.run = method => { if (method === "thread/compact/start") { f.start(); f.item(); f.finish(); return {}; } };
  await f.recovery.prepare(threadId, target); await f.recovery.close();
});

test("an authoritative SDK compact rejection releases its guard for an explicit retry", async () => {
  const f = fixture({ model: target });
  f.hook.run = method => { if (method === "thread/compact/start") throw Object.assign(Error("private SDK reason"), { code: -32600 }); return undefined; };
  await assert.rejects(f.recovery.prepare(threadId, target), reason("failed"));
  assert.equal(f.recovery.isBusy(threadId), false);
  assert.equal(f.calls.some(call => call.method === "turn/interrupt"), false);
  f.hook.run = method => { if (method === "thread/compact/start") { f.start(); f.item(); f.finish(); return {}; } };
  await f.recovery.prepare(threadId, target); await f.recovery.close();
});

test("a preparation failure before its compaction marker returns promptly and clearly requires reconnection", async () => {
  const f = fixture({ model: target, cleanupMs: 10 });
  f.hook.run = method => {
    if (method === "thread/compact/start") {
      f.notify("turn/started", { turn: { id: compactTurn, status: "inProgress" } });
      f.notify("turn/completed", { turn: { id: compactTurn, status: "failed" } }); return {};
    }
  };
  const at = Date.now(); await assert.rejects(f.recovery.prepare(threadId, target), reason("reconnect"));
  assert.ok(Date.now() - at < 500); assert.equal(f.recovery.isBusy(threadId), true);
  assert.throws(() => f.recovery.assertAvailable(threadId), reason("reconnect"));
  assert.equal(f.calls.some(call => call.method === "turn/interrupt"), false);
  await f.recovery.close();
});

test("bounded timeout interrupts only the owned compaction and releases its barrier", async () => {
  const f = fixture({ model: target, timeoutMs: 20 });
  await assert.rejects(f.recovery.prepare(threadId, target), reason("timeout"));
  assert.deepEqual(f.calls.find(call => call.method === "turn/interrupt")?.params, { threadId, turnId: compactTurn });
  assert.equal(f.recovery.isBusy(threadId), false); await f.recovery.close();
});

test("shutdown wakes waiting recovery, cancels only its actual turn, and rejects later gateway work", async () => {
  const f = fixture({ model: target }); const prepared = f.recovery.prepare(threadId, target);
  const rejected = assert.rejects(prepared, reason("closed"));
  await until(() => f.calls.some(call => call.method === "thread/compact/start"));
  await f.recovery.close(); await rejected;
  assert.deepEqual(f.calls.find(call => call.method === "turn/interrupt")?.params, { threadId, turnId: compactTurn });
  await assert.rejects(f.recovery.prepare(threadId, target), reason("closed"));
  await f.recovery.prepare(threadId, "native-model");
});

test("SDK completion notifications remain unchanged for the original desktop forwarding path", async () => {
  const f = fixture({ model: target }); const prepared = f.recovery.prepare(threadId, target);
  await until(() => f.calls.some(call => call.method === "thread/compact/start"));
  const original = { method: "item/completed", params: { threadId, turnId: compactTurn, item: { id: "item", type: "contextCompaction" } }, emittedAtMs: 1234 };
  const snapshot = structuredClone(original);
  Object.freeze(original.params.item); Object.freeze(original.params); Object.freeze(original);
  f.recovery.observe(original); f.finish(); await prepared;
  assert.deepEqual(original, snapshot); await f.recovery.close();
});

test("unknown SDK states and raw RPC failures return safe application errors without provider fallback", async () => {
  const unknown = fixture(); unknown.setStatus("notLoaded");
  await assert.rejects(unknown.recovery.prepare(threadId, target), reason("unconfirmed"));
  const failed = fixture(); failed.hook.run = () => { throw Error("secret bearer token private upstream URL"); };
  await assert.rejects(failed.recovery.prepare(threadId, target), error => {
    assert.ok(error instanceof CompactionRecoveryError); assert.equal(error.reason, "failed");
    assert.doesNotMatch(error.message, /secret|bearer|URL/); return true;
  });
  assert.equal(failed.calls.length, 1);
  await Promise.all([unknown.recovery.close(), failed.recovery.close()]);
});
