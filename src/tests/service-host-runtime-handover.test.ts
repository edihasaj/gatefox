import test from "node:test";
import assert from "node:assert/strict";
import { ServiceHostKeeper, type HostKeeperContext } from "../service-host-keeper.js";
import { defaultHealing } from "../service-heal.js";

function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve}; }

test("new host policy waits until the secondary relay-registration probe completes",async()=>{
 const gate=deferred<boolean>();let entered=false;
 const context:HostKeeperContext={plan:{version:1,config:"/tmp/fixture.json",components:[]},state:"/tmp/fixture",retryBaseMs:10,
  startHost:(async()=>{throw Error("no start expected");}) as never,
  heal:{...defaultHealing,probeHost:async()=>undefined,kickGapMs:0},
  registered:async()=>{entered=true;return gate.promise;},stopping:()=>false,restarting:()=>false,publish:async()=>{},restartWhenIdle:async()=>false};
 const old=new ServiceHostKeeper(context);const nextContext={...context,registered:async()=>false};const next=new ServiceHostKeeper(nextContext);
 old.executionState={state:"running",home:"/tmp/fixture",pid:process.pid,sharedNativeExecutor:true,sharedGatewayExecutors:true};
 old.executionStarting=Promise.resolve({close:async()=>{},prepareStop:async()=>false,resume:()=>{}});
 const internals=old as unknown as {hostRestartReason:string;context:HostKeeperContext};internals.hostRestartReason="relay_registered";
 const checking=old.restartHostWhenIdle();
 try{
  assert.equal(entered,true);assert.equal(old.canHandover(),false,"an awaited registration probe owns the old policy context");
  old.adoptRuntime(next);assert.equal(internals.context,context,"new factory stays staged while the probe is running");
  gate.resolve(true);await checking;await old.checkHost();
  assert.equal(internals.context,nextContext);assert.equal(old.canHandover(),true);
  assert.equal(internals.hostRestartReason,"release_update","a withdrawn registration does not discard the pending release replacement");
 }finally{gate.resolve(false);await checking;old.stopWatching();next.stopWatching();}
});
