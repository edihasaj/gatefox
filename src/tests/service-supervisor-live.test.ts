import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { ServiceSupervisor, type SupervisorHealing, type NativeProbes } from "../service-supervisor.js";
import { writePrivateJson } from "../config.js";
import type { ServicePlan } from "../service-plan.js";
import { fixtureComponent, killFixtures, killFixturesAfterTests } from "./supervisor-fixture.js";
import { shortFolder } from "./short-folder.js";

import { isolateExecutionRoots } from "./isolated-execution-roots.js";
isolateExecutionRoots();
killFixturesAfterTests();
const unregistered: NativeProbes = { registered: async () => false, fingerprint: async () => "same", appRunning: async () => true };
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let n = 0; n < 500; n++) { if (await check()) return; await delay(10); }
  assert.fail("fixture did not settle");
}
async function setup() {
  const made = await shortFolder("gwl-"); const root = made.directory; const config = join(root, "gateway.json");
  await writePrivateJson(config, { version: 1, port: 3459, clientOnly: true, stateDirectory: root, providers: [] });
  const state = () => readFile(join(root, "service-status.json"), "utf8").then(JSON.parse) as Promise<{ components: Array<{ id: string; pid?: number; restarts: number; state: string }>; runningRelease?: string; controllerRelease?: string }>;
  const cleanup = async () => { await killFixtures(root); await made.remove(); };
  return { root, config, state, cleanup };
}
function healing(release: string, schedules: { active: number; maximum: number }, fail = false): Partial<SupervisorHealing> {
  return { releaseState: () => ({ running: release, installed: release }), watchKick: () => () => {}, hostProbeMs: 3_600_000, kickGapMs: 0,
    healthSchedule: () => { if (fail) throw Error("candidate activation"); schedules.active++; schedules.maximum = Math.max(schedules.maximum, schedules.active); let stopped = false; return () => { if (!stopped) { stopped = true; schedules.active--; } }; } };
}

test("live controller handover preserves a busy Claude stream, tunnel socket, host and child handles across repeated updates", { timeout: 30000 }, async () => {
  const f = await setup(); const schedules = { active: 0, maximum: 0 }; let hostCloses = 0; let hostGuards = 0;
  const stream = fixtureComponent(f.root, "claude-adapter", "claude-adapter", `require('node:http').createServer((req,res)=>{res.writeHead(200);res.write('before');const t=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(join(f.root, "finish"))})){clearInterval(t);res.end('after')}},10)}).listen(0,'127.0.0.1',function(){require('node:fs').writeFileSync(${JSON.stringify(join(f.root,"http-port"))},String(this.address().port))})`);
  const tunnel = fixtureComponent(f.root, "claude-inference-tunnel", "tunnel", `require('node:net').createServer(s=>s.pipe(s)).listen(0,'127.0.0.1',function(){require('node:fs').writeFileSync(${JSON.stringify(join(f.root,"tcp-port"))},String(this.address().port))})`);
  const relay = fixtureComponent(f.root, "native", "native", "setInterval(()=>{},1000)");
  relay.args.push("--", "--daemon", "--codex", join(f.root,"sdk"), "--native-home", join(f.root,"native"), "--relay-home", join(f.root,"relay"));
  const plan: ServicePlan = { version: 1, config: f.config, sharedExecutors: true, components: [stream, tunnel, relay] };
  const hostServer = createServer(socket => socket.pipe(socket)); const socketPath = join(f.root,"owned.sock");
  const startHost = async () => { await new Promise<void>(done=>hostServer.listen(socketPath, done)); return { close: async () => { hostCloses++; await new Promise<void>(done=>hostServer.close(()=>done())); }, prepareStop: async () => { hostGuards++; return false; }, resume: () => {} }; };
  const old = new ServiceSupervisor(plan, f.root, 10, startHost as never, unregistered, undefined, undefined, healing("1.1.8", schedules));
  let tcp: ReturnType<typeof createConnection> | undefined; let hostSocket: ReturnType<typeof createConnection> | undefined;
  try {
    await old.start();
    await until(async () => !!await readFile(join(f.root,"tcp-port")).catch(()=>undefined) && !!await readFile(join(f.root,"http-port")).catch(()=>undefined));
    const response = await fetch(`http://127.0.0.1:${await readFile(join(f.root,"http-port"),"utf8")}`);
    const reader = response.body!.getReader(); assert.equal(new TextDecoder().decode((await reader.read()).value), "before");
    tcp = createConnection(Number(await readFile(join(f.root,"tcp-port"),"utf8")), "127.0.0.1");
    hostSocket = createConnection(socketPath);
    await Promise.all([new Promise<void>(done=>tcp!.once("connect",done)),new Promise<void>(done=>hostSocket!.once("connect",done))]);
    const before = await f.state();
    const slots = (old as unknown as { slots: unknown }).slots;
    for (const release of ["1.1.9", "1.2.0"]) {
      const next = new ServiceSupervisor(plan, f.root, 10, undefined, unregistered, undefined, undefined, healing(release, schedules));
      assert.equal(await old.current().handover(next), true);
      assert.equal((next as unknown as { slots: unknown }).slots, slots, "the exact owned handles and retry slots survive");
      const after = await f.state();
      assert.deepEqual(after.components, before.components);
      assert.equal(after.runningRelease, "1.1.8", "bootstrap provenance stays truthful"); assert.equal(after.controllerRelease, release);
      for (const socket of [tcp,hostSocket]) {
        const echoed = new Promise<Buffer>(done=>socket!.once("data", done)); socket!.write("active"); assert.equal((await echoed).toString(),"active");
      }
    }
    assert.equal(hostCloses,0); assert.ok(hostGuards >= 1, "the retained busy host refuses strict idle replacement"); assert.equal(schedules.active,1); assert.equal(schedules.maximum,1);
    await writeFile(join(f.root,"finish"), "go"); assert.equal(new TextDecoder().decode((await reader.read()).value), "after"); assert.equal((await reader.read()).done,true);
    tcp.destroy(); hostSocket.destroy();
    await old.stop(); assert.equal(hostCloses,1); assert.equal(schedules.active,0); await old.stopped;
    for (const row of before.components) if (row.pid) assert.throws(()=>process.kill(row.pid!,0));
  } finally { tcp?.destroy();hostSocket?.destroy();await old.stop();await f.cleanup(); }
});

test("candidate activation failure restores the old controller and one scheduler without touching children", { timeout: 15000 }, async () => {
  const f = await setup(); const schedules = { active: 0, maximum: 0 };
  const plan: ServicePlan = { version:1,config:f.config,components:[fixtureComponent(f.root,"claude-adapter","claude-adapter","setInterval(()=>{},1000)")] };
  const old = new ServiceSupervisor(plan,f.root,10,undefined,undefined,undefined,undefined,healing("1.1.8",schedules));
  try {
    await old.start(); await until(async()=>!!(await f.state()).components[0].pid); const before=await f.state();
    const next = new ServiceSupervisor(plan,f.root,10,undefined,undefined,undefined,undefined,healing("1.1.9",schedules,true));
    assert.equal(await old.handover(next),false);assert.equal(old.current(),old);
    assert.deepEqual((await f.state()).components,before.components);assert.equal(schedules.active,1);assert.equal(schedules.maximum,1);
    const mismatch = new ServiceSupervisor({...plan,components:[{...plan.components[0],args:["-e","process.exit(0)"]}]},f.root);
    assert.equal(await old.handover(mismatch),false);assert.equal(schedules.active,1);
  } finally {await old.stop();await f.cleanup();}
});

test("a child exit after handover is observed once and its inherited retry restarts under the new controller", {timeout:15000}, async()=>{
  const f=await setup();const schedules={active:0,maximum:0};
  const plan:ServicePlan={version:1,config:f.config,components:[fixtureComponent(f.root,"claude-adapter","claude-adapter","setInterval(()=>{},1000)")]};
  const old=new ServiceSupervisor(plan,f.root,100,undefined,undefined,undefined,undefined,healing("1.1.8",schedules));
  try{
    await old.start();await until(async()=>!!(await f.state()).components[0].pid);const before=(await f.state()).components[0].pid!;
    const next=new ServiceSupervisor(plan,f.root,100,undefined,undefined,undefined,undefined,healing("1.1.9",schedules));
    assert.equal(await old.handover(next),true);process.kill(before,"SIGTERM");
    await until(async()=>{const row=(await f.state()).components[0];return !!row.pid&&row.pid!==before;});
    assert.equal((await f.state()).components[0].restarts,1);assert.equal(schedules.active,1);
  }finally{await old.stop();await f.cleanup();}
});

test("the host adopts the new implementation automatically only after its strict idle gate accepts", {timeout:15000}, async()=>{
 const f=await setup();const schedules={active:0,maximum:0};let idle=false;let oldCloses=0;let newStarts=0;
 const relay=fixtureComponent(f.root,"native","native","setInterval(()=>{},1000)");
 relay.args.push("--","--daemon","--codex",join(f.root,"sdk"),"--native-home",join(f.root,"native"),"--relay-home",join(f.root,"relay"));
 const plan:ServicePlan={version:1,config:f.config,sharedExecutors:true,components:[relay]};
 const oldHost=async()=>({close:async()=>{oldCloses++;},prepareStop:async()=>idle,resume:()=>{}});
 const newHost=async()=>{newStarts++;return {close:async()=>{},prepareStop:async()=>false,resume:()=>{}};};
 const old=new ServiceSupervisor(plan,f.root,10,oldHost as never,unregistered,undefined,undefined,healing("1.1.8",schedules));
 try{
  await old.start();const next=new ServiceSupervisor(plan,f.root,10,newHost as never,unregistered,undefined,undefined,healing("1.1.9",schedules));
  assert.equal(await old.handover(next),true);assert.equal(oldCloses,0);assert.equal(newStarts,0);
  idle=true;
  const keeper=(next as unknown as {host:{restartHostWhenIdle():Promise<void>}}).host;
  await keeper.restartHostWhenIdle();await until(()=>newStarts===1);
  assert.equal(oldCloses,1);assert.equal((await f.state()).controllerRelease,"1.1.9");
 }finally{await old.stop();await f.cleanup();}
});

test("changed plan during async staging refuses without retiring the old controller",{timeout:15000},async()=>{
 const f=await setup();const schedules={active:0,maximum:0};
 const plan:ServicePlan={version:1,config:f.config,components:[fixtureComponent(f.root,"claude-adapter","claude-adapter","setInterval(()=>{},1000)")]};
 const old=new ServiceSupervisor(plan,f.root,10,undefined,undefined,undefined,undefined,healing("1.1.8",schedules));
 try{
  await old.start();await until(async()=>!!(await f.state()).components[0].pid);const before=await f.state();let revision=0;
  const next=new ServiceSupervisor(plan,f.root,10,undefined,undefined,undefined,undefined,healing("1.1.9",schedules));
  assert.equal(await old.handover(next,async()=>++revision<2),false);
  assert.equal(old.current(),old);assert.equal(schedules.active,1);assert.deepEqual((await f.state()).components,before.components);
 }finally{await old.stop();await f.cleanup();}
});

test("an inherited retry and a paused relay keep their lifecycle state through the switch",{timeout:15000},async()=>{
 const f=await setup();const schedules={active:0,maximum:0};
 const relay=fixtureComponent(f.root,"native","native","setInterval(()=>{},1000)");
 const component=fixtureComponent(f.root,"claude-adapter","claude-adapter","setInterval(()=>{},1000)");
 const plan:ServicePlan={version:1,config:f.config,components:[component,relay]};
 const old=new ServiceSupervisor(plan,f.root,500,undefined,unregistered,undefined,undefined,healing("1.1.8",schedules));
 try{
  await old.start();await until(async()=>!!(await f.state()).components[0].pid);
  process.kill((await f.state()).components[0].pid!,"SIGTERM");await until(async()=>(await f.state()).components[0].state==="waiting");
  const waiting=await f.state();assert.equal(waiting.components[1].state,"paused");
  const next=new ServiceSupervisor(plan,f.root,500,undefined,unregistered,undefined,undefined,healing("1.1.9",schedules));
  assert.equal(await old.handover(next),true);assert.deepEqual((await f.state()).components,waiting.components);
  await until(async()=>!!(await f.state()).components[0].pid);assert.equal((await f.state()).components[0].restarts,1);
  assert.deepEqual((await f.state()).components[1],waiting.components[1]);
 }finally{await old.stop();await f.cleanup();}
});
