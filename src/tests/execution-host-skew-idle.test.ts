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

const refusedSha = "b".repeat(64);
/** A host whose own gateway SDK is the fixture codex, with release 0.4.7 installed beside it; `idle` collects the releases it reports. */
async function skewHost(pending = true) {
  const idle: string[] = []; let sha = "";
  const f = await quietHost(undefined, codex => ({
    gatewayRuntime: async () => ({ executable: codex, binarySha256: sha, selectedModelCompaction: true as const, executorIdentity: true as const }),
    pendingRelease: async () => pending ? { release: "0.4.7", gatewaySdkSha256: refusedSha } : undefined,
    onSkewIdle: release => { idle.push(release); } }), );
  return { f, idle, async start() {
    sha = (await sdkIdentity(f.codex)).sdkSha256;
    const record = await f.control<ExecutionRecord>("execution/acquire", { ...f.descriptor, gatewaySdkSha256: sha });
    return f.chat(record.socketPath, "busy-chat");
  },
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
