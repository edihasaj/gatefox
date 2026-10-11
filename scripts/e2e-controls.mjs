import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {once} from 'node:events';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {AppServerConnection} from '../dist/app-server-connection.js';
const {values:options}=parseArgs({options:{gateway:{type:'string'},config:{type:'string'},codex:{type:'string'},catalog:{type:'string'},fixture:{type:'string'},output:{type:'string'},models:{type:'string',default:'claude/claude-sonnet-5-5,codex/gpt-6.1-sol'}}});
for(const key of ['gateway','config','codex','catalog','fixture','output'])if(!options[key])throw Error(`Missing --${key}`);
const models=options.models.split(',');if(models.length!==2)throw Error('Specify two gateway models for the active switching test');
const upstream=JSON.parse(await readFile(resolve(options.config),'utf8'));
const root=resolve(options.fixture);await mkdir(root,{recursive:true,mode:0o700});
const home=join(root,'native');const state=join(root,'state');const work=join(root,'work');
for(const p of [home,state,work])await mkdir(p,{recursive:true,mode:0o700});
await copyFile(resolve(options.catalog),join(home,'models.json'));
await copyFile(resolve(upstream.stateDirectory,'client-token'),join(state,'client-token'));
await writeFile(join(home,'config.toml'),`model_catalog_json = "${join(home,'models.json')}"\n`,{mode:0o600});
await writeFile(join(work,'AGENTS.md'),'This is an isolated control test. Use only this fixture. No delegation. Goal state is managed by the test client.\n');
const requests=[];
const server=createServer(async(req,res)=>{
 const control=new AbortController();res.on('close',()=>control.abort());
 try{
  const chunks=[];let bytes=0;for await(const c of req){bytes+=c.length;if(bytes>16*1024*1024)throw Error('Fixture request too large');chunks.push(c);}
  const body=Buffer.concat(chunks);
  if(req.url==='/v1/responses')requests.push(JSON.parse(body.toString()).model);
  const r=await fetch(`http://127.0.0.1:${upstream.port}`+req.url,{method:req.method,headers:{authorization:req.headers.authorization,'content-type':'application/json'},...(body.length?{body}:{}),signal:control.signal});
  res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/json'});
  if(r.body)await pipeline(Readable.fromWeb(r.body),res);else res.end();
 }catch{if(!res.headersSent)res.writeHead(502);res.end();}
});server.listen(0,'127.0.0.1');await once(server,'listening');
const config=join(root,'gateway.json');await writeFile(config,JSON.stringify({version:1,clientOnly:true,port:server.address().port,stateDirectory:state,providers:[]}),{mode:0o600});
const results=[];const events=[];let client;
const record=async row=>{results.push(row);await writeFile(resolve(options.output),JSON.stringify({results},null,2),{mode:0o600});console.log(JSON.stringify(row));};
const wait=async check=>{for(let i=0;i<2400;i++){const v=check();if(v)return v;await delay(50);}throw Error('Control verification timed out');};
const digest=async()=>createHash('sha256').update(await readFile(join(home,'config.toml'))).digest('hex');const before=await digest();
const env={...process.env,CODEX_HOME:home};for(const k of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'])delete env[k];
try{
 client=new AppServerConnection(resolve(options.gateway),['codex-shim','--config',config,'--codex',resolve(options.codex),'--','app-server','--listen','stdio://'],async m=>{
  if(m.id!==undefined&&m.method){events.push({method:m.method,params:m.params,serverRequest:true});client.send({id:m.id,result:{decision:'decline'}});}else events.push(m);
 },()=>{},env);
 await client.request('initialize',{clientInfo:{name:'gateway_control_e2e',version:'0.2.5'},capabilities:{experimentalApi:true}});client.send({method:'initialized',params:{}});
 for(const model of models){
  const start=await client.request('thread/start',{model,cwd:work,approvalPolicy:'on-request',sandbox:'read-only'});const id=start.thread.id;
  const objective='Fixture goal '+randomUUID();
  try{
   const set=await client.request('thread/goal/set',{threadId:id,objective,status:'paused',origin:'user',tokenBudget:10000});
   assert.equal(set.goal.objective,objective);assert.equal((await client.request('thread/goal/get',{threadId:id})).goal.status,'paused');
   assert.ok(events.some(e=>e.method==='thread/goal/updated'&&e.params?.threadId===id));
   await record({model,phase:'goal-create-read-notification',passed:true});
  }catch(e){await record({model,phase:'goal-create-read-notification',passed:false,error:e.message});}
  const offset=events.length;const turn=await client.request('turn/start',{threadId:id,input:[{type:'text',text:'Run the command tool once with sleep 6, then reply ORIGINAL_DONE. Do not modify files.'}],effort:'low'});
  await wait(()=>events.slice(offset).find(e=>e.method==='item/started'&&e.params?.item?.type==='commandExecution'));
  const changed=models.find(value=>value!==model);
  try{
   const settings=await client.request('thread/settings/update',{threadId:id,model:changed,effort:'low',approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});
   await record({model,phase:'mid-turn-thread-settings',passed:true,responseKeys:Object.keys(settings)});
  }catch(e){await record({model,phase:'mid-turn-thread-settings',passed:false,error:e.message});}
  const activeRequestOffset=requests.length;
  try{await client.request('turn/settings/update',{threadId:id,turnId:turn.turn.id,model:changed,effort:'low'});await record({model,phase:'active-turn-model-update',passed:true});}catch(e){await record({model,phase:'active-turn-model-update',passed:false,error:e.message});}
  const marker='STEER_'+randomUUID();
  try{
   const steered=await client.request('turn/steer',{threadId:id,expectedTurnId:turn.turn.id,input:[{type:'text',text:`After the command finishes, reply exactly ${marker}. Omit ORIGINAL_DONE.`}]});
   assert.equal(steered.turnId,turn.turn.id);
   await wait(()=>events.slice(offset).find(e=>e.method==='turn/completed'&&e.params?.turn?.id===turn.turn.id));
   const text=events.slice(offset).filter(e=>e.method==='item/agentMessage/delta').map(e=>e.params.delta).join('');
   await record({model,phase:'mid-turn-steering',passed:text.includes(marker),sameTurn:true,newTurnEvents:events.slice(offset).filter(e=>e.method==='turn/started').length});
   await record({model,phase:'current-turn-model-next-step',passed:requests.slice(activeRequestOffset).length>0&&requests.slice(activeRequestOffset).every(m=>m===changed),actualModels:requests.slice(activeRequestOffset),expectedModel:changed});
  }catch(e){await record({model,phase:'mid-turn-steering',passed:false,error:e.message});await client.request('turn/interrupt',{threadId:id,turnId:turn.turn.id}).catch(()=>{});}
  const offset2=events.length;const reqOffset=requests.length;const proof='ACCESS_'+randomUUID();const target=join(root,'outside-work-'+randomUUID()+'.txt');
  const follow=await client.request('turn/start',{threadId:id,input:[{type:'text',text:`Use the command tool to write exactly ${proof} to ${target}, then report it. This is part of the owned fixture.`}]});
  const done=await wait(()=>events.slice(offset2).find(e=>e.method==='turn/completed'&&e.params?.turn?.id===follow.turn.id));
  const written=await readFile(target,'utf8').then(s=>s.trim()===proof,()=>false);
  await record({model,phase:'sticky-model-and-full-access',passed:done.params.turn.status==='completed'&&written&&requests.slice(reqOffset).every(m=>m===changed),written,actualModels:requests.slice(reqOffset),expectedModel:changed,approvalRequests:events.slice(offset2).filter(e=>e.serverRequest).length});
  const resumed=await client.request('thread/resume',{threadId:id});await record({model,phase:'model-survives-resume-without-override',passed:resumed.model===changed,actualModel:resumed.model,expectedModel:changed});
  await client.request('thread/settings/update',{threadId:id,approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly'}});
  const denied=join(root,'denied-'+randomUUID()+'.txt');const off=events.length;
  const restricted=await client.request('turn/start',{threadId:id,input:[{type:'text',text:`Use the command tool to write FORBIDDEN_FIXTURE_WRITE to ${denied}. If denied, stop immediately and report denial.`}]});
  await wait(()=>events.slice(off).find(e=>e.method==='turn/completed'&&e.params?.turn?.id===restricted.turn.id));
  await record({model,phase:'permission-downgrade',passed:await readFile(denied).then(()=>false,()=>true),approvalRequests:events.slice(off).filter(e=>e.serverRequest).length});
  try{
   await client.request('thread/goal/clear',{threadId:id});assert.equal((await client.request('thread/goal/get',{threadId:id})).goal,null);
   await record({model,phase:'goal-clear',passed:true});
  }catch(e){await record({model,phase:'goal-clear',passed:false,error:e.message});}
 }
 await record({phase:'isolation',passed:await digest()===before});
 if(results.some(row=>!row.passed))process.exitCode=1;
}catch(e){await record({phase:'execution',passed:false,error:e.message});process.exitCode=1;}
finally{client?.stop();await client?.exited;server.closeAllConnections();server.close();}
