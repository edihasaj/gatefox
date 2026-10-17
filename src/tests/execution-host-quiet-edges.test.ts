import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { rename } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecutionRecord } from "../execution-host.js";
import { ExecutionHostClient } from "../execution-host-client.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";
import { quietHost, seconds } from "./quiet-host-fixture.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.

test("a chat whose agent left a background terminal running is never quiet, and one whose terminals cannot be listed is unreadable", { timeout: 30000 }, async () => {
  const f = await quietHost();
  try {
    const record = await f.control<ExecutionRecord>("execution/acquire", f.descriptor);
    const chat = await f.chat(record.socketPath, "dev-server-chat");
    // The turn ended long ago, but its `npm run dev` outlives it until the engine closes the session.
    await chat.turn({ status: "completed", completedAt: seconds(2 * 86_400_000) }); await chat.updated(seconds(2 * 86_400_000));
    await chat.terminal(true);
    assert.deepEqual(await f.host.prepareQuietStop!(60_000), { wait: "background_terminal" });
    await chat.terminal("fail");
    assert.deepEqual(await f.host.prepareQuietStop!(60_000), { wait: "unreadable" });
    await chat.terminal(false);
    assert.deepEqual(await f.host.prepareQuietStop!(60_000), { loadedChats: 1 }, "quiet once the terminal has ended");
    f.host.resume();
  } finally { await f.clean(); }
});

test("a throwaway chat or one with nothing saved is quiet only after it was seen settled for the quiet time; a chat with no turns is quiet at once", { timeout: 30000 }, async () => {
  const f = await quietHost();
  try {
    const record = await f.control<ExecutionRecord>("execution/acquire", f.descriptor);
    const empty = await f.chat(record.socketPath, "saved-without-turns"); await empty.saved();
    assert.deepEqual(await f.host.prepareQuietStop!(400), { loadedChats: 1 }, "no turn, so nothing ended: its read-time updatedAt is not a turn");
    f.host.resume();
    // Its turns cannot be listed and its updatedAt is the time of each read: only the host's own watch can tell.
    const unsaved = await f.chat(record.socketPath, "nothing-saved-yet");
    assert.deepEqual(await f.host.prepareQuietStop!(400), { wait: "ephemeral_settling" });
    await delay(450);
    assert.deepEqual(await f.host.prepareQuietStop!(400), { loadedChats: 2 }, "seen settled across checks for the quiet time");
    f.host.resume();
    const throwaway = await f.chat(record.socketPath, "prediction-fork"); await throwaway.updated(seconds(), true);
    assert.deepEqual(await f.host.prepareQuietStop!(400), { wait: "ephemeral_settling" });
    await throwaway.status({ type: "active", activeFlags: [] });
    assert.deepEqual(await f.host.prepareQuietStop!(400), { wait: "running" });
    await throwaway.status({ type: "idle" }); await delay(450);
    assert.deepEqual(await f.host.prepareQuietStop!(400), { wait: "ephemeral_settling" }, "the settled watch started again when it ran");
    await delay(450);
    assert.deepEqual(await f.host.prepareQuietStop!(400), { loadedChats: 3 });
    f.host.resume();
    assert.equal(await throwaway.turnReads(), 0, "a throwaway chat's turns are never asked for");
    assert.equal(await unsaved.turnReads(), 6, "an unsaved chat's are, at every check");
  } finally { await f.clean(); }
});

test("an engine the check cannot read makes the host not quiet: a changed socket or an engine that fails to list its chats", { timeout: 30000 }, async () => {
  const f = await quietHost();
  const stranger = createServer();
  try {
    const record = await f.control<ExecutionRecord>("execution/acquire", f.descriptor);
    const chat = await f.chat(record.socketPath, "quiet-for-days");
    await chat.turn({ status: "completed", completedAt: seconds(2 * 86_400_000) }); await chat.updated(seconds(2 * 86_400_000));
    assert.deepEqual(await f.host.prepareQuietStop!(60_000), { loadedChats: 1 });
    f.host.resume();
    // Another listener now answers at the engine's path: it is not this engine, so nothing is asked and nothing is judged.
    await rename(record.socketPath, record.socketPath + ".moved");
    stranger.listen(record.socketPath); await once(stranger, "listening");
    assert.deepEqual(await f.host.prepareQuietStop!(60_000), { wait: "unreadable" });
    await new Promise<void>(resolve => stranger.close(() => resolve())); await rename(record.socketPath + ".moved", record.socketPath);
    assert.deepEqual(await f.host.prepareQuietStop!(60_000), { loadedChats: 1 });
    f.host.resume();
    await chat.engine.request("fixture/broken", {});
    assert.deepEqual(await f.host.prepareQuietStop!(60_000), { wait: "unreadable" });
  } finally { stranger.close(); await f.clean(); }
});

test("an adapter's acquire, find and native acquire wait out a quiet check that is refused, instead of failing as quiescing", { timeout: 30000 }, async () => {
  const f = await quietHost(["native", "gateway"]);
  let client: ExecutionHostClient | undefined;
  try {
    client = await ExecutionHostClient.discover(f.configPath, f.nativeHome, f.codex, "gateway", true);
    const record = await client!.acquire(f.descriptor);
    assert.deepEqual(await f.host.prepareQuietStop!(0), { loadedChats: 0 }, "the gate is closed");
    // Inference refuses its idle guard: the supervisor reopens the gate (up to 3 s later in production).
    const reopened = delay(600).then(() => f.host.resume());
    const started = performance.now();
    assert.deepEqual(await client!.find("no-such-chat"), undefined);
    assert.ok(performance.now() - started >= 500, "find waited for the gate to reopen");
    await reopened;
    assert.deepEqual(await f.host.prepareQuietStop!(0), { loadedChats: 0 });
    setTimeout(() => f.host.resume(), 300);
    assert.equal((await client!.acquire(f.descriptor)).revision, record.revision);
    assert.deepEqual(await f.host.prepareQuietStop!(0), { loadedChats: 0 });
    setTimeout(() => f.host.resume(), 300);
    assert.ok((await client!.acquireNative(["app-server", "--listen", "stdio://"], dirname(f.nativeHome))).pid > 0);
    await assert.rejects(client!.acquire({ ...f.descriptor, settings: { model: "changed" } }), /cannot change/, "other refusals still fail at once");
  } finally { client?.close(); await f.clean(); }
});
