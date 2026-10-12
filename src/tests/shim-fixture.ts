import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { modelCatalog } from "../catalog.js";
import type { GatewayConfig } from "../config.js";

export async function shimFiles() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-shim-"));
  const backend = join(directory, "codex"); const catalog = join(directory, "models.json");
  const nativeHome = join(directory, "native"); const stateDirectory = join(directory, ".state");
  await mkdir(nativeHome); await mkdir(stateDirectory);
  await writeFile(join(nativeHome, "config.toml"), 'model = "native"\n', { mode: 0o600 });
  await writeFile(join(nativeHome, "auth.json"), '{"fake_primary_secret":"must-never-be-copied"}', { mode: 0o600 });
  await writeFile(join(stateDirectory, "client-token"), "test-gateway-token-" + "x".repeat(32), { mode: 0o600 });
  await writeFile(catalog, JSON.stringify({ identity: "excluded-native-cache-identity", models: [{ slug: "native", priority: 1, context_window: 800000, apply_patch_tool_type: "freeform", model_messages: { instructions_template: "original native instructions" } }] }));
  const value: GatewayConfig = { version: 1, port: 0, stateDirectory, providers: [{ id: "claude", type: "claude-subscription", models: { "claude/model": "model" } }] };
  let publicCatalog = modelCatalog(value);
  const server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer test-gateway-token-" + "x".repeat(32)) { res.writeHead(401); res.end(); return; }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(publicCatalog));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); server.unref();
  value.port = (server.address() as { port: number }).port;
  await writeFile(backend, `#!/usr/bin/env node
const {createInterface}=require('node:readline');
const fs=require('node:fs');const path=require('node:path');
if(process.argv.includes('--version')) {console.log('native-codex-test-version');process.exit(0);}
const overrides={};for(let i=0;i<process.argv.length;i++)if(process.argv[i]==='-c'){const arg=process.argv[++i];const at=arg.indexOf('=');try{overrides[arg.slice(0,at)]=JSON.parse(arg.slice(at+1));}catch{}}
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');let pending;let serial=0;const threads=new Map();
const home=process.env.CODEX_HOME||${JSON.stringify(nativeHome)};
const readThread=id=>threads.get(id)||JSON.parse(fs.readFileSync(path.join(home,'sessions',id+'.json'),'utf8'));
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(!m.method&&pending){if(m.id!==pending.id||m.result.decision!=='accept')process.exit(9);send({method:'serverRequest/resolved',params:{threadId:pending.params.threadId,requestId:pending.id}});send({id:pending.id,result:{turn:{id:'turn'}}});send({method:'turn/completed',params:{threadId:pending.params.threadId,turn:{id:'turn',status:'completed'}}});pending=null;return;}
 if(m.id===undefined)return;
 if(m.method==='model/list')send({id:m.id,result:{data:[{id:'native',model:'native',displayName:'Native'}],nextCursor:null}});
 else if(m.method==='config/read')send({id:m.id,result:{config:{model:'native',model_provider:'openai',model_catalog_json:${JSON.stringify(catalog)},...(fs.existsSync(path.join(home,'agent-policy.json'))?JSON.parse(fs.readFileSync(path.join(home,'agent-policy.json'),'utf8')):{})}}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'chatgpt',email:'primary-test-account'}}});
 else if(m.method==='thread/start'){
   const thread={id:process.pid+'-'+(++serial),modelProvider:m.params.modelProvider||'openai',model:m.params.model,ephemeral:!!m.params.ephemeral};threads.set(thread.id,thread);
   if(!thread.ephemeral){fs.mkdirSync(path.join(home,'sessions'),{recursive:true});fs.writeFileSync(path.join(home,'sessions',thread.id+'.json'),JSON.stringify(thread));}
   if(thread.modelProvider==='subscription_gateway')fs.appendFileSync(path.join(home,'config.toml'),'# automatic gateway trust entry\\n');
   send({id:m.id,result:{serviceTier:null,thread,modelProvider:thread.modelProvider,model:thread.model}});
 }
 else if(m.method==='thread/read'||m.method==='thread/resume'){try{const thread=readThread(m.params.threadId);threads.set(thread.id,thread);send({id:m.id,result:{...(m.method==='thread/resume'?{serviceTier:null}:{}),thread,modelProvider:thread.modelProvider,model:thread.model}});}catch{send({id:m.id,error:{code:-32000,message:'Thread not found'}});}}
 else if(m.method==='thread/unsubscribe'){threads.delete(m.params.threadId);send({id:m.id,result:{status:'unsubscribed'}});send({method:'thread/closed',params:{threadId:m.params.threadId}});}
 else if(m.method==='turn/start'){pending=m;send({id:m.id,method:'item/commandExecution/requestApproval',params:{threadId:m.params.threadId,turnId:'turn',itemId:'command'}});}
 else if(m.method==='engine/info')send({id:m.id,result:{pid:process.pid,home,stepModelSwitching:overrides['features.step_model_switching']===true,catalog:overrides.model_catalog_json?JSON.parse(fs.readFileSync(overrides.model_catalog_json,'utf8')).models.map(model=>({slug:model.slug,context:model.context_window})):[],primaryAuthPresent:fs.existsSync(path.join(home,'auth.json'))}});
 else if(m.method==='crash')process.exit(7);
 else send({id:m.id,result:{}});
});
`, { mode: 0o700 });
  const config = join(directory, "gateway.json"); await writeFile(config, JSON.stringify(value), { mode: 0o600 });
  return { backend, config, catalog, directory, value, nativeHome, env: { ...process.env, CODEX_HOME: nativeHome },
    cli: fileURLToPath(new URL("../cli.js", import.meta.url)),
    close: () => server.close(), setCatalog: (next: ReturnType<typeof modelCatalog>) => { publicCatalog = next; } };
}
