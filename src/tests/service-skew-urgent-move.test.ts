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
import { startExecutionHost } from "../execution-host.js";
import { isReleaseSkew } from "../execution-host-engine.js";
import type { GatewaySdkRuntime } from "../gateway-sdk-runtime.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";
import { shortFolder } from "./short-folder.js";
import { fixtureComponent, killFixtures, killFixturesAfterTests } from "./supervisor-fixture.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.
killFixturesAfterTests();
// Neither supervisor tick can act inside this test (production: 60 s and 10 s), and the quiet rule's grace is far off:
// only the host's no-turn-running signal can move the service. The host looks every 10 ms (production: once a second).
process.env.GATEWAY_UPGRADE_CHECK_MS = "60000"; process.env.GATEWAY_UPGRADE_URGENT_MS = "60000"; process.env.GATEWAY_SKEW_WATCH_MS = "10";
process.env.GATEWAY_UPGRADE_GRACE_MS = "3600000"; process.env.GATEWAY_UPGRADE_QUIET_MS = "300000";

/** A stand-in SDK for both sides, as in service-quiet-upgrade.test.ts: a turn runs for `fixtureHoldMs` and then completes. */
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

test("turns that run back to back with 50 ms gaps still let the urgent move happen, within a gap", { timeout: 60000 }, async () => {
  const made = await shortFolder("gwk-"); const directory = made.directory;
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  await writeFile(join(nativeHome, "config.toml"), 'model = "native-original"\n', { mode: 0o600 });
  const sdk = join(directory, "codex"); await writeFile(sdk, sdkSource(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href), { mode: 0o700 });
  const configPath = join(directory, "gateway.json");
  const config: GatewayConfig = { version: 1, port: 3461, stateDirectory: directory, providers: [], clientOnly: true };
  await writePrivateJson(configPath, config); configureTelemetry(directory, "test");
  const inference = fixtureComponent(directory, "inference", "inference", "process.on('SIGUSR2',()=>process.exit(0)); setInterval(()=>{},1000)");
  const relay = fixtureComponent(directory, "native", "native", "setInterval(()=>{},1000)");
  relay.args.push("--", "--daemon", "--codex", sdk, "--native-home", nativeHome, "--relay-home", join(directory, "relay-home"));
  const plan: ServicePlan = { version: 1, config: configPath, sharedExecutors: true, components: [inference, relay] };
  await writePrivateJson(servicePlanPath(directory), plan);
  // This release's gateway SDK is "a"; the installed release 0.4.5 carries "b".
  const runtime = (digit: string): GatewaySdkRuntime => ({ executable: sdk, binarySha256: digit.repeat(64), selectedModelCompaction: true, executorIdentity: true });
  const startHost: typeof startExecutionHost = options => startExecutionHost({ ...options, gatewayRuntime: async () => runtime("a"), pendingRelease: async () => ({ release: "0.4.5", gatewaySdkSha256: "b".repeat(64) }) });
  const service = new ServiceSupervisor(plan, directory, 5, startHost, unregistered, undefined, undefined,
    { watchKick: () => () => {}, hostProbeMs: 3_600_000, healthSchedule: () => () => {}, releaseState: () => ({ running: "0.4.4", installed: "0.4.5" }) });
  const previousHome = process.env.CODEX_HOME; process.env.CODEX_HOME = nativeHome;
  const adapters: AppServerBackends[] = []; let looping = true; let loop: Promise<void> | undefined;
  try {
    await service.start();
    const snapshot = () => ({ revision: "1".repeat(64), models: [{ slug: alias, display_name: "Fixture" }] });
    const catalog = { current: snapshot, refresh: async () => snapshot(), combined: (value: ReturnType<typeof snapshot>) => ({ models: value.models }) } as unknown as DesktopCatalog;
    const events: Message[] = [];
    const adapter = async (digit: string) => {
      const value = await AppServerBackends.create(sdk, ["app-server", "--listen", "stdio://", "--fixture-root", directory], config,
        { agents: { max_concurrent_threads_per_session: 30 }, web_search: "disabled", sandbox_mode: "read-only" }, {}, catalog, async message => { events.push(message); }, () => {}, configPath);
      value.resolveRuntime = async () => runtime(digit); adapters.push(value);
      await value.request("initialize", { clientInfo: { name: "fixture", version: "1" }, capabilities: { experimentalApi: true } }); value.notify({ method: "initialized" });
      return value;
    };
    const current = await adapter("a"); const newer = await adapter("b");
    const threadId = "back-to-back";
    await current.request("thread/start", { fixtureId: threadId, model: alias, modelProvider: "subscription_gateway" }, { engine: "gateway" });
    const completed = (turnId: string) => events.some(message => message.method === "turn/completed" && ((message.params as Message)?.turn as Message)?.id === turnId);
    let finished = 0;
    // An agent that starts its next turn 50 ms after the last one ended, for as long as the host lets it.
    loop = (async () => {
      while (looping) {
        const turnId = ((await current.request("turn/start", { threadId, input: [], fixtureHoldMs: 150 })).turn as Message).id as string;
        while (looping && !completed(turnId)) await delay(5);
        if (completed(turnId)) finished++;
        await delay(50);
      }
    })().catch(() => undefined);
    while (!finished) await delay(10); // At least one whole turn ran before the refusal.
    // The adapter of the installed release is refused while turns are running; that is what makes the move urgent.
    await assert.rejects(newer.request("thread/start", { fixtureId: "refused", model: alias, modelProvider: "subscription_gateway" }, { engine: "gateway" }), error => isReleaseSkew(error));
    const refusedAt = performance.now();
    await Promise.race([service.stopped, delay(8000).then(() => assert.fail("the service never moved while turns ran back to back"))]);
    assert.ok(performance.now() - refusedAt < 8000);
    const upgrades = async () => { await flushTelemetry(); return (await readTelemetry(directory, Date.now() - 600_000)).filter(event => event.event === "self_upgrade"); };
    for (let attempt = 0; attempt < 200 && !(await upgrades()).length; attempt++) await delay(10);
    const [upgrade] = await upgrades();
    assert.deepEqual({ mode: upgrade?.mode, from: upgrade?.from, to: upgrade?.to }, { mode: "skew", from: "0.4.4", to: "0.4.5" });
    assert.ok(finished >= 1, "turns completed before the move");
  } finally {
    looping = false; await loop;
    for (const value of adapters) await value.stop();
    await service.stop();
    process.env.CODEX_HOME = previousHome; if (previousHome === undefined) delete process.env.CODEX_HOME;
    await flushTelemetry(); await killFixtures(directory); await made.remove();
  }
});
