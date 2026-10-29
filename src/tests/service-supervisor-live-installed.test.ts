import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, open, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { writePrivateJson } from "../config.js";
import { servicePlanPath } from "../service-plan.js";
import { fixtureComponent, killFixtures, killFixturesAfterTests } from "./supervisor-fixture.js";
import { shortFolder } from "./short-folder.js";

killFixturesAfterTests();
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let n=0;n<1000;n++) { const value=await read(); if(value!==undefined)return value; await delay(10); }
  throw Error("installed controller fixture did not settle");
}

test("an installed service loads the next immutable controller while its real HTTP request and root PID remain live", {timeout:45000},async()=>{
 const made=await shortFolder("gwli-");const root=made.directory;const state=join(root,"state");await mkdir(state,{mode:0o700});
 const dist=resolve(dirname(fileURLToPath(import.meta.url)),"..");
 for(const version of ["1.1.8","1.1.9"]){
  const release=join(root,"releases",version);await mkdir(join(release,"package"),{recursive:true,mode:0o700});
  await cp(dist,join(release,"package/dist"),{recursive:true,filter:path=>!path.startsWith(join(dist,"tests"))});
  await writeFile(join(release,"package/package.json"),JSON.stringify({type:"module"}),{mode:0o600});
  await symlink(resolve("node_modules"),join(release,"package/node_modules"));
  await writeFile(join(release,".gateway-release"),version+"\n",{mode:0o600});
 }
 await symlink("releases/1.1.8",join(root,"current"));
 const config=join(state,"gateway.json");await writePrivateJson(config,{version:1,port:3459,clientOnly:true,stateDirectory:state,providers:[]});
 const portFile=join(state,"port");const finish=join(state,"finish");
 const component=fixtureComponent(state,"claude-adapter","claude-adapter",`require('node:http').createServer((req,res)=>{res.writeHead(200);res.write('before');const t=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(finish)})){clearInterval(t);res.end('after')}},10)}).listen(0,'127.0.0.1',function(){require('node:fs').writeFileSync(${JSON.stringify(portFile)},String(this.address().port))})`);
 const plan={version:1,config,components:[component]};await writePrivateJson(servicePlanPath(state),plan);
 const entry=join(root,"entry.mjs");await writeFile(entry,`import {runServiceSupervisor} from ${JSON.stringify(pathToFileURL(join(root,"releases/1.1.8/package/dist/service-supervisor-run.js")).href)};await runServiceSupervisor(${JSON.stringify(plan)},${JSON.stringify(state)});`);
 const log=await open(join(root,"child.log"),"w",0o600);
 const child=spawn(process.execPath,[entry],{env:{...process.env,GATEWAY_UPGRADE_CHECK_MS:"20"},stdio:["ignore",log.fd,log.fd]});
 const exited=new Promise<void>(done=>child.once("close",()=>done()));let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 try{
  const port=await until(()=>readFile(portFile,"utf8").catch(()=>undefined));
  const response=await fetch(`http://127.0.0.1:${port}`);reader=response.body!.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),"before");
  const status=()=>readFile(join(state,"service-status.json"),"utf8").then(JSON.parse).catch(()=>undefined) as Promise<{pid:number;runningRelease:string;controllerRelease:string;components:Array<{pid?:number}>}|undefined>;
  const before=await until(status);assert.equal(before.pid,child.pid);assert.equal(before.controllerRelease,"1.1.8");
  await symlink("releases/1.1.9",join(root,"next"));await rename(join(root,"next"),join(root,"current"));
  const after=await until(async()=>{const value=await status();return value?.controllerRelease==="1.1.9"?value:undefined;});
  assert.equal(after.pid,before.pid);assert.equal(after.runningRelease,"1.1.8");assert.deepEqual(after.components,before.components);
  await writeFile(finish,"go");assert.equal(new TextDecoder().decode((await reader.read()).value),"after");assert.equal((await reader.read()).done,true);
  child.kill("SIGTERM");await exited;
  for(const row of before.components)if(row.pid)assert.throws(()=>process.kill(row.pid!,0));
 }finally{await reader?.cancel().catch(()=>{});child.kill("SIGTERM");await exited;await log.close();await killFixtures(state);await made.remove();}
});
