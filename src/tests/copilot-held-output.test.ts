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
// the request open for as long as it lived. The connection now closes its pipes `rpcLimits.exitGraceMs` after the CLI exited.

for (const mode of ["oneshot", "live"] as const) {
  test(`a cancelled ${mode} request ends though a process outside the CLI's group still holds the CLI's output open`, { skip: process.platform === "win32", timeout: 60000 }, async () => {
    const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_HOLD_STDOUT = "45000";
    let holder: number | undefined;
    try {
      const controller = new AbortController(); let failure: unknown;
      const input = restoreReasoning({ model: "fixture", input: [user("go [stall]")], tools } as ResponsesRequest, "scope");
      try { for await (const event of adapter({ mode }).infer(input, controller.signal, thread)) if (event.type === "text") controller.abort(); } catch (error) { failure = error; }
      holder = (await h.log()).find(entry => entry.op === "holder")?.holder;
      assert.ok(failure instanceof ProviderError && failure.code === "cancelled", String(failure));
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
