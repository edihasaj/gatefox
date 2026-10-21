// Proves an active Codex goal continues automatically on the new model after the chat's
// gateway model is switched mid-goal with thread/settings/update, as the picker does:
// the next turn must start by itself and its inference requests must go out on the new
// model. Real inference with both subscriptions through the built dist, in an isolated
// native home. Pass the native model cache (~/.codex/models_cache.json) as --catalog,
// never the gateway catalog, or the aliases route as native models. Example:
// node scripts/e2e-goal-switch.mjs --gateway ~/.local/bin/gateway --config "$HOME/Library/Application Support/Subscription Gateway/gateway.json" --codex /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --catalog ~/.codex/models_cache.json --fixture FRESH_DIR/fixture --output FRESH_DIR/goal-switch.json
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {once} from 'node:events';
import {mkdir,readFile,writeFile,copyFile,readdir,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {AppServerConnection} from '../dist/app-server-connection.js';
const {values:options}=parseArgs({options:{gateway:{type:'string'},config:{type:'string'},codex:{type:'string'},catalog:{type:'string'},fixture:{type:'string'},output:{type:'string'},from:{type:'string',default:'claude/claude-opus-5-5'},to:{type:'string',default:'codex/gpt-6.1-sol'},effort:{type:'string',default:'high'},steps:{type:'string',default:'4'},'switch-after':{type:'string',default:'1'}}});
for(const key of ['gateway','config','codex','catalog','fixture','output'])if(!options[key])throw Error(`Missing --${key}`);
if(options.from===options.to)throw Error('--from and --to must name different models.');
const steps=Number(options.steps),switchAfter=Number(options['switch-after']);
if(!Number.isInteger(steps)||steps<=0)throw Error('--steps must be a positive integer.');
if(!Number.isInteger(switchAfter)||switchAfter<=0)throw Error('--switch-after must be a positive integer.');
if(steps<=switchAfter)throw Error('--steps must be greater than --switch-after so the switch lands while the goal is still active.');
const upstream=JSON.parse(await readFile(resolve(options.config),'utf8'));
const root=resolve(options.fixture);const home=join(root,'native'),state=join(root,'state'),work=join(root,'work');
for(const p of [home,state,work])await mkdir(p,{recursive:true,mode:0o700});
await copyFile(resolve(options.catalog),join(home,'models.json'));
await copyFile(resolve(upstream.stateDirectory,'client-token'),join(state,'client-token'));
await writeFile(join(home,'config.toml'),`model_catalog_json = "${join(home,'models.json')}"\n`,{mode:0o600});
// One row per /v1/responses call: the model string the SDK sent (when the body parsed) and
// the chat header used for attribution. Bodies, headers and credentials are never logged.
const requests=[];
const server=createServer(async(req,res)=>{
 const control=new AbortController();res.on('close',()=>control.abort());
 try{
  const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
  if(req.url?.startsWith('/v1/responses')){let model='unparsed';try{const parsed=JSON.parse(body.toString());if(typeof parsed.model==='string')model=parsed.model;}catch{}
   requests.push({at:Date.now(),model,chat:req.headers['thread-id']||req.headers['session-id']});}
  const r=await fetch(`http://127.0.0.1:${upstream.port}`+req.url,{method:req.method,headers:{authorization:req.headers.authorization,'content-type':'application/json',...(req.headers['session-id']?{'session-id':req.headers['session-id']}:{}),...(req.headers['thread-id']?{'thread-id':req.headers['thread-id']}:{})},...(body.length?{body}:{}),signal:control.signal});
  res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/json'});
  if(r.body)await pipeline(Readable.fromWeb(r.body),res);else res.end();
 }catch{if(!res.headersSent)res.writeHead(502);res.end();}
});server.listen(0,'127.0.0.1');await once(server,'listening');
const config=join(root,'gateway.json');await writeFile(config,JSON.stringify({version:1,clientOnly:true,port:server.address().port,stateDirectory:state,providers:[]}),{mode:0o600});
const env={...process.env,CODEX_HOME:home};for(const k of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'])delete env[k];
const out=resolve(options.output);const results=[];const record=async row=>{results.push(row);await writeFile(out,JSON.stringify({results},null,2),{mode:0o600});await chmod(out,0o600);console.log(JSON.stringify(row));};
const wait=async(check,ms=600000)=>{for(const end=Date.now()+ms;Date.now()<end;){const v=await check();if(v)return v;await delay(250);}return undefined;};
const modelCounts=(rows,from=0,end=Infinity)=>{const out={};for(const r of rows)if(r.at>=from&&r.at<end){const key=r.model;out[key]=(out[key]||0)+1;}return out;};
let client;
try{
 const events=[];
 client=new AppServerConnection(resolve(options.gateway),['codex-shim','--config',config,'--codex',resolve(options.codex),'--','app-server','--listen','stdio://'],async m=>{
  if(m.id!==undefined&&m.method){client.send({id:m.id,result:{decision:'accept'}});}else events.push({...m,receivedAt:Date.now()});
 },()=>{},env);
 await client.request('initialize',{clientInfo:{name:'gateway_goal_switch_e2e',version:'1'},capabilities:{experimentalApi:true}});client.send({method:'initialized',params:{}});
 const start=await client.request('thread/start',{model:options.from,cwd:work,approvalPolicy:'never',sandbox:'workspace-write',config:{model_reasoning_effort:options.effort}});const id=start.thread.id;
 const objective=`Create files step1.txt through step${steps}.txt in ${work}, exactly one file per turn. In each turn, create only the lowest-numbered missing file with one shell command that writes only its step number, then end the turn with a one-line progress note. Do not create more than one file in a turn. After all ${steps} files exist, mark the goal complete.`;
 await client.request('thread/goal/set',{threadId:id,objective,status:'active',origin:'user',tokenBudget:400000});
 const done=async()=>{const names=new Set(await readdir(work));return Array.from({length:steps},(_,i)=>`step${i+1}.txt`).filter(n=>names.has(n)).length;};
 // Requests that carried a thread or session header are attributed to this chat by id; when
 // none carried either, every request is treated as this chat's and attributed says false.
 const reqs=()=>{const attributed=requests.some(r=>r.chat!==undefined);return {attributed,rows:attributed?requests.filter(r=>r.chat===id):requests};};
 const manualStarts=[];
 const completedNotice=()=>events.some(e=>e.method==='thread/goal/updated'&&e.params?.threadId===id&&e.params?.goal?.status==='complete');
 const auto=await wait(()=>events.find(e=>e.method==='turn/started'&&e.params?.threadId===id),15000);
 if(!auto){manualStarts.push(Date.now());await client.request('turn/start',{threadId:id,input:[{type:'text',text:'Work on the active goal now.'}]});}
 await record({phase:'goal-started',passed:true,model:options.from,effort:options.effort,steps,switchAfter,autoStartedTurn:!!auto,manualTurnStarts:manualStarts.length});
 const reached=await wait(async()=>{const d=await done();return d>=switchAfter&&d;});
 const {rows,attributed}=reqs();const before=modelCounts(rows);
 await record({phase:'progress-on-from',passed:!!reached&&(before[options.from]||0)>=1&&(before[options.to]||0)===0,filesDone:await done(),chatRequestsFrom:before[options.from]||0,chatRequestsTo:before[options.to]||0,attributed});
 const switchAt=Date.now();
 const ended=new Set(events.filter(e=>e.method==='turn/completed'&&e.params?.threadId===id&&e.receivedAt<switchAt).map(e=>e.params?.turn?.id));
 const turnRunningAtSwitch=events.some(e=>e.method==='turn/started'&&e.params?.threadId===id&&e.receivedAt<=switchAt&&!ended.has(e.params?.turn?.id));
 await client.request('thread/settings/update',{threadId:id,model:options.to,effort:options.effort});
 const applied=await wait(()=>events.find(e=>e.method==='thread/settings/updated'&&e.params?.threadId===id&&e.params?.threadSettings?.model===options.to),30000);
 const goalNow=(await client.request('thread/goal/get',{threadId:id})).goal;
 if(goalNow?.status==='complete'||completedNotice()||(await done())===steps)throw Error(`The goal completed (possibly already cleared) before the switch could land mid-goal; raise --steps (now ${steps}).`);
 await record({phase:'switch-applied',passed:!!applied&&goalNow?.status==='active'&&goalNow?.objective===objective,turnRunningAtSwitch,goalStatus:goalNow?.status});
 const next=await wait(()=>events.find(e=>e.method==='turn/started'&&e.params?.threadId===id&&e.receivedAt>switchAt));const t2=next?.receivedAt;
 await record({phase:'automatic-turn-after-switch',passed:!!next&&!manualStarts.some(t=>t>switchAt),autoContinuedTurn:!!next,manualTurnStarts:manualStarts.length});
 // Stop at once when the goal leaves `active` for anything but completion (for example `blocked` after a failed turn).
 const settled=await wait(async()=>{const all=(await done())===steps;if(all&&completedNotice())return 'complete';const status=(await client.request('thread/goal/get',{threadId:id})).goal?.status;
  if(status==='complete')return all?'complete':undefined;return typeof status==='string'&&status!=='active'?status:undefined;});
 const finished=settled==='complete';
 const finalGoal=(await client.request('thread/goal/get',{threadId:id})).goal;
 const {rows:after,attributed:attributedAfter}=reqs();
 const onTo=t2===undefined?{}:modelCounts(after,t2);
 // This phase proves routing: the continuation's requests left on the new model. Whether that turn succeeded is reported beside it.
 const continuationStatus=next?events.find(e=>e.method==='turn/completed'&&e.params?.threadId===id&&e.params?.turn?.id===next.params?.turn?.id)?.params?.turn?.status??'running':undefined;
 await record({phase:'continuation-runs-on-to',passed:t2!==undefined&&(onTo[options.to]||0)>=1&&(onTo[options.from]||0)===0,checks:'routing',continuationTurnStatus:continuationStatus,modelCounts:onTo,attributed:attributedAfter,fromRequestsAfterSwitchBeforeNextTurn:after.filter(r=>r.at>=switchAt&&r.at<(t2??Infinity)&&r.model===options.from).length});
 const startedTurns=events.filter(e=>e.method==='turn/started'&&e.params?.threadId===id).sort((a,b)=>a.receivedAt-b.receivedAt);
 const turnStatus=new Map(events.filter(e=>e.method==='turn/completed'&&e.params?.threadId===id).map(e=>[e.params?.turn?.id,e.params?.turn?.status]));
 const turns=startedTurns.map((e,i)=>({turnId:e.params?.turn?.id,status:turnStatus.get(e.params?.turn?.id)??'running',modelCounts:modelCounts(after,e.receivedAt,startedTurns[i+1]?.receivedAt??Infinity)}));
 await record({phase:'goal-completes',passed:finished,files:await done(),goalStatus:finalGoal?.status??(completedNotice()?'complete (cleared)':undefined),stoppedOn:settled??'timeout',turns});
}catch(e){await record({phase:'error',passed:false,error:e.message});}
finally{client?.stop();server.closeAllConnections();server.close();}
if(results.some(r=>!r.passed))process.exitCode=1;
