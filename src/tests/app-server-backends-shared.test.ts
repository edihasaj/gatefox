import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { AppServerBackends } from "../app-server-backends.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { startExecutionHost, executionHostHome } from "../execution-host.js";
import { SocketAppServerConnection } from "../socket-app-server-connection.js";
import type { Message } from "../app-server-connection.js";
import type { GatewayConfig } from "../config.js";

const alias = "claude/fixture";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gw-backends-"));
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  await writeFile(join(nativeHome, "config.toml"), 'model = "native-original"\n', { mode: 0o600 });
  const sdk = join(directory, "codex");
  await writeFile(sdk, `#!${process.execPath}
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {WebSocketServer} from ${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)};
if(process.argv.includes('--version')){console.log('codex-cli 0.162.0-alpha.17.2');process.exit(0);}
const args=process.argv.slice(2);const root=args[args.indexOf('--fixture-root')+1];const saved=root+'/threads.json';const loaded=new Set();
function metadata(){return existsSync(saved)?JSON.parse(readFileSync(saved,'utf8')):{};}
async function rpc(m,send,drop){if(m.id==null)return;let result={};
if(m.method==='config/read')result={config:{agents:{max_concurrent_threads_per_session:30}}};
if(m.method==='thread/read')result={thread:metadata()[m.params.threadId]||{id:m.params.threadId,modelProvider:'openai'}};
if(m.method==='thread/loaded/list')result={data:[...loaded],nextCursor:null};
if(m.method==='thread/start'){
if(m.params.delayMs)await new Promise(r=>setTimeout(r,m.params.delayMs));
const id=m.params.fixtureId;const thread={id,modelProvider:'subscription_gateway',model:m.params.model};
const all=metadata();all[id]=thread;writeFileSync(saved,JSON.stringify(all));loaded.add(id);result={thread,model:m.params.model,modelProvider:'subscription_gateway',executorPid:process.pid};
}
if(m.method==='thread/resume'){const thread=metadata()[m.params.threadId];if(!thread){send({id:m.id,error:{code:-32600,message:'Unknown fixture thread'}});return;}loaded.add(thread.id);result={thread,model:thread.model,modelProvider:'subscription_gateway',executorPid:process.pid};}
if(m.method==='thread/unsubscribe')loaded.delete(m.params.threadId);
if(m.method==='fixture/disconnect'){drop();return;}
send({id:m.id,result});}
const listen=args.includes('--listen')?args[args.indexOf('--listen')+1]:'stdio://';
if(listen.startsWith('unix://')){
const socket=listen.slice(7);const server=createServer();const ws=new WebSocketServer({server});
ws.on('connection',client=>client.on('message',bytes=>{void rpc(JSON.parse(bytes),m=>client.send(JSON.stringify(m)),()=>client.close(1000));}));
server.listen(socket,()=>chmodSync(socket,0o600));
process.on('SIGTERM',()=>{for(const c of ws.clients)c.terminate();server.close(()=>process.exit(0));});
}else{createInterface({input:process.stdin}).on('line',line=>{void rpc(JSON.parse(line),m=>process.stdout.write(JSON.stringify(m)+'\\n'),()=>process.exit(0));});}
`, { mode: 0o700 });
  const configPath = join(directory, "gateway.json");
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: join(directory, "state"), providers: [], clientOnly: true };
  const previousHome = process.env.CODEX_HOME; process.env.CODEX_HOME = nativeHome;
  const host = await startExecutionHost({ config, configPath, nativeHome, codex: sdk });
  const control = new SocketAppServerConnection(join(executionHostHome(configPath, nativeHome), "host.sock"), async () => {}); await control.ready;
  let generation = 0;
  const snapshot = () => ({ revision: String(generation).repeat(64), models: [{ slug: alias, display_name: "Fixture " + generation }] });
  const catalog = { current: snapshot, refresh: async () => snapshot(), combined: (value: ReturnType<typeof snapshot>) => ({ models: value.models }) } as unknown as DesktopCatalog;
  const events: Message[] = [];
  const adapters = new Set<AppServerBackends>();
  const createBackend = (reverse = false) => {
    const entries: [string, unknown][] = [["agents", { max_concurrent_threads_per_session: 30 }], ["web_search", "disabled"], ["sandbox_mode", "read-only"]];
    const settings = Object.fromEntries(reverse ? entries.reverse() : entries);
    const adapter = new AppServerBackends(sdk, ["app-server", "--listen", "stdio://", "--fixture-root", directory], config, settings, {}, catalog, async message => { events.push(message); }, () => {}, configPath);
    adapters.add(adapter); return adapter;
  };
  const backends = createBackend();
  await backends.request("initialize", { clientInfo: { name: "fixture", version: "1" }, capabilities: { experimentalApi: true } }); backends.notify({ method: "initialized" });
  return { config, directory, nativeHome, backends, control, events, next: () => { generation++; },
    async another() { const adapter = createBackend(true); await adapter.request("initialize", { clientInfo: { name: "second-fixture", version: "1" }, capabilities: { experimentalApi: true } }); adapter.notify({ method: "initialized" }); return adapter; },
    start: (id: string, delayMs = 0) => backends.request("thread/start", { fixtureId: id, delayMs, model: alias, modelProvider: "subscription_gateway" }),
    async clean() { await Promise.all([...adapters].map(adapter => adapter.stop())); control.stop(); await control.exited; await host.close(); process.env.CODEX_HOME = previousHome; if (previousHome === undefined) delete process.env.CODEX_HOME; await rm(directory, { recursive: true, force: true }); await rm(executionHostHome(configPath, nativeHome), { recursive: true, force: true }); },
  };
}

test("adapter releases a closed chat's generation before acquiring a fifth catalog", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 4; index++) { await f.start("chat-" + index); f.next(); }
    await assert.rejects(f.start("chat-4"), /Four gateway generations/);
    await f.backends.request("thread/unsubscribe", { threadId: "chat-0" });
    assert.equal(((await f.start("chat-4")).thread as Message).id, "chat-4");
    const status = await f.control.request("execution/status", {}); assert.equal((status.generations as unknown[]).length, 4);
    assert.deepEqual(await f.control.request("execution/find", { threadId: "chat-0" }), { found: false });
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model = "native-original"\n');
  } finally { await f.clean(); }
});

test("independent adapters share one writer despite different native settings key order", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const second = await f.another();
    const firstStart = await f.start("first-adapter");
    const secondStart = await second.request("thread/start", { fixtureId: "second-adapter", model: alias, modelProvider: "subscription_gateway" });
    assert.equal(secondStart.executorPid, firstStart.executorPid);
    const status = await f.control.request("execution/status", {}); assert.equal((status.generations as Message[]).length, 1);
    assert.equal((await f.control.request("execution/find", { threadId: "first-adapter" })).revision, (await f.control.request("execution/find", { threadId: "second-adapter" })).revision);
  } finally { await f.clean(); }
});

test("parallel starts survive catalog changes before their first SDK response", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const older = f.start("delayed-chat", 100); f.next(); const newer = f.start("newer-chat", 10);
    const results = await Promise.all([older, newer]); assert.deepEqual(results.map(value => (value.thread as Message).id), ["delayed-chat", "newer-chat"]);
    assert.notEqual((await f.control.request("execution/find", { threadId: "delayed-chat" })).revision, (await f.control.request("execution/find", { threadId: "newer-chat" })).revision);
  } finally { await f.clean(); }
});

test("SDK client disconnect resumes through the same live writer and retains its new lease", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const started = await f.start("reconnect-chat"); const original = await f.control.request("execution/find", { threadId: "reconnect-chat" });
    await assert.rejects(f.backends.request("fixture/disconnect", { threadId: "reconnect-chat" }), /socket closed/);
    const resumed = await f.backends.request("thread/resume", { threadId: "reconnect-chat", model: alias });
    assert.equal(resumed.executorPid, started.executorPid); assert.equal((resumed.thread as Message).id, "reconnect-chat");
    assert.equal((await f.control.request("execution/find", { threadId: "reconnect-chat" })).revision, original.revision);
    await f.backends.request("thread/unsubscribe", { threadId: "reconnect-chat" });
    // Reacquired same-generation connection must retain its lease even while empty.
    const descriptor = (digit: string) => ({ revision: digit.repeat(64), args: ["app-server", "--fixture-root", f.directory], settings: {}, catalog: { models: [{ slug: alias }] }, aliases: [alias] });
    for (const digit of ["a", "b", "c"]) await f.control.request("execution/acquire", descriptor(digit));
    await assert.rejects(f.control.request("execution/acquire", descriptor("d")), /Four gateway generations/);
    const status = await f.control.request("execution/status", {});
    assert.equal((status.generations as Message[]).filter(value => value.revision === original.revision).length, 1);
    assert.equal((status.generations as Message[]).length, 4);
  } finally { await f.clean(); }
});
