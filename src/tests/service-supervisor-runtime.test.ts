import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installedSupervisorRuntime } from "../service-supervisor-runtime.js";
import { shortFolder } from "./short-folder.js";

async function fixture(body: string) {
  const made = await shortFolder("gwlr-");
  for (const version of ["1.1.8", "1.1.9"]) await mkdir(join(made.directory,"releases",version,"package","dist"),{recursive:true,mode:0o700});
  for (const version of ["1.1.8", "1.1.9"]) await writeFile(join(made.directory,"releases",version,".gateway-release"),version+"\n",{mode:0o600});
  const module=join(made.directory,"releases/1.1.9/package/dist/service-supervisor-runtime.js");
  await writeFile(module,body,{mode:0o600});
  await symlink("releases/1.1.9",join(made.directory,"current"));
  const source=pathToFileURL(join(made.directory,"releases/1.1.8/package/dist/service-supervisor-runtime.js")).href;
  return {...made,module,source};
}
test("supervisor loader accepts a matching ABI from the same immutable installed release",async()=>{
 const f=await fixture('export const supervisorRuntimeVersion=1;export const createSupervisor=()=>({fixture:true})');
 try{const candidate=await installedSupervisorRuntime(f.source);assert.equal(candidate?.supervisorRuntimeVersion,1);candidate?.release();}finally{await f.remove();}
});
test("supervisor loader refuses an incompatible ABI and a writable module",async()=>{
 const f=await fixture('export const supervisorRuntimeVersion=2;export const createSupervisor=()=>({})');
 try{assert.equal(await installedSupervisorRuntime(f.source),undefined);}finally{await f.remove();}
 const g=await fixture('export const supervisorRuntimeVersion=1;export const createSupervisor=()=>({})');
 try{await (await import('node:fs/promises')).chmod(g.module,0o666);assert.equal(await installedSupervisorRuntime(g.source),undefined);}finally{await g.remove();}
});
test("supervisor loader is inert for checkout modules and another installation's current target",async()=>{
 assert.equal(await installedSupervisorRuntime(),undefined);
 const f=await fixture('export const supervisorRuntimeVersion=1;export const createSupervisor=()=>({})');
 const {unlink}=await import('node:fs/promises');
 try{await unlink(join(f.directory,"current"));await symlink("releases/1.1.8",join(f.directory,"current"));assert.equal(await installedSupervisorRuntime(f.source),undefined);}finally{await f.remove();}
});
