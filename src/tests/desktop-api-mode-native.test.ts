import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import test from "node:test";
import { openNativeConfig } from "../desktop-api-mode-native.js";

type FakeTimer = { callback: () => void; cleared: boolean; unref(): FakeTimer };

/** A stdio-only engine fixture: it answers initialize immediately and leaves config/read for the test to finish. */
class FakeEngine extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); reads: (() => void)[] = []; kills = 0;
  constructor() {
    super();
    this.stdin.on("data", value => {
      const message = JSON.parse(value.toString()) as { id?: number; method?: string };
      if (message.method === "initialize") this.answer(message.id!, { result: {} });
      if (message.method === "config/read") this.reads.push(() => this.answer(message.id!, { result: { layers: [{ name: { type: "user", file: "" }, version: "v1", config: {} }] } }));
    });
  }
  answer(id: number, value: object): void { this.stdout.write(JSON.stringify({ id, ...value }) + "\n"); }
  kill(): boolean { this.kills++; this.emit("close", 0, null); return true; }
}

test("settled calls clear their timer, and close resolves after an already-exited engine", async () => {
  const engine = new FakeEngine(); const timers: FakeTimer[] = [];
  const client = await openNativeConfig("fixture", "/tmp/hg-api-mode-native", {
    spawn: (() => engine) as unknown as typeof import("node:child_process").spawn,
    setTimeout: callback => { const timer: FakeTimer = { callback, cleared: false, unref: () => timer }; timers.push(timer); return timer as unknown as NodeJS.Timeout; },
    clearTimeout: timeout => { const timer = timeout as unknown as FakeTimer | undefined; if (timer) timer.cleared = true; },
  });
  const initializeTimer = timers[0]!;
  assert.equal(initializeTimer.cleared, true, "the completed initialize request retires its timeout");
  const read = client.read(); const readTimer = timers[1]!;
  if (!initializeTimer.cleared) initializeTimer.callback();
  engine.reads.shift()!();
  await read;
  assert.equal(readTimer.cleared, true, "a completed later request retires its own timeout too");
  engine.emit("close", 0, null);
  await Promise.race([client.close(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("close hung after engine exit")), 100))]);
});
