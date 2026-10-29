import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ServiceSupervisor, type NativeProbes, type SupervisorHealing } from "../service-supervisor.js";
import { writePrivateJson } from "../config.js";
import { shortFolder } from "./short-folder.js";
import { fixtureComponent, killFixtures, killFixturesAfterTests } from "./supervisor-fixture.js";

killFixturesAfterTests();
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 1000; n++) { if (check()) return; await delay(5); }
  assert.fail("fixture did not settle");
}
interface Slot { child?: { pid?: number }; quickFailures: number; timer?: unknown; state: { state: string; pid?: number } }
interface Internals { slots: Slot[]; modelMaintenance?: { stop(): Promise<void> }; controlInFlight: number }
const heal: Partial<SupervisorHealing> = { releaseState: () => ({ running: "1.1.8", installed: "1.1.8" }), healthSchedule: () => () => {} };

test("native pause begun during failed activation completes under restored owner without losing the child exit", { timeout: 15000 }, async () => {
  const made = await shortFolder("gwlr-"); const root = made.directory; const config = join(root,"gateway.json");
  await writePrivateJson(config,{version:1,port:3459,clientOnly:true,stateDirectory:root,providers:[]});
  const component = fixtureComponent(root,"native","native","setInterval(()=>{},1000)");
  const plan = {version:1 as const,config,components:[component]};
  const stopGate = deferred(); const fingerprintGate = deferred(); let fingerprintEntered = false;
  const probes: NativeProbes = {registered:async()=>true,fingerprint:async()=>"old",appRunning:async()=>true};
  const old = new ServiceSupervisor(plan,root,10,undefined,probes,undefined,undefined,heal);
  const candidate = new ServiceSupervisor(plan,root,10,undefined,{...probes,fingerprint:async()=>{fingerprintEntered=true;await fingerprintGate.promise;return "new";}},undefined,undefined,
    {...heal,healthSchedule:()=>{throw Error("candidate refused");}});
  const state = old as unknown as Internals;
  try {
    await old.start(); await until(()=>!!state.slots[0].child?.pid);
    state.slots[0].quickFailures=2; const maintenance=state.modelMaintenance; state.modelMaintenance={stop:async()=>{await maintenance?.stop();await stopGate.promise;}};
    const changing=old.handover(candidate);
    await until(()=>old.current()===candidate);
    process.kill(state.slots[0].child!.pid!,"SIGTERM");
    await until(()=>fingerprintEntered);
    stopGate.resolve(); await delay(20); fingerprintGate.resolve();
    assert.equal(await changing,false); assert.equal(old.current(),old);
    assert.equal(state.slots[0].state.state,"paused");assert.equal(state.slots[0].child,undefined);assert.equal(state.slots[0].timer,undefined);
    assert.equal(state.slots[0].quickFailures,3);assert.equal((candidate as unknown as Internals).controlInFlight,0);
    const snapshot=JSON.parse(await readFile(join(root,"service-status.json"),"utf8"));assert.equal(snapshot.components[0].state,"paused");
  }finally{stopGate.resolve();fingerprintGate.resolve();await old.stop();await killFixtures(root);await made.remove();}
});
