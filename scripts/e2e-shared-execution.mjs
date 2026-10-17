import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {appendFileSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {mkdir, readFile, readdir, rm, writeFile, realpath, lstat, readlink, stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {homedir} from 'node:os';
import {dirname, resolve, sep} from 'node:path';
import {createInterface} from 'node:readline';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs, promisify} from 'node:util';
import {loadConfig, readClientToken, writePrivateJson} from '../dist/config.js';
import {executionHostHome} from '../dist/execution-host.js';
import {sdkSocketTarget, setExecutionHostRootForTests} from '../dist/execution-host-storage.js';
import {setNativeOwnerRootForTests} from '../dist/native-execution-host-storage.js';
import {watchHostKick} from '../dist/execution-host-kick.js';
import {servicePlanPath} from '../dist/service-plan.js';
import {SocketAppServerConnection} from '../dist/socket-app-server-connection.js';
import {groupGone} from './group-gone.mjs';

const {values:v}=parseArgs({options:{help:{type:'boolean',default:false},gateway:{type:'string'},config:{type:'string'},codex:{type:'string'},'native-home':{type:'string'},workspace:{type:'string'},output:{type:'string'},models:{type:'string',default:'claude/claude-sonnet-5-5,codex/gpt-6.1-sol,qwen/qwen3.8-flash-next'},inference:{type:'boolean',default:false},image:{type:'string'},expected:{type:'string'}}});
if(v.help){console.log(`Usage: node scripts/e2e-shared-execution.mjs --gateway COMMAND --config SOURCE_CONFIG --codex PINNED_SDK --native-home ISOLATED_HOME --workspace DIR --output FILE [--models a,b] [--inference [--image PNG --expected TEXT]]
The source config's gateway must be running and serve every --models alias in its catalog. Its state, the workspace and the native home share one isolated
fixture folder, and the native home holds no auth.json. Without --inference no provider request is made; the host restart phase answers its turns locally.`);process.exit(0);}
for(const key of ['gateway','config','codex','native-home','workspace','output'])if(!v[key])throw new Error(`Missing --${key}`);
if(Boolean(v.image)!==Boolean(v.expected)||v.image&&!v.inference)throw new Error('--image and --expected require each other and --inference');
// Every process this check starts leads a process group of its own (an adapter with its private engine, the host with its gateway
// engines) and stays listed until that group is empty. No exit path leaves one behind: success and failure stop them in order, a
// signal or an uncaught error does the same with a deadline, and the exit handler SIGKILLs whatever group is still there.
const groups=new Set();
// Each group is also listed in the fake home's `.groups`, for the reaper below, and announced gone from it as `-<pid>` once it empties.
function startGroup(command,args,options){const child=spawn(command,args,{...options,detached:true});if(child.pid){const leader=child.pid;groups.add(leader);try{appendFileSync(resolve(fakeHome,'.groups'),leader+'\n',{mode:0o600});}catch{}child.once('close',()=>{void groupGone(leader,10000).then(gone=>{if(!gone)return;groups.delete(leader);try{appendFileSync(resolve(fakeHome,'.groups'),'-'+leader+'\n',{mode:0o600});}catch{}});});}return child;}
const killGroups=signal=>{for(const leader of groups){try{process.kill(-leader,signal);}catch{groups.delete(leader);}}};
/** After its leader is gone, a group gets a moment to empty on its own; whatever is left of it is SIGKILLed. */
const reapGroup=async(leader,ms)=>{if(!await groupGone(leader,ms))try{process.kill(-leader,'SIGKILL');}catch{}await groupGone(leader,5000);};
// Host folders and native-home receipts live under a short private home of this run's own, never the real ~/.local/state. The
// pinned SDK still puts its sockets in its fixed /tmp/codex-daemon-<uid> folder; every one of them is removed again by the
// host's own stop, or by the next host's claim after the restart phase.
const fakeHome=mkdtempSync(process.platform==='win32'?resolve(homedir(),'gwe-'):'/tmp/gwe-');
const removeFakeHome=()=>{try{rmSync(fakeHome,{recursive:true,force:true,maxRetries:5,retryDelay:50});}catch{}};
// A SIGKILL of this check runs none of its cleanup. A detached reaper in a group of its own watches this process and, once it is
// gone, kills the listed groups, removes the SDK sockets of this run's links that nothing serves with their .lock files, and the
// fake home (scripts/e2e-reaper.mjs). A normal end stops the reaper first.
const sdkRoot=process.platform==='win32'?undefined:resolve(realpathSync('/tmp'),`codex-daemon-${process.getuid()}`);
const reaper=sdkRoot?spawn(process.execPath,[new URL('./e2e-reaper.mjs',import.meta.url).pathname,String(process.pid),fakeHome,sdkRoot],{detached:true,stdio:'ignore'}):undefined;reaper?.unref();
process.on('exit',()=>{try{reaper?.kill('SIGTERM');}catch{}killGroups('SIGKILL');removeFakeHome();});
setExecutionHostRootForTests(resolve(fakeHome,'.local/state/gw-exec'));setNativeOwnerRootForTests(resolve(fakeHome,'.local/state/gw-native'));
let cleanup=async()=>{};let stopping;
const stop=code=>stopping??=(async()=>{process.exitCode=code;await Promise.race([cleanup().catch(()=>{}),delay(15000)]);killGroups('SIGKILL');process.exit(code);})();
for(const [name,number] of [['SIGINT',2],['SIGTERM',15],['SIGHUP',1]])process.on(name,()=>{void stop(128+number);});
for(const event of ['uncaughtException','unhandledRejection'])process.on(event,error=>{console.error(JSON.stringify({uncaught:event,errorClass:error?.name||'Error'}));void stop(1);});
const nativeHome=resolve(v['native-home']);const fixture=dirname(nativeHome);const workspace=resolve(v.workspace,'shared-'+randomUUID());
if(await realpath(nativeHome)===(await realpath(resolve(homedir(),'.codex')).catch(()=>resolve(homedir(),'.codex'))))throw new Error('The native Codex home cannot be used for this isolated check');
const sourceConfig=await loadConfig(resolve(v.config));
const inside=path=>resolve(path).startsWith(fixture+sep);
if(!inside(workspace)||!inside(sourceConfig.stateDirectory)||await lstat(resolve(nativeHome,'auth.json')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw new Error('Use isolated native home, workspace and gateway state without copied native credentials');
const nativeConfig=resolve(nativeHome,'config.toml');const nativeBefore=await readFile(nativeConfig);
const run=resolve(fixture,'shared-execution-'+randomUUID());await mkdir(run,{mode:0o700});await mkdir(workspace,{recursive:true,mode:0o700});
const output=resolve(v.output);await mkdir(dirname(output),{recursive:true,mode:0o700});
const sdk=await realpath(resolve(v.codex));
if(process.platform==='darwin')await promisify(execFile)('/usr/bin/codesign',['--verify','--strict',sdk]);
const version=(await promisify(execFile)(sdk,['--version'])).stdout.trim();assert.equal(version,'codex-cli 0.162.0-alpha.17.2');
const token=await readClientToken(resolve(sourceConfig.stateDirectory,'client-token'));
const origin=`http://127.0.0.1:${sourceConfig.port}`;
let catalogGeneration=0;let catalogAvailable=true;let inferenceRequests=0;const inferenceStatuses=[];const results=[];let phase='setup';let fixtureTurns=false;let fixtureResponses=0;
const fixtureText='HOST_RESTART_FIXTURE_OK';
/** Without --inference the restart phase still needs a saved chat: this answers its turns here, in the gateway's own stream shape, and never reaches a provider. */
function fixtureStream(response){
  const id='resp_'+randomUUID().replaceAll('-','');const item='msg_'+randomUUID().replaceAll('-','');const created=Math.floor(Date.now()/1000);let sequence=0;
  const usage={input_tokens:1,output_tokens:1,total_tokens:2};const part={type:'output_text',text:fixtureText,annotations:[]};
  const message={type:'message',id:item,role:'assistant',status:'completed',content:[part]};const coordinates={item_id:item,output_index:0,content_index:0};
  const frames=[{type:'response.created',response:{object:'response',id,created_at:created,model:'fixture',status:'in_progress',usage,output:[]}},
    {type:'response.output_item.added',output_index:0,item:{type:'message',id:item,role:'assistant',status:'in_progress',content:[]}},
    {type:'response.content_part.added',...coordinates,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',...coordinates,delta:fixtureText},
    {type:'response.output_text.done',...coordinates,text:fixtureText},{type:'response.content_part.done',...coordinates,part},{type:'response.output_item.done',output_index:0,item:message},
    {type:'response.completed',response:{object:'response',id,created_at:created,model:'fixture',status:'completed',usage,output:[message],output_text:fixtureText}}];
  response.writeHead(200,{'content-type':'text/event-stream'});for(const frame of frames)response.write(`event: ${frame.type}\ndata: ${JSON.stringify({...frame,sequence_number:sequence++})}\n\n`);response.end();
}
const record=data=>{results.push(data);return writeFile(output,JSON.stringify({checkedAt:new Date().toISOString(),sdkVersion:version,inferenceEnabled:v.inference,results},null,2)+'\n',{mode:0o600}).then(()=>console.log(JSON.stringify(data)));};
const proxy=createServer((request,response)=>{
  void(async()=>{
    const supplied=Buffer.from(request.headers.authorization||'');const expected=Buffer.from(`Bearer ${token}`);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){response.writeHead(401);response.end();return;}
    const url=new URL(request.url||'/',origin);
    if(url.origin!==origin||!['/v1/model-catalog','/v1/models','/v1/responses'].includes(url.pathname)||url.search){response.writeHead(404);response.end();return;}
    if(url.pathname==='/v1/model-catalog'&&!catalogAvailable){response.writeHead(503);response.end();return;}
    if(url.pathname==='/v1/responses'&&fixtureTurns&&!v.inference){fixtureResponses++;for await(const _chunk of request);fixtureStream(response);return;}
    if(url.pathname==='/v1/responses'){inferenceRequests++;if(!v.inference){response.writeHead(503);response.end();return;}}
    const abort=new AbortController();request.on('aborted',()=>abort.abort());response.on('close',()=>{if(!response.writableEnded)abort.abort();});
    const upstream=await fetch(url,{method:request.method,headers:{Authorization:`Bearer ${token}`,...(request.headers['content-type']?{'content-type':request.headers['content-type']}:{})},...(request.method==='POST'?{body:request,duplex:'half'}:{}),redirect:'error',signal:abort.signal});
    if(url.pathname==='/v1/responses')inferenceStatuses.push(upstream.status);
    if(url.pathname==='/v1/model-catalog'){
      assert.equal(upstream.status,200);const reader=upstream.body.getReader();let bytes=0;const chunks=[];
      try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>1024*1024)throw new Error('Catalog bound');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      const catalog=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(catalogGeneration)catalog.models=catalog.models.map(model=>({...model,display_name:model.display_name+' [isolated generation '+catalogGeneration+']'}));
      response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(catalog));return;
    }
    response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'application/json'});
    if(upstream.body)await pipeline(Readable.fromWeb(upstream.body),response);else response.end();
  })().catch(()=>{if(!response.headersSent)response.writeHead(502);response.end();});
});
await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
const configPath=resolve(run,'gateway.json');const config={version:1,clientOnly:true,providers:[],port:proxy.address().port,stateDirectory:resolve(run,'state'),timeoutMs:180000};
await writePrivateJson(configPath,config);await mkdir(config.stateDirectory,{mode:0o700});await writeFile(resolve(config.stateDirectory,'client-token'),token+'\n',{mode:0o600});
// The plan a service with shared executors runs from: adapters then require the host, wait for it while it restarts, and kick it.
await writePrivateJson(servicePlanPath(config.stateDirectory),{version:1,config:configPath,sharedExecutors:true,components:[{id:'native',kind:'native',command:process.execPath,args:['--codex',sdk,'--native-home',nativeHome],log:resolve(run,'native.log')}]});
const hostHome=executionHostHome(configPath,nativeHome);let host;let control;const clients=new Set();
// Every host this run started, from its spawn on: the restart phase's replacement belongs here before it is `host`, so a stop in
// that window still closes it (and its control socket in the SDK's fixed folder) instead of leaving it to the final SIGKILL.
const hosts=new Set();
let cleaned;
cleanup=()=>cleaned??=(async()=>{
  await Promise.allSettled([...clients].map(client=>client.close()));
  await Promise.allSettled([...hosts].map(entry=>entry.stop()));control?.stop();await removeKilledEngineLocks().catch(()=>{});
  const closed=new Promise(resolve=>proxy.close(resolve));proxy.closeAllConnections();await closed;
})();
const childEnv=()=>{const env={...process.env,HOME:fakeHome,CODEX_HOME:nativeHome,CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED:'1'};for(const key of ['CODEX_API_KEY','OPENAI_API_KEY','OPENAI_BASE_URL'])delete env[key];return env;};
// The host runs as its own process, as it does inside the service, so the restart phase can SIGKILL it with its engines.
const hostRunner=`const [hostUrl,configUrl,options]=[process.argv[1],process.argv[2],JSON.parse(process.argv[3])];
const {startExecutionHost}=await import(hostUrl);const {loadConfig}=await import(configUrl);
const parent=process.ppid;let starting;let closing;
// A stop while the host is still starting waits for that start, so it closes a host that got as far as its control socket.
const close=(code,orphaned=false)=>closing??=(async()=>{try{await (await starting?.catch(()=>undefined))?.close();}catch{code=1;}
  // A check that was SIGKILLed cannot remove its private home: the host it left removes it after stopping its engines.
  if(orphaned){const {rm}=await import('node:fs/promises');await rm(options.home,{recursive:true,force:true}).catch(()=>{});}process.exit(code);})();
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>{void close(0);});
setInterval(()=>{if(process.ppid!==parent)void close(0,true);},1000).unref();
try{starting=loadConfig(options.configPath).then(config=>startExecutionHost({config,configPath:options.configPath,nativeHome:options.nativeHome,codex:options.codex}));await starting;}
catch{if(!closing){process.stdout.write('HOST_FAILED\\n');process.exit(1);}}
if(closing)await closing;
process.stdout.write('HOST_READY\\n');`;
async function startHost(){
  const child=startGroup(process.execPath,['--input-type=module','-e',hostRunner,new URL('../dist/execution-host.js',import.meta.url).href,new URL('../dist/config.js',import.meta.url).href,JSON.stringify({configPath,nativeHome,codex:sdk,home:fakeHome})],{env:childEnv(),stdio:['ignore','pipe','ignore']});
  const exited=new Promise(resolve=>child.once('close',resolve));const lines=createInterface({input:child.stdout});let connection;let stopping;
  const entry={pid:child.pid,exited,stop:()=>stopping??=(async()=>{if(connection&&control===connection){control.stop();await control.exited;}child.kill('SIGTERM');if(!await Promise.race([exited.then(()=>true),delay(10000).then(()=>false)]))try{process.kill(-child.pid,'SIGKILL');}catch{}await reapGroup(child.pid,5000);hosts.delete(entry);})()};
  hosts.add(entry);
  const ready=await new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),30000);lines.once('line',line=>{clearTimeout(timer);resolve(line==='HOST_READY');});void exited.then(()=>{clearTimeout(timer);resolve(false);});});
  if(!ready){await entry.stop();throw new Error('Execution host did not start');}
  connection=new SocketAppServerConnection(resolve(hostHome,'host.sock'),async()=>{});await connection.ready;control=connection;
  return entry;
}
function connect(){
  const command=resolve(v.gateway);const args=['codex-shim','--config',configPath,'--codex',sdk,'--','app-server','--listen','stdio://'];
  const child=startGroup(command.endsWith('.js')?process.execPath:command,command.endsWith('.js')?[command,...args]:args,{env:childEnv(),cwd:workspace,stdio:['pipe','pipe','ignore']});
  const pending=new Map();const events=[];let sequence=0;let closed=false;let stopping;const lines=createInterface({input:child.stdout});
  const exited=new Promise(resolve=>child.once('close',()=>{closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Adapter closed'));}pending.clear();resolve();}));
  child.on('error',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Adapter unavailable'));}pending.clear();});
  lines.on('line',line=>{
    let message;try{message=JSON.parse(line);}catch{child.kill('SIGTERM');return;}
    const p=pending.get(message.id);
    if(p){pending.delete(message.id);clearTimeout(p.timer);if(message.error)p.reject(Object.assign(new Error('RPC failed'),{code:message.error.code}));else p.resolve(message.result);}
    else if(message.method&&message.id!==undefined)child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'No external test tool handler'}})+'\n');
    else if(message.method)events.push(message);
  });
  child.stdin.on('error',()=>{});
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{if(closed){reject(new Error('Adapter closed'));return;}const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout'));},180000).unref();pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  const client={rpc,events,notify:(method,params={})=>child.stdin.write(JSON.stringify({method,params})+'\n'),close:()=>stopping||=(async()=>{if(!closed){child.stdin.end();child.kill('SIGTERM');const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},2000).unref();await exited;clearTimeout(timer);}lines.close();await reapGroup(child.pid,3000);clients.delete(client);})()};clients.add(client);return client;
}
async function initialize(client){await client.rpc('initialize',{clientInfo:{name:'gateway_shared_execution_e2e',version:'1'},capabilities:{experimentalApi:true}});client.notify('initialized');}
// Every generation socket this run's engines listened on: the pinned SDK keeps a `<socket>.lock` beside each physical socket in its
// fixed folder and removes it only when it stops cleanly, so the ones the restart phase's SIGKILL left are removed at the end.
const generationSockets=new Set();
async function status(){const value=await control.request('execution/status',{});for(const item of value.generations??[])if(typeof item.socketPath==='string')generationSockets.add(item.socketPath);return value;}
async function removeKilledEngineLocks(){
  for(const path of generationSockets){
    let target;try{target=await sdkSocketTarget(path);}catch{continue;}
    // Only a lock whose socket is gone: its engine was ours (the name hashes this run's private path) and every engine has stopped.
    if(await lstat(target).then(()=>true,()=>false))continue;
    const lock=await lstat(target+'.lock').catch(()=>undefined);
    if(lock?.isFile()&&lock.uid===process.getuid?.()&&lock.size===0)await rm(target+'.lock',{force:true});
  }
}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
const generation=(state,revision)=>state.generations.find(value=>value.revision===revision);
async function owner(threadId){const value=await control.request('execution/find',{threadId});assert.notEqual(value.found,false);return value;}
async function resume(client,id,model,cwd=workspace){let last;for(let attempt=0;attempt<20;attempt++){try{return await client.rpc('thread/resume',{threadId:id,model,cwd,approvalPolicy:'never',sandbox:'read-only'});}catch(error){last=error;await delay(100);}}throw last;}
async function waitTurn(client,turnId,offset,expected='completed'){
  const deadline=Date.now()+180000;let event;
  while(!(event=client.events.slice(offset).find(value=>value.method==='turn/completed'&&value.params.turn.id===turnId))&&Date.now()<deadline)await delay(50);
  if(event?.params.turn.status!==expected){const info=event?.params.turn.error?.codexErrorInfo;await record({phase:phase+'-turn-status',passed:false,status:event?.params.turn.status||'timeout',codexErrorKinds:typeof info==='string'?[info]:info&&typeof info==='object'?Object.keys(info):[],inferenceStatuses:inferenceStatuses.slice(-4),toolTypes:[...new Set(client.events.slice(offset).filter(value=>value.method==='item/completed').map(value=>value.params.item?.type).filter(Boolean))]});}
  assert.equal(event?.params.turn.status,expected);return client.events.slice(offset);
}
async function completed(client,id,model,text,image){const offset=client.events.length;const start=await client.rpc('turn/start',{threadId:id,model,effort:'low',input:[{type:'text',text},...(image?[{type:'localImage',path:image}]:[])]});return waitTurn(client,start.turn.id,offset);}
async function instructions(directory){
  await mkdir(directory,{recursive:true,mode:0o700});const seed=randomUUID();const instruction=randomUUID();
  await writeFile(resolve(directory,'seed.txt'),seed+'\n',{mode:0o600});
  await writeFile(resolve(directory,'AGENTS.md'),`This is an isolated gateway test. Do not delegate. Work only in this directory. When asked to verify this workspace, read seed.txt and write proof.txt containing the seed followed by the marker ${instruction}. For follow-up requests, follow the user and preserve existing proof.txt content.\n`,{mode:0o600});
  return async()=>{const proof=await readFile(resolve(directory,'proof.txt'),'utf8');assert.ok(proof.includes(seed));assert.ok(proof.includes(instruction));};
}
const text=events=>events.filter(event=>event.method==='item/agentMessage/delta').map(event=>event.params.delta).join('');
const toolEvidence=events=>events.some(event=>event.method==='item/completed'&&['commandExecution','fileChange'].includes(event.params.item?.type));
try{
  phase='host-start';host=await startHost();
  const first=connect();const second=connect();phase='adapter-init';await Promise.all([initialize(first),initialize(second)]);phase='model-catalog-read';
  const catalog=await first.rpc('model/list',{limit:100});const offered=new Set(catalog.data.map(value=>value.model));
  for(const model of v.models.split(','))assert.ok(offered.has(model));
  await record({phase:'signed-sdk-and-two-adapters',passed:true,modelCount:offered.size});
  const model=v.models.split(',')[0];phase='start-shared-chat';
  const verifyInitial=v.inference?await instructions(workspace):undefined;
  const start=await first.rpc('thread/start',{model,cwd:workspace,approvalPolicy:'never',sandbox:v.inference?'danger-full-access':'read-only'});assert.equal(start.modelProvider,'subscription_gateway');const id=start.thread.id;
  const original=await owner(id);const state=await status();assert.equal(state.generations.length,1);const originalPid=generation(state,original.revision).pid;assert.ok(originalPid>0);
  // The SDK does not materialize a durable rollout until the first real turn.
  // Metadata-only probes prove live ownership but deliberately do not claim resume.
  if(v.inference){phase='persist-first-real-turn';const events=await completed(first,id,model,'Verify this workspace as its instructions direct.');await verifyInitial();assert.ok(toolEvidence(events));await record({phase:'first-provider-tools-and-instructions',model,passed:true,filesReadAndWritten:true,agentsLoaded:true});}
  phase='second-adapter-owner';
  if(v.inference){const resumed=await resume(second,id,model);assert.equal(resumed.thread.id,id);}
  else{const independent=await second.rpc('thread/start',{model,cwd:workspace,approvalPolicy:'never',sandbox:'read-only'});assert.equal((await owner(independent.thread.id)).revision,original.revision);await second.rpc('thread/settings/update',{threadId:id,effort:'low'});}
  assert.equal((await owner(id)).socketPath,original.socketPath);assert.equal(generation(await status(),original.revision).pid,originalPid);
  await record({phase:'two-adapters-one-loaded-chat',passed:true,sameEnginePid:true,sameGeneration:true,resumeTested:v.inference});
  phase='offline-catalog-new-adapter';catalogAvailable=false;const outage=connect();await initialize(outage);
  const offlineModels=await outage.rpc('model/list',{limit:100});assert.deepEqual(new Set(offlineModels.data.map(value=>value.model)),offered);
  const beforeNative=await outage.rpc('thread/loaded/list',{});const beforeAccount=await outage.rpc('account/read',{});const beforeEngines=await status();const beforeResponses=inferenceRequests;
  await assert.rejects(outage.rpc('thread/start',{model,cwd:workspace,approvalPolicy:'never',sandbox:'read-only'}),error=>error.code===-32001);
  assert.equal(inferenceRequests,beforeResponses);assert.deepEqual((await status()).generations,beforeEngines.generations);
  assert.deepEqual(await outage.rpc('thread/loaded/list',{}),beforeNative);assert.deepEqual(await outage.rpc('account/read',{}),beforeAccount);
  await record({phase:'offline-new-adapter-catalog',passed:true,modelsRetained:offered.size,applicationErrorCode:-32001,noInferenceRequests:true,noNewExecutor:true,noNativeFallback:true});
  phase='catalog-recovery';catalogAvailable=true;const recovered=await outage.rpc('model/list',{limit:100});assert.deepEqual(new Set(recovered.data.map(value=>value.model)),offered);
  const recoveredChat=await outage.rpc('thread/start',{model,cwd:workspace,approvalPolicy:'never',sandbox:'read-only'});assert.equal(recoveredChat.modelProvider,'subscription_gateway');assert.equal((await owner(recoveredChat.thread.id)).revision,original.revision);assert.equal(generation(await status(),original.revision).pid,originalPid);await outage.close();
  await record({phase:'catalog-recovery-without-app-restart',passed:true,modelsRetained:offered.size,sameExecutorPid:true});
  phase='adapter-disconnect';await first.close();assert.equal(generation(await status(),original.revision).pid,originalPid);
  const third=connect();await initialize(third);phase='reconnect-loaded-owner';
  if(v.inference)assert.equal((await resume(third,id,model)).thread.id,id);else{await third.rpc('thread/start',{model,cwd:workspace,approvalPolicy:'never',sandbox:'read-only'});await third.rpc('thread/settings/update',{threadId:id,effort:'low'});}
  assert.equal(generation(await status(),original.revision).pid,originalPid);
  await record({phase:'adapter-reconnect',passed:true,loadedOwnerPreserved:true,sameEnginePid:true,resumeTested:v.inference});
  phase='catalog-generation';catalogGeneration=1;await delay(1100);await third.rpc('model/list',{limit:100});
  const newer=await third.rpc('thread/start',{model,cwd:workspace,approvalPolicy:'never',sandbox:'read-only'});const current=await owner(newer.thread.id);assert.notEqual(current.revision,original.revision);assert.equal(generation(await status(),original.revision).pid,originalPid);
  const lockPaths=[original,current].map(value=>resolve(config.stateDirectory,'desktop-generations','shared-v1-'+value.revision,'desktop-engine','thread-writer-locks'));
  for(const path of lockPaths)assert.equal(await readlink(path),resolve(nativeHome,'thread-writer-locks'));
  const lockA=await stat(lockPaths[0]);const lockB=await stat(lockPaths[1]);assert.equal(lockA.ino,lockB.ino);assert.equal(lockA.dev,lockB.dev);
  const fourth=connect();await initialize(fourth);if(v.inference)assert.equal((await resume(fourth,id,model)).thread.id,id);else await fourth.rpc('thread/settings/update',{threadId:id,effort:'low'});assert.equal((await owner(id)).revision,original.revision);
  await record({phase:'catalog-change-retains-loaded-owner',passed:true,generations:(await status()).generations.length,sameLockNamespace:true});
  for(catalogGeneration=2;catalogGeneration<=3;catalogGeneration++){phase='generation-cap-fill-'+catalogGeneration;await delay(1100);await third.rpc('model/list',{limit:100});await third.rpc('thread/start',{model,cwd:workspace,approvalPolicy:'never',sandbox:'read-only'});}
  phase='generation-cap-refusal';catalogGeneration=4;await delay(1100);await third.rpc('model/list',{limit:100});await assert.rejects(third.rpc('thread/start',{model,cwd:workspace,approvalPolicy:'never',sandbox:'read-only'}));assert.equal((await status()).generations.length,4);assert.equal(generation(await status(),original.revision).pid,originalPid);
  phase='generation-cap-unsubscribe';await third.rpc('thread/unsubscribe',{threadId:newer.thread.id});await control.request('execution/release',{revision:current.revision});phase='generation-cap-retirement';
  // The pinned SDK retains unsubscribed threads for its own 60-second idle delay.
  // Respect that owner; never force unload, archive or rewrite its saved history.
  const inspection=new SocketAppServerConnection(current.socketPath,async()=>{});const unloadStart=Date.now();let retained=false;
  try{
    await inspection.request('initialize',{clientInfo:{name:'shared_retirement_inspection',version:'1'},capabilities:{experimentalApi:true}});inspection.send({method:'initialized'});
    let loaded=await inspection.request('thread/loaded/list',{});retained=loaded.data.includes(newer.thread.id);await record({phase:'generation-sdk-idle-retention',passed:true,waitingForSDKUnload:retained});
    while(loaded.data.includes(newer.thread.id)&&Date.now()-unloadStart<90000){await delay(500);loaded=await inspection.request('thread/loaded/list',{});}
    assert.equal(loaded.data.includes(newer.thread.id),false);
  }finally{inspection.stop();await inspection.exited;}
  const replacement=await third.rpc('thread/start',{model,cwd:workspace,approvalPolicy:'never',sandbox:'read-only'});
  assert.ok(replacement.thread.id);assert.equal((await status()).generations.length,4);assert.equal(generation(await status(),original.revision).pid,originalPid);
  await record({phase:'generation-cap-and-owned-retirement',passed:true,cap:4,loadedOriginalPreserved:true,unsubscribedGenerationRetired:true,retainedUntilSDKUnload:retained,idleRetentionMs:Date.now()-unloadStart});
  if(v.inference)for(const alias of v.models.split(',')){
    phase='inference-'+alias;const directory=resolve(workspace,'provider-'+randomUUID());const verify=await instructions(directory);const chat=await third.rpc('thread/start',{model:alias,cwd:directory,approvalPolicy:'never',sandbox:'danger-full-access'});
    const initial=await completed(third,chat.thread.id,alias,'Verify this workspace as its instructions direct.');await verify();assert.ok(toolEvidence(initial));
    const reconnect=connect();await initialize(reconnect);await resume(reconnect,chat.thread.id,alias,directory);
    await reconnect.rpc('thread/settings/update',{threadId:chat.thread.id,approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});
    const marker=randomUUID();const events=await completed(reconnect,chat.thread.id,alias,'Read proof.txt and append exactly '+marker+' on its own new line. Preserve its existing content.');await verify();assert.ok((await readFile(resolve(directory,'proof.txt'),'utf8')).includes(marker));assert.ok(toolEvidence(events));
    await record({phase:'real-provider-follow-up',model:alias,passed:true,historyPreserved:true,agentsLoaded:true,filesReadAndEdited:true});
    phase='cancel-'+alias;const offset=third.events.length;const long=await third.rpc('turn/start',{threadId:chat.thread.id,model:alias,effort:'low',input:[{type:'text',text:'Write 2000 numbered paragraphs about trees. Begin immediately. Do not use tools.'}]});
    const deadline=Date.now()+180000;while(!third.events.slice(offset).some(event=>event.method==='item/agentMessage/delta')&&Date.now()<deadline)await delay(25);
    assert.ok(third.events.slice(offset).some(event=>event.method==='item/agentMessage/delta'));await reconnect.rpc('turn/interrupt',{threadId:chat.thread.id,turnId:long.turn.id});await waitTurn(third,long.turn.id,offset,'interrupted');
    const recovered=await completed(reconnect,chat.thread.id,alias,'Reply exactly RECOVERED_OK. Do not use tools.');assert.ok(text(recovered).includes('RECOVERED_OK'));await verify();
    await record({phase:'cross-adapter-cancel-and-recover',model:alias,passed:true,status:'interrupted',originalProofPreserved:true});
    if(v.image&&!alias.startsWith('qwen/')){
      phase='image-'+alias;const image=resolve(directory,'fixture.png');await writeFile(image,await readFile(resolve(v.image)),{mode:0o600});
      const picture=await completed(reconnect,chat.thread.id,alias,'Read the code in the attached picture and describe its shapes. Do not use tools.',image);assert.ok(text(picture).includes(v.expected));
      await reconnect.close();const imageClient=connect();await initialize(imageClient);await resume(imageClient,chat.thread.id,alias,directory);const history=await completed(imageClient,chat.thread.id,alias,'Repeat the code from the earlier image. Do not use tools.');assert.ok(text(history).includes(v.expected));await imageClient.close();
      await record({phase:'image-history-across-adapters',model:alias,passed:true,codeAbsentFromPrompt:true});
    }else await reconnect.close();
  }
  // The service's host is SIGKILLed while a chat is idle. Like launchd ending the service, the kill takes the host's whole process
  // group, its gateway engines with it. The connected adapter's next request finds the host dead, kicks the service and waits; the
  // replacement starts on that kick (as the service would), reclaims the dead receipt, and the same chat resumes and runs a turn.
  phase='host-restart-chat';let restartChat=id;
  if(!v.inference){fixtureTurns=true;restartChat=(await third.rpc('thread/start',{model,cwd:workspace,approvalPolicy:'never',sandbox:'read-only'})).thread.id;assert.ok(text(await completed(third,restartChat,model,'Reply with the fixture text. Do not use tools.')).includes(fixtureText));}
  else assert.ok(text(await completed(third,restartChat,model,'Reply exactly HOST_IDLE_OK. Do not use tools.')).includes('HOST_IDLE_OK'));
  phase='host-sigkill';const before=await status();const killedPids=[host.pid,...before.generations.map(value=>value.pid).filter(pid=>pid>0)];
  // Watching starts before the kill, so the adapter's kick can never land before the watch began.
  let restarted;let restartedOnKick=false;const startReplacement=()=>restarted??=startHost();
  const stopWatch=watchHostKick(hostHome,()=>{if(!restarted)restartedOnKick=true;void startReplacement().catch(()=>{});});
  control.stop();await control.exited;process.kill(-host.pid,'SIGKILL');await host.exited;assert.ok(await groupGone(host.pid,10000));
  for(const pid of killedPids)assert.equal(alive(pid),false);
  const fallback=setTimeout(()=>{void startReplacement().catch(()=>{});},8000);
  phase='host-restart-resume';let resumed;
  try{resumed=await third.rpc('thread/resume',{threadId:restartChat,model,cwd:workspace,approvalPolicy:'never',sandbox:v.inference?'danger-full-access':'read-only'});}
  finally{clearTimeout(fallback);stopWatch();}
  host=await restarted;assert.equal(resumed.thread.id,restartChat);assert.ok(restartedOnKick,'the replacement started on the adapter kick');assert.notEqual(host.pid,killedPids[0]);
  const archived=(await readdir(resolve(hostHome,'stale'))).filter(name=>/^owner-\d+\.json$/.test(name));assert.ok(archived.length>=1);
  phase='host-restart-turn';const follow=await completed(third,restartChat,model,v.inference?'Reply exactly HOST_RESTART_OK. Do not use tools.':'Reply with the fixture text. Do not use tools.');
  assert.ok(text(follow).includes(v.inference?'HOST_RESTART_OK':fixtureText));fixtureTurns=false;
  const after=await status();assert.ok(after.generations.every(value=>!killedPids.includes(value.pid)));
  await record({phase:'host-sigkill-restart',passed:true,killedProcesses:killedPids.length,noOrphanedEngines:true,restartedOnKick,deadReceiptArchived:true,sameChatResumed:true,followUpTurnCompleted:true,fixtureResponses});
  phase='invariants';assert.deepEqual(await readFile(nativeConfig),nativeBefore);if(!v.inference)assert.equal(inferenceRequests,0);
  const receipts=(await status()).generations;
  for(const receipt of receipts)await assert.rejects(lstat(resolve(config.stateDirectory,'desktop-generations','shared-v1-'+receipt.revision,'desktop-engine','auth.json')),{code:'ENOENT'});
  await record({phase:'invariants',passed:true,nativeConfigUnchanged:true,nativeAuthNotCopied:true,inferenceRequests,noInferenceProbe:!v.inference});
}catch(error){await record({phase,passed:false,errorClass:error?.name||'Error',...(typeof error?.code==='number'?{rpcCode:error.code}:{})});process.exitCode=1;}
finally{await cleanup();}
