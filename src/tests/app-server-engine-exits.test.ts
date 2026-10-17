// Why an owned engine process that the adapter spawned stopped. The fixture spawns real children
// only: no gateway HTTP and no execution host, so it runs anywhere the build runs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerBackends } from "../app-server-backends.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import type { GatewayConfig } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { Message } from "../app-server-connection.js";

async function fixture(refuseGatewayInitialize: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "gw-engine-exits-"));
  const state = join(directory, "state"); const nativeHome = join(directory, "native");
  await mkdir(state, { mode: 0o700 }); await mkdir(nativeHome, { mode: 0o700 });
  const sdk = join(directory, "codex");
  // A gateway generation is the one spawned with its own pinned catalog file, so it can refuse its own initialize.
  await writeFile(sdk, `#!${process.execPath}
const {createInterface}=require('node:readline');
const gateway=${String(refuseGatewayInitialize)}&&process.argv.some(a=>a.includes('model_catalog_json'));
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id==null)return;
 if(gateway&&m.method==='initialize')send({id:m.id,error:{code:-32600,message:'fixture refuses initialize'}});
 else send({id:m.id,result:m.method==='config/read'?{config:{}}:{}});
});
`, { mode: 0o700 });
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: state, providers: [], clientOnly: true };
  configureTelemetry(state, "test");
  const snapshot = () => ({ revision: "f".repeat(64), models: [{ slug: "gateway/model", context_window: 200000, effective_context_window_percent: 90 }], path: join(directory, "desktop.json") });
  const catalog = { current: snapshot, refresh: async () => snapshot(), combined: (value: ReturnType<typeof snapshot>) => ({ models: value.models }) } as unknown as DesktopCatalog;
  const events: Message[] = [];
  const priorHome = process.env.CODEX_HOME; process.env.CODEX_HOME = nativeHome;
  const backend = new AppServerBackends(sdk, ["app-server", "--listen", "stdio://"], config, {}, {}, catalog, async message => { events.push(message); }, () => {});
  await backend.request("initialize", { clientInfo: { name: "engine-exits-fixture", version: "1" } });
  return { backend, directory, state, events,
    async exits(engine: string) { await flushTelemetry(); return (await readTelemetry(state, Date.now() - 60_000)).filter(event => event.event === "engine_exit" && event.engine === engine); },
    async clean() { await backend.stop(); if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome; await rm(directory, { recursive: true, force: true }); } };
}

test("a gateway engine that never finished initializing is stopped as spawn_error, not as a replacement", { timeout: 20000 }, async () => {
  const f = await fixture(true);
  try {
    await assert.rejects(() => f.backend.request("thread/start", { model: "gateway/model", modelProvider: "subscription_gateway" }, { engine: "gateway" }));
    await delay(50); // Its process dies from the stop the adapter started, so give the close a beat.
    const exits = await f.exits("gateway");
    assert.deepEqual(exits.map(event => [event.initiatedBy, event.reason]), [["adapter", "spawn_error"]]); // One record, and not "replaced".
    assert.equal((await f.exits("native")).length, 0); // The native chat engine is untouched by its gateway's failure.
  } finally { await f.clean(); }
});

