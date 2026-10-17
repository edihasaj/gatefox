import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {Duplex} from 'node:stream';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

const {values:v}=parseArgs({options:{gateway:{type:'string'},package:{type:'string'},config:{type:'string'},codex:{type:'string'},'native-home':{type:'string'},workspace:{type:'string'},image:{type:'string'},expected:{type:'string'},output:{type:'string'},models:{type:'string',default:'claude/claude-sonnet-5-5,codex/gpt-6.1-sol'}}});
for(const key of ['gateway','package','config','codex','native-home','workspace','image','expected','output'])assert.ok(v[key],`Required --${key}`);
const {WebSocket}=createRequire(join(resolve(v.package),'package.json'))('ws');
const home=resolve(v['native-home']);const workspace=resolve(v.workspace);await mkdir(workspace,{recursive:true});
const proxyHome=join(home,'../proxy');
const configFile=join(home,'config.toml');const digest=async()=>createHash('sha256').update(await readFile(configFile)).digest('hex');const before=await digest();
const env={...process.env,CODEX_HOME:home};for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'])delete env[key];
const results=[];const save=async row=>{results.push(row);await writeFile(resolve(v.output),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2),{mode:0o600});console.log(JSON.stringify(row));};
const listener=spawn(resolve(v.gateway),['codex-shim','--ssh','--ssh-home',proxyHome,'--config',resolve(v.config),'--codex',resolve(v.codex),'--','app-server','--listen','unix://'],{env,stdio:'ignore'});
const exited=once(listener,'close');let connection;
async function waitFor(check,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){const result=await check();if(result)return result;await delay(50);}throw Error('Unix verification timed out');}
async function connect(){
 const proxy=spawn(resolve(v.codex),['app-server','proxy'],{env:{...env,CODEX_HOME:proxyHome},stdio:['pipe','pipe','ignore']});const proxyExited=once(proxy,'close');
 const pipe=Duplex.from({readable:proxy.stdout,writable:proxy.stdin});
 const ws=new WebSocket('ws://codex-app-server/rpc',{createConnection:()=>pipe});
 const pending=new Map();const events=[];let id=0;
 const fail=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Native proxy disconnected'));}pending.clear();};
 ws.on('close',fail);ws.on('error',fail);
 ws.on('message',data=>{const m=JSON.parse(data.toString());const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method&&m.id!==undefined)ws.send(JSON.stringify({id:m.id,error:{code:-32601,message:'No external test-client tool handler'}}));else if(m.method)events.push(m);});
 try { await once(ws,'open',{signal:AbortSignal.timeout(15000)}); }
 catch(error){ws.terminate();pipe.destroy();proxy.kill('SIGTERM');await proxyExited;throw error;}
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(Error(`${method} timed out`));},120000);pending.set(key,{resolve,reject,timer});ws.send(JSON.stringify({id:key,method,params}));});
 const close=async()=>{ws.terminate();pipe.destroy();proxy.kill('SIGTERM');fail();await proxyExited;};
 const client={rpc,events,close};
 try { await rpc('initialize',{clientInfo:{name:'gateway_unix_e2e',version:'0.2.3'},capabilities:{experimentalApi:true}}); }
 catch(error){await close();throw error;}
 ws.send(JSON.stringify({method:'initialized',params:{}}));return client;
}
async function turn(id,model,input,effort='low',cancel=false){
 const client=connection;const offset=client.events.length;
 const response=await client.rpc('turn/start',{threadId:id,model,effort,input});
 let cancellationMs;
 if(cancel){await waitFor(()=>client.events.slice(offset).some(e=>e.method==='item/agentMessage/delta'));const began=Date.now();await client.rpc('turn/interrupt',{threadId:id,turnId:response.turn.id});cancellationMs=Date.now()-began;}
 const completed=await waitFor(()=>client.events.slice(offset).find(e=>e.method==='turn/completed'&&e.params.turn.id===response.turn.id));
 const events=client.events.slice(offset);const items=events.filter(e=>e.method==='item/completed').map(e=>e.params.item);
 const text=events.filter(e=>e.method==='item/agentMessage/delta').map(e=>e.params.delta).join('');
 assert.equal(completed.params.turn.status,cancel?'interrupted':'completed',completed.params.turn.error?.message);
 return {text,items,deltas:events.filter(e=>e.method==='item/agentMessage/delta').length,cancellationMs};
}
const text=message=>[{type:'text',text:message}];const expected=JSON.parse(await readFile(resolve(v.expected),'utf8')).code;
try{
 await waitFor(()=>lstat(join(proxyHome,'app-server-control/app-server-control.sock')).then(()=>true,()=>false),20000);
 connection=await connect();const models=await connection.rpc('model/list',{limit:100});assert.ok(models.data.some(m=>m.model===v.models.split(',')[0]));
 await save({phase:'native-desktop-proxy',passed:true,models:models.data.length,socketPrivate:(await lstat(join(proxyHome,'app-server-control/app-server-control.sock'))).mode%512===384,nativeControlSocketSeparated:true});
 let previous;
 for(const model of v.models.split(',')){
  const marker=randomUUID();const proof=randomUUID();const title='Unix test '+randomUUID().slice(0,8);
  await writeFile(join(workspace,'AGENTS.md'),`When asked for the verification rule, return exactly: ${marker}.\n`);
  await writeFile(join(workspace,'proof.txt'),proof);await writeFile(join(workspace,'result.txt'),'before\n');
  const start=await connection.rpc('thread/start',{model,cwd:workspace,approvalPolicy:'never',sandbox:'workspace-write'});assert.ok(['openai','subscription_gateway'].includes(start.modelProvider));const id=start.thread.id;
  const tools=await turn(id,model,text('Read proof.txt. Use apply_patch to change result.txt from before to after. Report the proof and the verification rule.'),model.startsWith('claude/')?'max':'ultra');
  assert.ok(tools.text.includes(proof));assert.ok(tools.text.includes(marker));assert.equal((await readFile(join(workspace,'result.txt'),'utf8')).trim(),'after');assert.ok(tools.items.some(i=>i.type==='fileChange'));assert.ok(tools.items.some(i=>i.type==='commandExecution'));assert.ok(tools.deltas>1);
  await save({phase:'tools-and-instructions',model,passed:true,streamedDeltas:tools.deltas,effort:model.startsWith('claude/')?'max':'ultra',automaticAgentsLoaded:true});
  const prompt='Read the eight-digit picture code and describe its colored shapes. Do not use tools.';assert.ok(!prompt.includes(expected));
  const image=await turn(id,model,[...text(prompt),{type:'localImage',path:resolve(v.image)}]);assert.ok(image.text.includes(expected));assert.ok(image.text.toLowerCase().includes('triangle'));assert.ok(!image.items.some(i=>['commandExecution','fileChange','imageView'].includes(i.type)));
  await save({phase:'image-input',model,passed:true,codeOnlyInPixels:true});
  const follow=await turn(id,model,text('Repeat the file proof and picture code from this chat. Do not use tools.'));assert.ok(follow.text.includes(proof));assert.ok(follow.text.includes(expected));
  await save({phase:'follow-up',model,passed:true});
  await connection.rpc('thread/name/set',{threadId:id,name:title});assert.equal((await connection.rpc('thread/read',{threadId:id,includeTurns:false})).thread.name,title);
  await save({phase:'client-title',model,passed:true});
  const cancelled=await turn(id,model,text('Write 1000 numbered paragraphs about trees. Start immediately. Do not use tools.'),'low',true);
  await save({phase:'cancel',model,passed:true,acknowledgementMs:cancelled.cancellationMs});
  await connection.close();connection=await connect();await connection.rpc('thread/resume',{threadId:id,model,cwd:workspace,approvalPolicy:'never',sandbox:'workspace-write'});
  const resumed=await turn(id,model,text('Repeat the file proof and picture code from before interruption. Do not use tools.'));assert.ok(resumed.text.includes(proof));assert.ok(resumed.text.includes(expected));assert.equal((await connection.rpc('thread/read',{threadId:id,includeTurns:false})).thread.name,title);
  await save({phase:'resume-after-proxy-reconnect',model,passed:true,titleAndImageHistoryPreserved:true});
  if(previous){await connection.rpc('thread/resume',{threadId:previous.id,model,cwd:workspace,approvalPolicy:'never',sandbox:'workspace-write'});const switched=await turn(previous.id,model,text('Repeat the file proof and picture code from this chat. Do not use tools.'));assert.ok(switched.text.includes(previous.proof));assert.ok(switched.text.includes(expected));await save({phase:'cross-provider-switch',model,passed:true});}
  previous={id,proof};
 }
 assert.equal(await digest(),before);await save({phase:'verification',passed:true,nativeConfigUnchanged:true});
}catch(error){await save({phase:'verification',passed:false,error:error.message});process.exitCode=1;}
finally{await connection?.close();listener.kill('SIGTERM');await exited;}
