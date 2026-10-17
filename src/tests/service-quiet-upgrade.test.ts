import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerBackends } from "../app-server-backends.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import type { Message } from "../app-server-connection.js";
import { ServiceSupervisor, type NativeProbes } from "../service-supervisor.js";
import { servicePlanPath, type ServicePlan } from "../service-plan.js";
import { executionHostHome } from "../execution-host.js";
import { watchHostKick } from "../execution-host-kick.js";
import { setHostWaitForTests } from "../execution-host-client.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";
import { shortFolder } from "./short-folder.js";
import { fixtureComponent, killFixtures, killFixturesAfterTests } from "./supervisor-fixture.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.
killFixturesAfterTests();
// The test hooks for the upgrade clocks (production uses 60 s checks, a 15 min grace and 5 min of quiet).
process.env.GATEWAY_UPGRADE_CHECK_MS = "20"; process.env.GATEWAY_UPGRADE_GRACE_MS = "300"; process.env.GATEWAY_UPGRADE_QUIET_MS = "700";
const quietMs = 700;

/**
 * A stand-in SDK for both sides: over stdio it is the adapter's native engine, over a Unix socket a host's gateway engine.
 * Chats are saved under `--fixture-root`, so an engine of the next host can resume them. A turn runs for `fixtureHoldMs`
 * and then completes; its live status and newest turn answer the quiet check in the pinned SDK's v2 shapes.
 */
const sdkSource = (ws: string) => `#!${process.execPath}
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {WebSocketServer} from ${JSON.stringify(ws)};
if(process.argv.includes('--version')){console.log('codex-cli 0.162.0-alpha.17.2');process.exit(0);}
const args=process.argv.slice(2);const root=args[args.indexOf('--fixture-root')+1];const saved=root+'/threads.json';
const listen=args.includes('--listen')?args[args.indexOf('--listen')+1]:'stdio://';const live=listen.startsWith('unix://');
const loaded=new Set();const turns=new Map();const now=()=>Date.now()/1000;
const metadata=()=>existsSync(saved)?JSON.parse(readFileSync(saved,'utf8')):{};
function rpc(m,send){if(m.id==null)return;let result={};const id=m.params&&m.params.threadId;
if(m.method==='config/read')result={config:{agents:{max_concurrent_threads_per_session:30}}};
if(m.method==='thread/start'){const tid=m.params.fixtureId;const thread={id:tid,modelProvider:m.params.modelProvider||'subscription_gateway',model:m.params.model,updatedAt:now()};const all=metadata();all[tid]=thread;writeFileSync(saved,JSON.stringify(all));loaded.add(tid);result={thread,model:m.params.model,modelProvider:thread.modelProvider,executorPid:process.pid};}
if(m.method==='thread/resume'){const thread=metadata()[id];if(!thread){send({id:m.id,error:{code:-32600,message:'Unknown fixture thread'}});return;}loaded.add(id);result={thread,model:thread.model,modelProvider:thread.modelProvider,executorPid:process.pid};}
if(m.method==='thread/unsubscribe')loaded.delete(id);
if(m.method==='thread/loaded/list')result={data:[...loaded],nextCursor:null};
if(m.method==='thread/read'){const thread=metadata()[id];const turn=turns.get(id);result={executorPid:process.pid,thread:thread?{...thread,status:live&&loaded.has(id)?(turn&&turn.status==='inProgress'?{type:'active',activeFlags:[]}:{type:'idle'}):{type:'notLoaded'}}:{id,modelProvider:'openai'}};}
if(m.method==='thread/backgroundTerminals/list')result={data:[],nextCursor:null};
if(m.method==='thread/turns/list'){const turn=turns.get(id);result={data:turn?[turn]:[],nextCursor:null,backwardsCursor:null};}
if(m.method==='turn/start'){const turn={id:'turn-'+process.pid+'-'+Date.now(),rootTurnId:null,items:[],itemsView:'notLoaded',status:'inProgress',error:null,startedAt:now(),completedAt:null,durationMs:null};turns.set(id,turn);
send({id:m.id,result:{turn}});send({method:'turn/started',params:{threadId:id,turn}});
setTimeout(()=>{turn.status='completed';turn.completedAt=now();send({method:'turn/completed',params:{threadId:id,turn}});},m.params.fixtureHoldMs||0);return;}
send({id:m.id,result});}
if(live){const socket=listen.slice(7);const server=createServer();const wss=new WebSocketServer({server});
wss.on('connection',client=>client.on('message',bytes=>rpc(JSON.parse(bytes),m=>{if(client.readyState===1)client.send(JSON.stringify(m));})));
server.listen(socket,()=>chmodSync(socket,0o600));
process.on('SIGTERM',()=>{for(const c of wss.clients)c.terminate();server.close(()=>process.exit(0));});}
else createInterface({input:process.stdin}).on('line',line=>rpc(JSON.parse(line),m=>process.stdout.write(JSON.stringify(m)+'\\n')));
`;

const alias = "claude/fixture";
const unregistered: NativeProbes = { registered: async () => false, fingerprint: async () => "same", appRunning: async () => false };

test("a quiet upgrade waits out a running turn and the quiet time, then the adapter finds the new host and the chat runs a follow-up turn", { timeout: 60000 }, async () => {
  const made = await shortFolder("gwq-"); const directory = made.directory;
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  await writeFile(join(nativeHome, "config.toml"), 'model = "native-original"\n', { mode: 0o600 });
  const sdk = join(directory, "codex"); await writeFile(sdk, sdkSource(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href), { mode: 0o700 });
  const configPath = join(directory, "gateway.json");
  const config: GatewayConfig = { version: 1, port: 3461, clientOnly: true, stateDirectory: directory, providers: [] };
  await writePrivateJson(configPath, config); configureTelemetry(directory, "test");
  // The service: inference that accepts its idle guard, and a relay slot naming the SDK and native home (paused: unregistered).
  const inference = fixtureComponent(directory, "inference", "inference", "process.on('SIGUSR2',()=>process.exit(0)); setInterval(()=>{},1000)");
  const relay = fixtureComponent(directory, "native", "native", "setInterval(()=>{},1000)");
  relay.args.push("--", "--daemon", "--codex", sdk, "--native-home", nativeHome, "--relay-home", join(directory, "relay-home"));
  const plan: ServicePlan = { version: 1, config: configPath, sharedExecutors: true, components: [inference, relay] };
  await writePrivateJson(servicePlanPath(directory), plan); // The adapter reads it: gateway chats then require the shared host.
  const release = { running: "0.4.4", installed: "0.4.4" };
  const supervisor = (running: string) => new ServiceSupervisor(plan, directory, 5, undefined, unregistered, undefined, undefined,
    { watchKick: () => () => {}, hostProbeMs: 3_600_000, healthSchedule: () => () => {}, releaseState: () => ({ ...release, running }) });
  const previousHome = process.env.CODEX_HOME; process.env.CODEX_HOME = nativeHome;
  const old = supervisor("0.4.4"); let replacement: ServiceSupervisor | undefined; let adapter: AppServerBackends | undefined; let stopKickWatch = () => {};
  try {
    await old.start();
    const snapshot = () => ({ revision: "1".repeat(64), models: [{ slug: alias, display_name: "Fixture" }] });
    const catalog = { current: snapshot, refresh: async () => snapshot(), combined: (value: ReturnType<typeof snapshot>) => ({ models: value.models }) } as unknown as DesktopCatalog;
    const events: Message[] = [];
    adapter = await AppServerBackends.create(sdk, ["app-server", "--listen", "stdio://", "--fixture-root", directory], config,
      { agents: { max_concurrent_threads_per_session: 30 }, web_search: "disabled", sandbox_mode: "read-only" }, {}, catalog, async message => { events.push(message); }, () => {}, configPath);
    await adapter.request("initialize", { clientInfo: { name: "fixture", version: "1" }, capabilities: { experimentalApi: true } }); adapter.notify({ method: "initialized" });
    const completed = (turnId: string) => events.some(message => message.method === "turn/completed" && (message.params as Message)?.turn && ((message.params as Message).turn as Message).id === turnId && ((message.params as Message).turn as Message).status === "completed");

    // The adapter holds a lease and a loaded chat for the whole upgrade, as a remote app that stays connected for days does.
    const threadId = "quiet-upgrade-chat";
    const started = await adapter.request("thread/start", { fixtureId: threadId, model: alias, modelProvider: "subscription_gateway" }, { engine: "gateway" });
    const turn = ((await adapter.request("turn/start", { threadId, input: [], fixtureHoldMs: 1500 })).turn as Message).id as string;
    release.installed = "0.4.5"; // Installed while that turn runs: the grace ends before it does.
    await delay(1200);
    assert.equal((old as unknown as { stopping: boolean }).stopping, false, "never during a running turn, even past the grace");
    for (let attempt = 0; attempt < 500 && !completed(turn); attempt++) await delay(10);
    assert.ok(completed(turn), "the turn completed on the old host");
    const endedAtMs = 1000 * Number(((events.find(message => message.method === "turn/completed")!.params as Message).turn as Message).completedAt);

    // The old host goes away once quiet; the adapter's next request kicks the service, which launchd would start again.
    const hostHome = executionHostHome(configPath, nativeHome);
    stopKickWatch = watchHostKick(hostHome, () => { if (!replacement) { replacement = supervisor("0.4.5"); void replacement.start(); } }, { intervalMs: 50, minimumGapMs: 0 });
    await old.stopped;
    assert.ok(Date.now() - endedAtMs >= quietMs, "the service waited for the quiet time after the turn ended");
    for (let attempt = 0; attempt < 200 && !(await upgrades()).length; attempt++) await delay(10);
    const [upgrade] = await upgrades();
    assert.equal(upgrade?.mode, "quiet"); assert.equal(upgrade?.loadedChats, 1); assert.equal(upgrade?.to, "0.4.5");

    setHostWaitForTests(15_000); // The adapter waits for the next host as it would in production (20 s).
    const resumed = await adapter.request("thread/resume", { threadId });
    assert.equal((resumed.thread as Message).id, threadId, "the chat resumed on the new host");
    assert.notEqual(resumed.executorPid, started.executorPid, "in an engine of the new host");
    assert.ok(replacement, "the new host started on the adapter's kick");
    const follow = ((await adapter.request("turn/start", { threadId, input: [] })).turn as Message).id as string;
    for (let attempt = 0; attempt < 500 && !completed(follow); attempt++) await delay(10);
    assert.ok(completed(follow), "a follow-up turn completed");
    assert.notEqual(follow, turn);
  } finally {
    stopKickWatch(); await adapter?.stop(); await old.stop(); await replacement?.stop();
    process.env.CODEX_HOME = previousHome; if (previousHome === undefined) delete process.env.CODEX_HOME;
    await flushTelemetry(); await killFixtures(directory); await made.remove();
  }
  async function upgrades() { await flushTelemetry(); return (await readTelemetry(directory, Date.now() - 600_000)).filter(event => event.event === "self_upgrade"); }
});
