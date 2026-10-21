import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecutionRecord } from "../execution-host.js";
import { isReleaseSkew } from "../execution-host-engine.js";
import { sdkIdentity } from "../execution-host-storage.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";
import { quietHost, seconds } from "./quiet-host-fixture.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.
process.env.GATEWAY_SKEW_WATCH_MS = "5"; // Production looks once a second.
process.env.GATEWAY_UPGRADE_URGENT_MS = "80"; // And backs off to the supervisor's 10 second tick.

const refusedSha = "b".repeat(64);
/** A host whose own gateway SDK is the fixture codex, with release 0.4.7 installed beside it; `idle` collects the releases it reports. */
async function skewHost(pending = true) {
  const idle: string[] = []; let sha = ""; let record: ExecutionRecord | undefined;
  const state: { pending?: { release: string; gatewaySdkSha256: string } } = pending ? { pending: { release: "0.4.7", gatewaySdkSha256: refusedSha } } : {};
  const f = await quietHost(undefined, codex => ({
    gatewayRuntime: async () => {
      const binarySha256 = (await sdkIdentity(codex)).sdkSha256;
      sha ||= binarySha256;
      return { executable: codex, binarySha256, selectedModelCompaction: true as const, executorIdentity: true as const, codeModeHost: false };
    },
    pendingRelease: async () => state.pending,
    onSkewIdle: release => { idle.push(release); } }), );
  return { f, idle, state, async start() {
    sha = (await sdkIdentity(f.codex)).sdkSha256;
    record = await f.control<ExecutionRecord>("execution/acquire", { ...f.descriptor, gatewaySdkSha256: sha });
    return f.chat(record.socketPath, "busy-chat");
  },
  /** Another loaded chat on the same engine, after the first. */
  more: (id: string) => f.chat(record!.socketPath, id),
  /** An adapter of the installed release asks for a generation and is refused. */
  async refuse() { await assert.rejects(f.control("execution/acquire", { ...f.descriptor, revision: "c".repeat(64), gatewaySdkSha256: refusedSha }), error => isReleaseSkew(error)); } };
}

test("an urgent host tells the supervisor in every gap of back-to-back turns, within the gap", { timeout: 30000 }, async () => {
  const h = await skewHost();
  try {
    const chat = await h.start(); await chat.turn({ status: "inProgress" });
    await h.refuse();
    let signalled = 0; const rounds = 8;
    for (let round = 0; round < rounds; round++) {
      await chat.turn({ status: "completed", completedAt: seconds() }); // The gap opens.
      const before = h.idle.length; await delay(50);                     // One 50 ms gap.
      if (h.idle.length > before) signalled++;
      await chat.turn({ status: "inProgress" }); await delay(60);       // The next turn starts, so the host is busy again.
    }
    assert.ok(signalled >= 5, `the host spoke up inside most 50 ms gaps (${signalled} of ${rounds})`);
    assert.ok(h.idle.every(release => release === "0.4.7"), "it names the urgent release");
  } finally { await h.f.clean(); }
});

test("it stays quiet while a turn runs, while a background terminal runs, and speaks once both are over", { timeout: 30000 }, async () => {
  const h = await skewHost();
  try {
    const chat = await h.start(); await chat.turn({ status: "inProgress" });
    await h.refuse(); await delay(300);
    assert.deepEqual(h.idle, [], "a running turn is never reported as a gap");
    await chat.turn({ status: "completed", completedAt: seconds() }); await chat.terminal(true); await delay(300);
    assert.deepEqual(h.idle, [], "a background terminal would be killed with the engine");
    await chat.terminal(false);
    for (let attempt = 0; attempt < 100 && !h.idle.length; attempt++) await delay(10);
    assert.deepEqual(h.idle, ["0.4.7"]);
    await delay(100); assert.equal(h.idle.length, 1, "once per gap, not once per look");
  } finally { await h.f.clean(); }
});

test("a host that has refused no newer adapter does not watch at all", { timeout: 30000 }, async () => {
  const h = await skewHost(false);
  try {
    await h.start(); await h.refuse(); await delay(300);
    assert.deepEqual(h.idle, [], "an older adapter does not make anything urgent, idle or not");
  } finally { await h.f.clean(); }
});

test("a look costs a status read per chat and nothing else, and ends at the first running chat; it never replays a history", { timeout: 30000 }, async () => {
  const h = await skewHost();
  try {
    const first = await h.start(); const second = await h.more("idle-1"); const third = await h.more("idle-2");
    for (const chat of [second, third]) await chat.turn({ status: "completed", completedAt: seconds() }); // Recently touched chats: a quiet check would replay their turns.
    await first.turn({ status: "inProgress" });
    await h.refuse(); await delay(30);
    const before = await first.calls(); await delay(300); const after = await first.calls();
    const spent = (method: string) => (after[method] ?? 0) - (before[method] ?? 0);
    assert.ok(spent("thread/loaded/list") >= 10, "the watcher looked many times");
    assert.ok(Math.abs(spent("thread/read") - spent("thread/loaded/list")) <= 1, "one status read per look: it stopped at the first chat, which is running");
    assert.equal(spent("thread/turns/list"), 0, "no turn list, so no history replay");
    assert.equal(spent("thread/backgroundTerminals/list"), 0, "terminals are asked only when no chat is running");
    // Once nothing runs, a look reads every status and the terminals, still without a turn list.
    await first.turn({ status: "completed", completedAt: seconds() });
    for (let attempt = 0; attempt < 100 && !h.idle.length; attempt++) await delay(10);
    assert.deepEqual(h.idle, ["0.4.7"]); assert.equal((await first.calls())["thread/turns/list"] ?? 0, 0);
  } finally { await h.f.clean(); }
});

test("a look blocked by a background terminal backs off instead of reading every 5 ms, and a gap resets it", { timeout: 30000 }, async () => {
  const h = await skewHost();
  try {
    const chat = await h.start(); await chat.turn({ status: "completed", completedAt: seconds() }); await chat.terminal(true);
    await h.refuse(); await delay(30);
    const before = (await chat.calls())["thread/loaded/list"] ?? 0; await delay(400);
    const looks = ((await chat.calls())["thread/loaded/list"] ?? 0) - before;
    assert.ok(looks >= 2 && looks <= 12, `5, 10, 20, 40, 80 ms then every 80 ms, not every 5 ms (${looks} looks in 400 ms)`);
    assert.deepEqual(h.idle, []);
    await chat.terminal(false);
    for (let attempt = 0; attempt < 100 && !h.idle.length; attempt++) await delay(10);
    assert.deepEqual(h.idle, ["0.4.7"], "the gap is found within the backed-off pace");
    const reset = (await chat.calls())["thread/loaded/list"] ?? 0; await delay(100);
    assert.ok(((await chat.calls())["thread/loaded/list"] ?? 0) - reset >= 6, "a gap resets the pace to the base one");
  } finally { await h.f.clean(); }
});

test("a release stops being urgent when it is no longer the pending one, the watcher stops, and a later refusal starts it again", { timeout: 30000 }, async () => {
  const h = await skewHost();
  try {
    const chat = await h.start(); await h.refuse();
    for (let attempt = 0; attempt < 100 && !h.idle.length; attempt++) await delay(10);
    assert.equal(h.f.host.skewRefused?.("0.4.7"), true); assert.deepEqual(h.idle, ["0.4.7"]);
    h.state.pending = undefined; // A rollback: no newer release is installed any more.
    for (let attempt = 0; attempt < 100 && h.f.host.skewRefused?.("0.4.7"); attempt++) await delay(10);
    assert.equal(h.f.host.skewRefused?.("0.4.7"), false, "the old urgency is gone");
    await delay(50); const looked = (await chat.calls())["thread/loaded/list"] ?? 0; await delay(150);
    assert.equal((await chat.calls())["thread/loaded/list"] ?? 0, looked, "the watcher stopped looking");
    h.state.pending = { release: "0.4.8", gatewaySdkSha256: refusedSha }; // A newer install, and its adapter is refused.
    await h.refuse();
    assert.equal(h.f.host.skewRefused?.("0.4.8"), true); assert.equal(h.f.host.skewRefused?.("0.4.7"), false);
    for (let attempt = 0; attempt < 100 && h.idle.length < 2; attempt++) await delay(10);
    assert.deepEqual(h.idle, ["0.4.7", "0.4.8"], "the watcher started again and reported the new gap");
  } finally { await h.f.clean(); }
});
