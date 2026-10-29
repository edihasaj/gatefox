import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const {values:v}=parseArgs({options:{package:{type:'string'},code:{type:'string'},root:{type:'string'}}});
assert.ok(v.package&&v.code&&v.root,'--package, --code and --root are required');
const code=resolve(v.code),pkg=resolve(v.package),root=resolve(v.root);
await mkdir(root,{recursive:true,mode:0o700});const home=await mkdtemp(join(root,'home-')),work=join(home,'work');await mkdir(work,{mode:0o700});
const {startGateway}=await import(pathToFileURL(join(code,'dist/server.js')));
const {modelCatalog}=await import(pathToFileURL(join(code,'dist/catalog.js')));
const {gatewayToken}=await import(pathToFileURL(join(code,'dist/config.js')));
const {AvailabilityService}=await import(pathToFileURL(join(code,'dist/availability/service.js')));
const state=join(home,'gateway-state'),alias='managed/routine',proof='MANAGED_COMPACTION_PROOF_7613';
const requests=[],refusals=[],events=[],admissions=[];let seed=true;
const {ManagedRouter}=await import(pathToFileURL(join(code,'dist/managed-routing.js')));const originalResolve=ManagedRouter.prototype.resolve;ManagedRouter.prototype.resolve=function(config,request,context,report){admissions.push({kind:context.requestKind??'turn',bytes:Buffer.byteLength(JSON.stringify(request))});return originalResolve.call(this,config,request,context,report);};
const config={version:1,port:0,stateDirectory:state,providers:[{id:'local',type:'chat-completions-api',baseUrl:'http://127.0.0.1:1/v1',apiKeyEnv:'UNUSED',models:{'local/mock':'mock'},modelMetadata:{'local/mock':{contextWindow:262144,reasoningEfforts:['low']}}},{id:'sub',type:'codex-subscription',credentialFile:'unused',models:{'sub/mock':'mock'},modelMetadata:{'sub/mock':{contextWindow:262144,reasoningEfforts:['low']}}}],managedRouting:{routes:{[alias]:{purpose:'routine',candidates:['local/mock','sub/mock'],contextWindow:32768,maxContextBytes:163840,minRemainingPercent:2,allowPaid:false}}}};
const availability=new AvailabilityService({probe:async()=>({status:'healthy',observedAt:Date.now(),endpoints:{healthy:1,total:1},servedModels:['mock'],missingModels:[]}),accountEmail:async()=>undefined});
const gateway=await startGateway(config,p=>({async *infer(request,_signal,context){
 assert.equal(p.id,'local');requests.push({kind:context.requestKind??'turn',bytes:Buffer.byteLength(JSON.stringify(request)),containsProof:JSON.stringify(request.input).includes(proof)});
 const preservedProof=JSON.stringify(request.input).includes(proof)?proof:'PROOF_LOST';
 const text=seed?proof+'\n'+'bounded-history '.repeat(18000):preservedProof+' COMPACTED';const output=seed?40000:10;seed=false;
 yield{type:'text',text};yield{type:'done',usage:{input_tokens:1000,output_tokens:output,total_tokens:1000+output}};
}}),undefined,{availability,onFailure:f=>refusals.push({code:f.code,status:f.status})});
const port=gateway.address().port,token=await gatewayToken(state),catalog=join(home,'models.json');await writeFile(catalog,JSON.stringify(modelCatalog(config)));
const toml=`model = "${alias}"\nmodel_provider = "fixture"\nmodel_catalog_json = ${JSON.stringify(catalog)}\nmodel_context_window = 32768\nmodel_auto_compact_token_limit = 25000\nweb_search = "disabled"\n[features]\nplugins = false\nhooks = false\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nenv_key = "MANAGED_FIXTURE_TOKEN"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`;
await writeFile(join(home,'config.toml'),toml,{mode:0o600});
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(CODEX|OPENAI|GATEWAY|SUBSCRIPTION_GATEWAY|ANTHROPIC|CLAUDE|OP_)/.test(k)));
Object.assign(env,{HOME:home,CODEX_HOME:home,MANAGED_FIXTURE_TOKEN:token,CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED:'1',TMPDIR:root});
const child=spawn(join(pkg,'gateway-sdk/gateway-codex'),['app-server','--listen','stdio://'],{cwd:work,env,stdio:['pipe','pipe','pipe'],detached:true});let stderr='';child.stderr.on('data',b=>{stderr=(stderr+b).slice(-6000)});
const pending=new Map();let seq=0;const lines=createInterface({input:child.stdout});
lines.on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method&&m.id!==undefined){child.stdin.write(JSON.stringify({id:m.id,error:{code:-32601,message:'No fixture tools'}})+'\n');}else if(m.method)events.push(m);});
function rpc(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},30000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
async function turn(id,text){const before=events.length;const ack=await rpc('turn/start',{threadId:id,model:alias,effort:'low',input:[{type:'text',text}]});const until=Date.now()+35000;while(Date.now()<until){const done=events.slice(before).find(e=>e.method==='turn/completed'&&e.params.turn.id===ack.turn.id);if(done)return done.params.turn;await delay(30);}throw Error('turn completion timeout');}
let result;
try{
 await rpc('initialize',{clientInfo:{name:'managed_route_fixture',version:'1'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
 const started=await rpc('thread/start',{model:alias,modelProvider:'fixture',cwd:work,approvalPolicy:'never',sandbox:'read-only'});
 const first=await turn(started.thread.id,'Seed the isolated fixture.');assert.equal(first.status,'completed');
 const second=await turn(started.thread.id,'Continue using the saved proof after compacting history.');
 result={passed:second.status==='completed',first:first.status,second:second.status,requests,refusals,admissions,compactionEvents:events.filter(e=>e.params?.item?.type==='contextCompaction').map(e=>e.method),paidInferenceRequests:0,primaryStateRead:false};
 assert.equal(second.status,'completed','Managed compaction must recover inside the actual SDK turn');
 const budget=config.managedRouting.routes[alias].maxContextBytes;
 const compactIndex=requests.findIndex(r=>r.kind==='compaction');
 assert.ok(compactIndex>0,'SDK must compact an existing worker');
 const compact=requests[compactIndex],continued=requests[compactIndex+1];
 assert.ok(compact.bytes>budget&&compact.bytes<=Math.min(4*budget,4194304),'Compaction must exercise the bounded recovery allowance');
 assert.equal(compact.containsProof,true,'Compaction must receive the original proof');
 assert.equal(continued?.kind,'turn','SDK must continue ordinary inference after compaction');
 assert.equal(continued.containsProof,true,'Compacted history must preserve the original proof');
 assert.ok(continued.bytes<=budget,'Ordinary turn must return below the original budget');
 assert.deepEqual(refusals,[],'Recovery must not trigger admission refusals');
 assert.deepEqual(result.compactionEvents,['item/started','item/completed'],'SDK must complete the compaction lifecycle');
}catch(e){result={passed:false,error:e.message,requests,refusals,admissions,events:events.slice(-10).map(e=>({method:e.method,status:e.params?.turn?.status,error:e.params?.error})),stderr,paidInferenceRequests:0,primaryStateRead:false};throw e;}
finally{
 await writeFile(join(root,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
 lines.close();for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Fixture stopped'))}pending.clear();child.stdin.end();
 if(child.exitCode===null){try{process.kill(-child.pid,'SIGTERM')}catch{}}
 const end=Date.now()+3000;while(child.exitCode===null&&Date.now()<end)await delay(30);if(child.exitCode===null){try{process.kill(-child.pid,'SIGKILL')}catch{}}
 availability.stop();gateway.closeAllConnections();await new Promise(r=>gateway.close(r));
 console.log(JSON.stringify(result));
}
