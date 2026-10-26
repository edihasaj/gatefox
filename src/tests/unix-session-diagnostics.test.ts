import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { serveUnix } from "../unix-transport.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { shortFolder } from "./short-folder.js";

test("Unix disconnect diagnostics distinguish local ends from transport closure without recording close reasons or errors", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  for (const cause of ["transport_closed", "session_failed", "session_ended", "listener_shutdown"] as const) {
    const folder = await shortFolder("gw-close-"); const path = join(folder.directory, "rpc.sock");
    configureTelemetry(folder.directory, "adapter");
    const controller = new AbortController(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const serving = serveUnix(path, controller.signal, async input => {
      if (cause === "session_failed" || cause === "session_ended") {
        await gate; if (cause === "session_failed") throw Error("private-error-must-not-appear");
      } else { for await (const _chunk of input) { /* No fixture content is logged. */ } }
    });
    let ws: WebSocket | undefined;
    try {
      for (let i = 0; i < 200 && !await lstat(path).then(() => true, () => false); i++) await delay(10);
      ws = new WebSocket(`ws+unix://${path}:/rpc`); await once(ws, "open");
      const closed = once(ws, "close");
      if (cause === "transport_closed") ws.close(1000, "private-close-reason-must-not-appear");
      else if (cause === "listener_shutdown") controller.abort();
      else release();
      await closed; await flushTelemetry();
      const events = (await readTelemetry(folder.directory, Date.now() - 60_000)).filter(row => row.event === "unix_session_end");
      assert.equal(events.length, 1); assert.equal(events[0].cause, cause); assert.equal(events[0].sessionId, 1);
      assert.equal(typeof events[0].closeCode, "number"); assert.ok(Number(events[0].durationMs) >= 0);
      assert.deepEqual(Object.keys(events[0]).sort(), ["at", "cause", "closeCode", "component", "durationMs", "event", "host", "pid", "sessionId"]);
      assert.doesNotMatch(JSON.stringify(events), /private-error|private-close-reason|rpc\.sock/);
    } finally { release(); ws?.terminate(); controller.abort(); await serving; await folder.remove(); }
  }
});
