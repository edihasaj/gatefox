// Simulates a power cut during an active goal on a gateway model: the adapter and
// every SDK child are SIGKILLed mid-turn, then a fresh adapter resumes the chat.
// Proves the goal survives and the work continues. Isolated native home; real inference.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {AppServerConnection} from '../dist/app-server-connection.js';
const {values:options}=parseArgs({options:{gateway:{type:'string'},config:{type:'string'},codex:{type:'string'},catalog:{type:'string'},fixture:{type:'string'},output:{type:'string'},model:{type:'string',default:'claude/claude-opus-5-5'},effort:{type:'string',default:'high'},steps:{type:'string',default:'6'}}});
for(const key of ['gateway','config','codex','catalog','fixture','output'])if(!options[key])throw Error(`Missing --${key}`);
const steps=Number(options.steps);const upstream=JSON.parse(await readFile(resolve(options.config),'utf8'));
const root=resolve(options.fixture);const home=join(root,'native'),state=join(root,'state'),work=join(root,'work');
for(const p of [home,state,work])await mkdir(p,{recursive:true,mode:0o700});
await copyFile(resolve(options.catalog),join(home,'models.json'));
await copyFile(resolve(upstream.stateDirectory,'client-token'),join(state,'client-token'));
await writeFile(join(home,'config.toml'),`model_catalog_json = "${join(home,'models.json')}"\n`,{mode:0o600});
let requests=0;
const server=createServer(async(req,res)=>{
 const control=new AbortController();res.on('close',()=>control.abort());
 try{
  const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);if(req.url==='/v1/responses')requests++;
  const r=await fetch(`http://127.0.0.1:${upstream.port}`+req.url,{method:req.method,headers:{authorization:req.headers.authorization,'content-type':'application/json',...(req.headers['session-id']?{'session-id':req.headers['session-id']}:{}),...(req.headers['thread-id']?{'thread-id':req.headers['thread-id']}:{})},...(body.length?{body}:{}),signal:control.signal});
  res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/json'});
  if(r.body)await pipeline(Readable.fromWeb(r.body),res);else res.end();
 }catch{if(!res.headersSent)res.writeHead(502);res.end();}
});server.listen(0,'127.0.0.1');await once(server,'listening');
const config=join(root,'gateway.json');await writeFile(config,JSON.stringify({version:1,clientOnly:true,port:server.address().port,stateDirectory:state,providers:[]}),{mode:0o600});
const env={...process.env,CODEX_HOME:home};for(const k of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'])delete env[k];
const results=[];const record=async row=>{results.push(row);await writeFile(resolve(options.output),JSON.stringify({results},null,2),{mode:0o600});console.log(JSON.stringify(row));};
const wait=async(check,ms=600000)=>{for(const end=Date.now()+ms;Date.now()<end;){const v=await check();if(v)return v;await delay(250);}return undefined;};
const done=async()=>{const names=new Set(await readdir(work));return Array.from({length:steps},(_,i)=>`step${i+1}.txt`).filter(n=>names.has(n)).length;};
async function connect(events){
 const client=new AppServerConnection(resolve(options.gateway),['codex-shim','--config',config,'--codex',resolve(options.codex),'--','app-server','--listen','stdio://'],async m=>{
  if(m.id!==undefined&&m.method){client.send({id:m.id,result:{decision:'accept'}});}else events.push(m);
 },()=>{},env);
 await client.request('initialize',{clientInfo:{name:'gateway_outage_e2e',version:'1'},capabilities:{experimentalApi:true}});client.send({method:'initialized',params:{}});
 return client;
}
function tree(pid){const all=[pid];for(let i=0;i<all.length;i++){try{all.push(...execFileSync('/usr/bin/pgrep',['-P',String(all[i])],{encoding:'utf8'}).split('\n').filter(Boolean).map(Number));}catch{}}return all;}
let client;
try{
 const events=[];client=await connect(events);
 const start=await client.request('thread/start',{model:options.model,cwd:work,approvalPolicy:'never',sandbox:'workspace-write',config:{model_reasoning_effort:options.effort}});const id=start.thread.id;
 const objective=`Create files step1.txt through step${steps}.txt in ${work}. Use one separate shell command per file, in order, each writing only its step number. After all ${steps} exist, mark the goal complete.`;
 await client.request('thread/goal/set',{threadId:id,objective,status:'active',origin:'user',tokenBudget:400000});
 const auto=await wait(()=>events.find(e=>e.method==='turn/started'),15000);
 if(!auto)await client.request('turn/start',{threadId:id,input:[{type:'text',text:'Work on the active goal now.'}]});
 await record({phase:'goal-started',passed:true,model:options.model,effort:options.effort,autoStartedTurn:!!auto});
 const progressed=await wait(async()=>(await done())>=2&&(await done())<steps);
 const before=await done();const pids=tree(client.child.pid);
 for(const pid of pids){try{process.kill(pid,'SIGKILL');}catch{}}
 await delay(1000);const survivors=pids.filter(pid=>{try{process.kill(pid,0);return true;}catch{return false;}});
 await record({phase:'power-cut-mid-goal',passed:!!progressed&&survivors.length===0,filesBeforeCut:before,killedProcesses:pids.length,survivors:survivors.length});
 const events2=[];client=await connect(events2);
 const resumed=await client.request('thread/resume',{threadId:id});
 const goal=(await client.request('thread/goal/get',{threadId:id})).goal;
 await record({phase:'goal-survives-power-cut',passed:goal?.objective===objective&&resumed.model===options.model,goalStatus:goal?.status,model:resumed.model});
 const autoResumed=await wait(()=>events2.find(e=>e.method==='turn/started'),30000);
 if(!autoResumed)await client.request('turn/start',{threadId:id,input:[{type:'text',text:'Continue the active goal from where it stopped.'}]});
 const finished=await wait(async()=>(await done())===steps&&(await client.request('thread/goal/get',{threadId:id})).goal?.status==='complete');
 const finalGoal=(await client.request('thread/goal/get',{threadId:id})).goal;
 const history=await client.request('thread/read',{threadId:id,includeTurns:true});
 await record({phase:'goal-continues-to-completion',passed:!!finished,autoResumedAfterRestart:!!autoResumed,files:await done(),goalStatus:finalGoal?.status,turns:history.thread?.turns?.length,turnStatuses:(history.thread?.turns||[]).map(t=>t.status),upstreamRequests:requests});
}catch(e){await record({phase:'error',passed:false,error:e.message});}
finally{client?.stop();server.closeAllConnections();server.close();}
const failed=results.filter(r=>!r.passed);if(failed.length)process.exitCode=1;
