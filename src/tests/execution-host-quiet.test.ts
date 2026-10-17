import test from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecutionRecord } from "../execution-host.js";
import type { NativeExecutionRecord } from "../native-execution-host-engine.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";
import { quietHost, seconds } from "./quiet-host-fixture.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.

test("a quiet stop ignores leases and loaded chats, but waits for a running turn and for the quiet time after it", { timeout: 30000 }, async () => {
  const f = await quietHost();
  try {
    const record = await f.control<ExecutionRecord>("execution/acquire", f.descriptor); // This control connection now holds a lease.
    const chat = await f.chat(record.socketPath, "quiet-chat");
    assert.equal(await f.host.prepareStop(), false, "the strict idle check refuses a lease and a loaded chat");
    await chat.turn({ status: "inProgress" });
    assert.deepEqual(await f.host.prepareQuietStop!(400), { wait: "running" });
    await chat.turn({ status: "completed", completedAt: seconds() });
    assert.deepEqual(await f.host.prepareQuietStop!(400), { wait: "recent_turn" }, "a turn that ended within the quiet time");
    await delay(450);
    assert.deepEqual(await f.host.prepareQuietStop!(400), { loadedChats: 1 }, "quiet: the lease and the loaded chat did not block it");
    // The gate is closed exactly as for an idle stop: no acquire or find slips in before the close.
    await assert.rejects(f.control("execution/find", { threadId: "quiet-chat" }), /quiescing/);
    await assert.rejects(f.control("execution/acquire", f.descriptor), /quiescing/);
    assert.equal(await f.host.prepareQuietStop!(400), undefined, "a second quiet stop while the gate is closed refuses");
    f.host.resume();
    assert.equal((await f.control<ExecutionRecord>("execution/find", { threadId: "quiet-chat" })).revision, record.revision, "resume reopens the gate");
  } finally { await f.clean(); }
});

test("a chat waiting on an approval runs, an undefined status is unreadable, and a turn with no completion time ends at its last write", { timeout: 30000 }, async () => {
  const f = await quietHost();
  try {
    const record = await f.control<ExecutionRecord>("execution/acquire", f.descriptor);
    const chat = await f.chat(record.socketPath, "approval-chat");
    await chat.turn({ status: "completed", completedAt: seconds(3_600_000) });
    await chat.status({ type: "loading" });
    assert.deepEqual(await f.host.prepareQuietStop!(60_000), { wait: "unreadable" }, "a status the pinned SDK does not define is not proof of quiet");
    await chat.status({ type: "idle" });
    assert.deepEqual(await f.host.prepareQuietStop!(60_000), { loadedChats: 1 }, "the newest turn ended an hour ago");
    f.host.resume();
    // An interrupted turn without completedAt, started an hour ago, whose chat was written ten seconds ago, ended then.
    await chat.turn({ status: "interrupted", completedAt: null, startedAt: seconds(3_600_000) }); await chat.updated(seconds(10_000));
    assert.deepEqual(await f.host.prepareQuietStop!(60_000), { wait: "recent_turn" }, "the later of its start and the chat's last write");
    await chat.status({ type: "active", activeFlags: ["waitingOnApproval"] });
    assert.deepEqual(await f.host.prepareQuietStop!(60_000), { wait: "running" }, "a turn waiting on an approval is a running turn");
    await chat.status({ type: "idle" }); await chat.updated(seconds(3_600_000));
    assert.deepEqual(await f.host.prepareQuietStop!(60_000), { wait: "recent_turn" }, "seen waiting at the last check, so its turn ended at the latest now");
  } finally { await f.clean(); }
});

test("an engine that exits during a turn clears its turns, and the turn counts as ended at the next check", { timeout: 30000 }, async () => {
  const f = await quietHost();
  try {
    const record = await f.control<ExecutionRecord>("execution/acquire", f.descriptor);
    const chat = await f.chat(record.socketPath, "exit-chat");
    await chat.turn({ status: "inProgress" });
    assert.deepEqual(await f.host.prepareQuietStop!(400), { wait: "running" });
    await assert.rejects(chat.engine.request("fixture/exit", {}));
    for (let attempt = 0; attempt < 200 && !((await f.control<{ generations: Array<{ state: string }> }>("execution/status")).generations[0]?.state === "exited"); attempt++) await delay(10);
    assert.deepEqual(await f.host.prepareQuietStop!(400), { wait: "recent_turn" }, "the turn the exit cut ended just now");
    await delay(450);
    assert.deepEqual(await f.host.prepareQuietStop!(400), { loadedChats: 0 }, "nothing runs once the quiet time has passed");
    f.host.resume();
  } finally { await f.clean(); }
});

test("a native chat's running turn blocks a quiet stop as a gateway chat's does", { timeout: 30000 }, async () => {
  const f = await quietHost(["native", "gateway"]);
  try {
    const native = await f.control<NativeExecutionRecord>("native/acquire", { args: ["app-server", "--listen", "stdio://"], cwd: dirname(f.nativeHome) });
    const chat = await f.chat(native.socketPath, "native-chat");
    await chat.turn({ status: "inProgress" });
    assert.deepEqual(await f.host.prepareQuietStop!(60_000), { wait: "running" }, "a running native turn refuses");
    await chat.turn({ status: "interrupted", completedAt: null, startedAt: seconds(3_600_000) }); await chat.updated(seconds(3_600_000));
    assert.deepEqual(await f.host.prepareQuietStop!(60_000), { wait: "recent_turn" }, "seen running at the last check, so it ended at the latest now");
    assert.deepEqual(await f.host.prepareQuietStop!(0), { loadedChats: 1 });
    f.host.resume();
  } finally { await f.clean(); }
});

test("a saved chat untouched for well over the quiet time is judged by its read alone, without replaying its history", { timeout: 30000 }, async () => {
  const f = await quietHost();
  try {
    const record = await f.control<ExecutionRecord>("execution/acquire", f.descriptor);
    const chat = await f.chat(record.socketPath, "idle-for-days");
    await chat.turn({ status: "completed", completedAt: seconds(2 * 86_400_000) }); await chat.updated(seconds(2 * 86_400_000));
    assert.deepEqual(await f.host.prepareQuietStop!(300_000), { loadedChats: 1 });
    assert.equal(await chat.turnReads(), 0, "the newest turn was not read");
    f.host.resume();
  } finally { await f.clean(); }
});
