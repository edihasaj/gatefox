import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CopilotRPC } from "../providers/copilot-rpc.js";
import { sleep, until } from "./copilot-live-harness.js";

// A connection that fails (an event backlog, an invalid frame) may belong to a session that holds a tool request. Ending it
// gracefully lets the runtime fail that request and make a model call of its own, so it ends with SIGKILL and never SIGTERM.
function fake() {
  const signals: Array<string | number | undefined> = []; const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), stdin: new PassThrough(), pid: undefined, exitCode: null, signalCode: null,
    kill: (signal?: string | number) => { signals.push(signal); return true; } });
  return { child: child as unknown as ChildProcessWithoutNullStreams, stdout, signals };
}
const frame = (value: unknown) => { const body = JSON.stringify(value); return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`; };

test("a connection that receives an invalid frame ends its CLI with SIGKILL only", { timeout: 10000 }, async () => {
  const { child, stdout, signals } = fake(); const rpc = new CopilotRPC({}, ".", child);
  stdout.write("Content-Length: 5\r\n\r\nnope!");
  assert.ok(await until(() => rpc.closed), "the connection is over");
  await assert.rejects(async () => { for await (const event of rpc.notifications()) void event; }, /invalid JSON/);
  await sleep(1700);
  assert.deepEqual(signals, ["SIGKILL"], "no SIGTERM, not even one followed by a SIGKILL");
});

test("a connection whose event backlog overflows ends its CLI with SIGKILL only", { timeout: 10000 }, async () => {
  const { child, stdout, signals } = fake(); const rpc = new CopilotRPC({}, ".", child);
  // Nobody reads the events, so the queue passes its 256-event bound.
  for (let index = 0; index < 400; index++) stdout.write(frame({ jsonrpc: "2.0", method: "session.event", params: { sessionId: "s", event: { type: "session.info" } } }));
  assert.ok(await until(() => rpc.closed), "the connection is over");
  await sleep(1700);
  assert.deepEqual(signals, ["SIGKILL"]);
});
