import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { restoreReasoning } from "../protocol/reasoning-state.js";
import type { ResponsesRequest } from "../protocol/types.js";
import { CopilotRPC, rpcLimits } from "../providers/copilot-rpc.js";
import { ProviderError } from "../providers/provider.js";
import { adapter, alive, harness, thread, tools, until, user } from "./copilot-live-harness.js";

// A cancelled request ends once the CLI is gone, its folder removed and its event stream ended. Node reports a child's `close` only when
// every pipe to it has closed, so a process outside the CLI's group that holds the CLI's stdout open (a helper the CLI detached) kept
// the request open for as long as it lived. The connection now closes its pipes once the CLI has exited and its output has been silent for
// `rpcLimits.exitGraceMs`, and, for output that never falls silent, at most 100 ticks after the CLI exited.

for (const mode of ["oneshot", "live"] as const) for (const noise of [false, true] as const) {
  test(`a cancelled ${mode} request ends though a process outside the CLI's group still holds the CLI's output open${noise ? " and busy" : ""}`, { skip: process.platform === "win32", timeout: 60000 }, async () => {
    const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_HOLD_STDOUT = "45000"; if (noise) process.env.GATEWAY_COPILOT_LIVE_HOLD_STDOUT_NOISE = "1";
    const tick = Math.max(5, Math.floor(rpcLimits.exitGraceMs / 10));
    let holder: number | undefined;
    try {
      const controller = new AbortController(); let failure: unknown; const started = Date.now();
      const input = restoreReasoning({ model: "fixture", input: [user("go [stall]")], tools } as ResponsesRequest, "scope");
      try { for await (const event of adapter({ mode }).infer(input, controller.signal, thread)) if (event.type === "text") controller.abort(); } catch (error) { failure = error; }
      holder = (await h.log()).find(entry => entry.op === "holder")?.holder;
      const elapsed = Date.now() - started;
      assert.ok(failure instanceof ProviderError && failure.code === "cancelled", String(failure));
      // The output here never falls silent, so only the overall cap can end the request: 100 ticks, not the holder's 45 s (900 ticks).
      if (noise) assert.ok(elapsed < 300 * tick, `the request waited ${elapsed} ms on output that keeps arriving: the cap did not close the pipes`);
      // The holder lives for 45 s: a request that waited for it would end after it was gone. (A hung build fails by the test's timeout.)
      assert.ok(holder !== undefined && alive(holder), "the request ended while the holder still held the CLI's output");
      const [pid] = await h.pids(); assert.ok(!alive(pid), "the CLI is gone");
      assert.ok(await until(async () => (await h.liveDirs()).length === 0), "and its folder");
    } finally { if (holder !== undefined) try { process.kill(holder, "SIGKILL"); } catch { /* Gone already. */ } await h.restore(); }
  });
}

function fake() {
  const stdout = new PassThrough(); const stderr = new PassThrough(); const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid: undefined, exitCode: null, signalCode: null, kill: () => true });
  return { child: child as unknown as ChildProcessWithoutNullStreams, emitter: child, stdout, stderr, stdin };
}

test("the connection's event stream ends with the CLI's failure after the grace, though its output is still open and its events were read first", { timeout: 20000 }, async () => {
  const { child, emitter, stdout, stderr, stdin } = fake(); const rpc = new CopilotRPC({}, ".", child); const limit = rpcLimits.exitGraceMs; rpcLimits.exitGraceMs = 50;
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: { sessionId: "s", event: { type: "assistant.usage" } } });
    stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    emitter.emit("exit", 0, null);
    const seen: unknown[] = []; let failure: unknown;
    try { for await (const message of rpc.notifications()) seen.push(message); } catch (error) { failure = error; }
    assert.equal(seen.length, 1, "what the CLI wrote before it left was delivered");
    assert.ok(failure instanceof ProviderError && failure.code === "cli_failed", String(failure));
    assert.ok(stdout.destroyed && stdin.destroyed && stderr.destroyed, "all three pipes were closed from this side");
  } finally { rpcLimits.exitGraceMs = limit; }
});

test("output that keeps arriving after the CLI exited is read, and the pipes are closed only after it falls silent", { timeout: 20000 }, async () => {
  const { child, emitter, stdout, stderr, stdin } = fake(); const rpc = new CopilotRPC({}, ".", child); const limit = rpcLimits.exitGraceMs; rpcLimits.exitGraceMs = 200;
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: { sessionId: "s", event: { type: "assistant.usage" } } });
    emitter.emit("exit", 0, null);
    // Ten events, 60 ms apart: 600 ms in all, three times the grace. The pipes must stay open until the last one has been read.
    let open = 0;
    for (let index = 0; index < 10; index++) { stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); if (!stdout.destroyed) open++; await new Promise(resolve => setTimeout(resolve, 60)); }
    const seen: unknown[] = []; let failure: unknown;
    try { for await (const message of rpc.notifications()) seen.push(message); } catch (error) { failure = error; }
    assert.equal(open, 10, "the output was still open for each of the ten events");
    assert.equal(seen.length, 10, "and all ten were read");
    assert.ok(failure instanceof ProviderError && failure.code === "cli_failed", String(failure));
    assert.ok(stdout.destroyed && stdin.destroyed && stderr.destroyed, "the pipes were closed once the output fell silent");
  } finally { rpcLimits.exitGraceMs = limit; }
});

// The silence rule alone would wait forever for output that never stops: a holder that writes as long as it lives keeps resetting it.
// The same timer therefore counts the ticks it has run, and closes the pipes at 100 of them however busy the output was.
test("output that keeps arriving after the CLI exited is cut short by the overall cap rather than by its silence", { timeout: 30000 }, async () => {
  const { child, emitter, stdout, stderr, stdin } = fake(); const rpc = new CopilotRPC({}, ".", child); const limit = rpcLimits.exitGraceMs; rpcLimits.exitGraceMs = 200;
  const tick = Math.max(5, Math.floor(rpcLimits.exitGraceMs / 10)); let noise: ReturnType<typeof setInterval> | undefined;
  try {
    // Node reports a child's `close` once every pipe has closed; the fake says so itself once all three have been destroyed.
    void Promise.all([stdout, stdin, stderr].map(stream => new Promise<void>(resolve => stream.once("close", () => resolve())))).then(() => emitter.emit("close", 0, null));
    // One byte every half tick: not a frame, so nothing is delivered, but steady enough that the output never counts as silent.
    emitter.once("exit", () => { noise = setInterval(() => { if (!stdout.destroyed) stdout.write("\n"); }, tick / 2).unref(); });
    const started = Date.now(); emitter.emit("exit", 0, null);
    await rpc.exited; const ticks = (Date.now() - started) / tick;
    assert.ok(ticks >= 70 && ticks < 250, `the pipes closed after ${ticks.toFixed(0)} ticks, not at the 100-tick cap`);
    assert.ok(stdout.destroyed && stdin.destroyed && stderr.destroyed, "all three pipes were closed from this side");
    let failure: unknown;
    try { for await (const message of rpc.notifications()) assert.fail(`unexpected event: ${JSON.stringify(message)}`); } catch (error) { failure = error; }
    assert.ok(failure instanceof ProviderError && failure.code === "cli_failed", String(failure));
  } finally { if (noise) clearInterval(noise); rpcLimits.exitGraceMs = limit; }
});
