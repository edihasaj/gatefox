import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { setTimeout as delay } from "node:timers/promises";
import { NativeControl } from "../native-control.js";

test("native control forwards real status and reconnects after the relay restarts", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const home = await mkdtemp("/tmp/gw-native-control-"); await mkdir(join(home, "app-server-control"));
  const path = join(home, "app-server-control/app-server-control.sock");
  const events: Record<string, unknown>[] = []; let generation = 0;
  async function open() {
    const server = createServer(); const ws = new WebSocketServer({ server }); const current = ++generation;
    ws.on("connection", client => {
      client.send(JSON.stringify({ method: "remoteControl/status/changed", params: { status: "connected", environmentId: "original-machine", generation: current } }));
      client.on("message", data => {
        const request = JSON.parse(data.toString());
        client.send(JSON.stringify({ id: request.id, result: { status: "connected", environmentId: "original-machine", generation: current, echoed: request.params } }));
      });
    });
    server.listen(path); await once(server, "listening");
    return async () => { for (const client of ws.clients) client.terminate(); await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); };
  }
  let stop = await open(); const control = new NativeControl(home, async event => { events.push(event); });
  try {
    const first = await control.request("remoteControl/status/read", { opaque: "preserved" });
    assert.equal(first.environmentId, "original-machine"); assert.deepEqual(first.echoed, { opaque: "preserved" });
    await stop(); stop = await open();
    let next: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      await delay(100); try { next = await control.request("remoteControl/status/read", {}); if (next.generation === 2) break; } catch { /* waiting for the owned relay */ }
    }
    assert.equal(next?.generation, 2); assert.ok(events.some(event => (event.params as Record<string, unknown>).generation === 2));
  } finally { control.close(); await stop(); }
});
