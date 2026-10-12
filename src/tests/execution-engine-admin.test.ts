import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionEngine } from "../execution-host-engine.js";
import { sdkIdentity, type HostIdentity } from "../execution-host-storage.js";
import { SocketAppServerConnection } from "../socket-app-server-connection.js";
import type { GatewayConfig } from "../config.js";
import type { Message } from "../app-server-connection.js";
interface FixtureInfo extends Message { activeAdmins: number; adminInitializations: number; maxAdmins: number; adminResponses: number; winner: { name: string; error: boolean } | null; pendingProbes: number; loaded: string[] }

async function until(check: () => Promise<boolean>, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  throw new Error("Fixture state timed out");
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gw-admin-")); const nativeHome = join(root, "native"), hostHome = join(root, "host");
  await mkdir(nativeHome, { mode: 0o700 }); await mkdir(hostHome, { mode: 0o700 });
  await writeFile(join(nativeHome, "config.toml"), 'model = "native-fixture"\n', { mode: 0o600 });
  await writeFile(join(nativeHome, "auth.json"), '{"fixture":"must-not-be-copied"}', { mode: 0o600 });
  const codex = join(root, "codex.mjs");
  await writeFile(codex, `#!${process.execPath}
import {createServer} from 'node:http';
import {WebSocketServer} from ${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)};
const args=process.argv.slice(2),server=createServer(),ws=new WebSocketServer({server}),names=new Map(),loaded=new Map();
let held=false,waiters=[],winner=null,adminResponses=0,adminInitializations=0,maxAdmins=0;
const admins=()=>[...names.values()].filter(name=>name==='codex_app_server_daemon').length;
const reply=(client,id,result)=>client.send(JSON.stringify({id,result}));
const unload=id=>{if(!loaded.get(id)?.size)setTimeout(()=>{if(!loaded.get(id)?.size)loaded.delete(id)},25)};
ws.on('connection',client=>{
client.on('close',()=>{names.delete(client);waiters=waiters.filter(entry=>entry.client!==client);for(const[id,subscribers]of loaded){subscribers.delete(client);unload(id)}});
client.on('message',bytes=>{
 const m=JSON.parse(bytes);if(!m.method){if(m.id==='fixture-approval'){if(names.get(client)==='codex_app_server_daemon')adminResponses++;winner??={name:names.get(client),error:!!m.error};}return;}
 if(m.id==null)return;
 if(m.method==='initialize'){const name=m.params.clientInfo.name;names.set(client,name);if(name==='codex_app_server_daemon')adminInitializations++;maxAdmins=Math.max(maxAdmins,admins());reply(client,m.id,{});return;}
 if(m.method==='fixture/info'){reply(client,m.id,{activeAdmins:admins(),adminInitializations,maxAdmins,adminResponses,winner,pendingProbes:waiters.length,loaded:[...loaded.keys()]});return;}
 if(m.method==='fixture/hold'){held=m.params.enabled;reply(client,m.id,{});return;}
 if(m.method==='fixture/release'){held=false;for(const entry of waiters)reply(entry.client,entry.id,{data:[...loaded.keys()],nextCursor:null});waiters=[];reply(client,m.id,{});return;}
 if(m.method==='thread/loaded/list'){if(held&&names.get(client)==='codex_app_server_daemon')waiters.push({client,id:m.id});else reply(client,m.id,{data:[...loaded.keys()],nextCursor:null});return;}
 if(m.method==='thread/start'){const id=m.params.threadId;loaded.set(id,new Set(names.keys()));reply(client,m.id,{thread:{id}});if(m.params.approval)for(const receiver of names.keys())receiver.send(JSON.stringify({id:'fixture-approval',method:'item/commandExecution/requestApproval',params:{threadId:id,turnId:'fixture-turn'}}));return;}
 if(m.method==='thread/unsubscribe'){loaded.get(m.params.threadId)?.delete(client);unload(m.params.threadId);reply(client,m.id,{});return;}
 reply(client,m.id,{});
});});
server.listen(args[args.indexOf('--listen')+1].slice(7));
process.on('SIGTERM',()=>{for(const client of ws.clients)client.terminate();server.close(()=>process.exit(0))});
`, { mode: 0o700 });
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: join(root, "state"), providers: [], clientOnly: true };
  const identity: HostIdentity = { version: 1, managed: "subscription-gateway-execution-host", configPath: join(root, "gateway.json"), nativeHome,
    ...await sdkIdentity(codex), socketPath: join(hostHome, "host.sock") };
  const engine = new ExecutionEngine({ revision: "a".repeat(64), args: ["app-server"], settings: {}, catalog: { models: [{ slug: "fixture" }] }, aliases: ["fixture"] }, identity, hostHome);
  await engine.start(config, async () => {});
  const client = new SocketAppServerConnection(engine.record.socketPath, async message => {
    if (message.id === "fixture-approval") client.send({ id: message.id, result: { decision: "accept" } });
  });
  await client.ready; await client.request("initialize", { clientInfo: { name: "frontend", version: "1" } }); client.send({ method: "initialized" });
  const info = () => client.request("fixture/info", {}) as Promise<FixtureInfo>;
  return { engine, client, info, root, nativeHome, close: async () => { client.stop(); await client.exited; await engine.stop(); await rm(root, { recursive: true, force: true }); } };
}

test("transient inspection cannot win an ordinary approval delivered to its subscription", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.info()).activeAdmins, 0, "startup validation must release its subscription client");
    await f.client.request("fixture/hold", { enabled: true }); const probe = f.engine.loadedThreads();
    await until(async () => (await f.info()).pendingProbes === 1);
    await f.client.request("thread/start", { threadId: "approved", approval: true });
    await until(async () => (await f.info()).winner !== null);
    const observed = await f.info();
    assert.deepEqual(observed.winner, { name: "frontend", error: false }); assert.equal(observed.adminResponses, 0);
    await f.client.request("fixture/release", {}); assert.deepEqual([...await probe], ["approved"]);
    await until(async () => (await f.info()).activeAdmins === 0);
    await f.client.request("thread/unsubscribe", { threadId: "approved" });
    await until(async () => (await f.info()).loaded.length === 0);
    assert.deepEqual([...await f.engine.loadedThreads()], [], "the admin must not keep an idle chat loaded");
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model = "native-fixture"\n');
    assert.equal(await readFile(join(f.nativeHome, "auth.json"), "utf8"), '{"fixture":"must-not-be-copied"}');
  } finally { await f.close(); }
});

test("concurrent inspection requests share one transient connection and return after it closes", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const before = Number((await f.info()).adminInitializations);
    await f.client.request("fixture/hold", { enabled: true });
    const probes = Array.from({ length: 12 }, () => f.engine.loadedThreads());
    await until(async () => (await f.info()).pendingProbes === 1);
    const active = await f.info(); assert.equal(active.activeAdmins, 1); assert.equal(active.adminInitializations, before + 1);
    await f.client.request("fixture/release", {}); assert.ok((await Promise.all(probes)).every(threads => threads.size === 0));
    await until(async () => (await f.info()).activeAdmins === 0);
    assert.equal((await f.info()).maxAdmins, 1);
  } finally { await f.close(); }
});

test("inspection deadline releases a stalled subscription without stopping its SDK", { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.client.request("fixture/hold", { enabled: true }); const started = Date.now();
    await assert.rejects(f.engine.loadedThreads(), /inspection timed out/);
    assert.ok(Date.now() - started < 12000); assert.equal(f.engine.closed, false);
    await until(async () => (await f.info()).activeAdmins === 0);
    await f.client.request("fixture/release", {}); assert.equal((await f.engine.loadedThreads()).size, 0);
  } finally { await f.close(); }
});

test("owned SDK shutdown cancels its active probe without admitting another inspection", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await f.client.request("fixture/hold", { enabled: true });
    const result = f.engine.loadedThreads().then(value => ({ value }), error => ({ error }));
    await until(async () => (await f.info()).pendingProbes === 1);
    await f.engine.stop(); const settled = await result; assert.ok("error" in settled && settled.error); assert.equal(f.engine.closed, true);
    assert.equal((await f.engine.loadedThreads()).size, 0);
  } finally { await f.close(); }
});
