import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';

const {values:v}=parseArgs({options:{gateway:{type:'string'},config:{type:'string'},codex:{type:'string'},'native-home':{type:'string'},workspace:{type:'string'},output:{type:'string'},models:{type:'string',default:'claude/claude-sonnet-5-5,codex/gpt-6.1-sol,qwen/qwen3.8-flash-next'}}});
for(const key of ['gateway','config','codex','native-home','workspace','output'])if(!v[key])throw new Error(`Missing --${key}`);
const fixture=dirname(resolve(v['native-home']));const configuration=JSON.parse(readFileSync(resolve(v.config),'utf8'));
const state=resolve(dirname(resolve(v.config)),configuration.stateDirectory);
if(!state.startsWith(fixture+sep)||!resolve(v.workspace).startsWith(fixture+sep)||existsSync(resolve(v['native-home'],'auth.json')))throw new Error('Use an isolated native home, workspace, and gateway state directory without copied native credentials');
mkdirSync(resolve(v.workspace),{recursive:true});
const digest=()=>createHash('sha256').update(readFileSync(resolve(v['native-home'],'config.toml'))).digest('hex');const before=digest();
const results=[];const saved=[];
const record=(data)=>{results.push(data);writeFileSync(resolve(v.output),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));console.log(JSON.stringify(data));};
function connect(){
  const child=spawn(resolve(v.gateway),['codex-shim','--config',resolve(v.config),'--codex',resolve(v.codex),'--','app-server','--listen','stdio://'],{env:{...process.env,CODEX_HOME:resolve(v['native-home'])},cwd:resolve(v.workspace),stdio:['pipe','pipe','ignore']});
  const pending=new Map();const events=[];let sequence=0;const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{const m=JSON.parse(line);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}else if(m.method&&m.id!==undefined)child.stdin.write(JSON.stringify({id:m.id,error:{code:-32601,message:'No external test tool handler'}})+'\n');else if(m.method)events.push(m);});
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out`));},120000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  const close=()=>new Promise(resolve=>{child.once('close',resolve);child.stdin.end();child.kill('SIGTERM');lines.close();for(const p of pending.values())clearTimeout(p.timer);});
  return{rpc,events,close,notify:(method,params={})=>child.stdin.write(JSON.stringify({method,params})+'\n')};
}
async function initialize(client){await client.rpc('initialize',{clientInfo:{name:'gateway_titles_e2e',version:'0.2.7'},capabilities:{experimentalApi:true}});client.notify('initialized');}
async function completeTurn(client,threadId,model,prompt){
  const offset=client.events.length;const turn=await client.rpc('turn/start',{threadId,model,effort:'low',input:[{type:'text',text:prompt}]});
  const end=Date.now()+120000;let completed;while(!(completed=client.events.slice(offset).find(e=>e.method==='turn/completed'&&e.params.turn.id===turn.turn.id))&&Date.now()<end)await delay(100);
  assert.equal(completed?.params.turn.status,'completed',completed?.params.turn.error?.message);
  return client.events.slice(offset);
}
const titleItem=event=>['item/started','item/completed'].includes(event.method)&&event.params.item?.tool==='gateway_chat_title';
let client=connect();
try{
  await initialize(client);
  const settings=(await client.rpc('config/read',{})).config;
  assert.ok(settings.model_providers.subscription_gateway);assert.equal(settings.model_provider??'openai','openai');
  record({phase:'native-provider-registration',passed:true,nativeDefaultPreserved:true});
  for(const model of v.models.split(',')){
    const title='Agent title '+randomUUID().slice(0,8);const start=await client.rpc('thread/start',{model,cwd:resolve(v.workspace),approvalPolicy:'never',sandbox:'read-only'});assert.equal(start.modelProvider,'subscription_gateway');
    const initial=await completeTurn(client,start.thread.id,model,'Explain what a loop does in one sentence.');
    assert.ok(!initial.some(titleItem),'ordinary chat must not invoke the title helper');
    assert.ok(!initial.some(e=>e.method==='thread/name/updated'),'ordinary model turn must not rename the chat');
    record({phase:'ordinary-first-turn',model,passed:true,noTitleTool:true,noAgentRename:true});
    const appTitle='App title '+randomUUID().slice(0,8);await client.rpc('thread/name/set',{threadId:start.thread.id,name:appTitle});
    assert.equal((await client.rpc('thread/read',{threadId:start.thread.id,includeTurns:false})).thread.name,appTitle);
    const followup=await completeTurn(client,start.thread.id,model,'Give one example of a loop in everyday life.');
    assert.ok(!followup.some(titleItem));
    assert.equal((await client.rpc('thread/read',{threadId:start.thread.id,includeTurns:false})).thread.name,appTitle);
    record({phase:'app-owned-title',model,passed:true,appRenameAccepted:true,titlePreserved:true});
    const events=await completeTurn(client,start.thread.id,model,`Use gateway_chat_title to read the current title, rename this chat to exactly "${title}", then read it again. Do not use other tools. After all three title calls succeed, reply exactly: title-ok.`);
    assert.ok(events.some(titleItem),'explicit title request must expose its real tool event');
    const read=await client.rpc('thread/read',{threadId:start.thread.id,includeTurns:false});assert.equal(read.thread.name,title);
    const updates=events.filter(e=>e.method==='thread/name/updated'&&e.params.threadId===start.thread.id);assert.ok(updates.some(e=>e.params.threadName===title));
    saved.push({id:start.thread.id,title,model});record({phase:'agent-title-tool',model,passed:true,savedTitleRead:true,liveNameNotification:true});
  }
  await client.close();client=connect();await initialize(client);
  for(const chat of saved){const read=await client.rpc('thread/read',{threadId:chat.id,includeTurns:false});assert.equal(read.thread.name,chat.title);await client.rpc('thread/resume',{threadId:chat.id,model:chat.model,cwd:resolve(v.workspace),approvalPolicy:'never',sandbox:'read-only'});record({phase:'saved-chat-resume',model:chat.model,passed:true,titlePreserved:true});}
  assert.equal(digest(),before);record({phase:'verification',passed:true,nativeConfigUnchanged:true});
}catch(error){record({phase:'verification',passed:false,error:error.message});process.exitCode=1;}finally{await client.close();}
