import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {mkdir, readFile, writeFile, realpath, lstat, readlink, stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {homedir} from 'node:os';
import {dirname, resolve, sep} from 'node:path';
import {createInterface} from 'node:readline';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs, promisify} from 'node:util';
import {loadConfig, readClientToken, writePrivateJson} from '../dist/config.js';
import {startExecutionHost, executionHostHome} from '../dist/execution-host.js';
import {SocketAppServerConnection} from '../dist/socket-app-server-connection.js';

const {values:v}=parseArgs({options:{gateway:{type:'string'},config:{type:'string'},codex:{type:'string'},'native-home':{type:'string'},workspace:{type:'string'},output:{type:'string'},models:{type:'string',default:'claude/claude-sonnet-5-5,codex/gpt-6.1-sol,qwen/qwen3.8-flash-next'},inference:{type:'boolean',default:false},image:{type:'string'},expected:{type:'string'}}});
for(const key of ['gateway','config','codex','native-home','workspace','output'])if(!v[key])throw new Error(`Missing --${key}`);
if(Boolean(v.image)!==Boolean(v.expected)||v.image&&!v.inference)throw new Error('--image and --expected require each other and --inference');
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
let catalogGeneration=0;let catalogAvailable=true;let inferenceRequests=0;const inferenceStatuses=[];const results=[];let phase='setup';
const record=data=>{results.push(data);return writeFile(output,JSON.stringify({checkedAt:new Date().toISOString(),sdkVersion:version,inferenceEnabled:v.inference,results},null,2)+'\n',{mode:0o600}).then(()=>console.log(JSON.stringify(data)));};
const proxy=createServer((request,response)=>{
  void(async()=>{
    const supplied=Buffer.from(request.headers.authorization||'');const expected=Buffer.from(`Bearer ${token}`);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){response.writeHead(401);response.end();return;}
    const url=new URL(request.url||'/',origin);
    if(url.origin!==origin||!['/v1/model-catalog','/v1/models','/v1/responses'].includes(url.pathname)||url.search){response.writeHead(404);response.end();return;}
    if(url.pathname==='/v1/model-catalog'&&!catalogAvailable){response.writeHead(503);response.end();return;}
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
const hostHome=executionHostHome(configPath,nativeHome);let host;let control;const clients=new Set();
function connect(){
  const command=resolve(v.gateway);const args=['codex-shim','--config',configPath,'--codex',sdk,'--','app-server','--listen','stdio://'];
  const env={...process.env,CODEX_HOME:nativeHome,CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED:'1'};for(const key of ['CODEX_API_KEY','OPENAI_API_KEY','OPENAI_BASE_URL'])delete env[key];
  const child=spawn(command.endsWith('.js')?process.execPath:command,command.endsWith('.js')?[command,...args]:args,{env,cwd:workspace,stdio:['pipe','pipe','ignore']});
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
  const client={rpc,events,notify:(method,params={})=>child.stdin.write(JSON.stringify({method,params})+'\n'),close:()=>stopping||=(async()=>{if(!closed){child.stdin.end();child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000).unref();await exited;clearTimeout(timer);}lines.close();clients.delete(client);})()};clients.add(client);return client;
}
async function initialize(client){await client.rpc('initialize',{clientInfo:{name:'gateway_shared_execution_e2e',version:'1'},capabilities:{experimentalApi:true}});client.notify('initialized');}
async function status(){return control.request('execution/status',{});}
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
  phase='host-start';host=await startExecutionHost({config,configPath,nativeHome,codex:sdk});
  control=new SocketAppServerConnection(resolve(hostHome,'host.sock'),async()=>{});await control.ready;
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
  phase='invariants';assert.deepEqual(await readFile(nativeConfig),nativeBefore);if(!v.inference)assert.equal(inferenceRequests,0);
  const receipts=(await status()).generations;
  for(const receipt of receipts)await assert.rejects(lstat(resolve(config.stateDirectory,'desktop-generations','shared-v1-'+receipt.revision,'desktop-engine','auth.json')),{code:'ENOENT'});
  await record({phase:'invariants',passed:true,nativeConfigUnchanged:true,nativeAuthNotCopied:true,inferenceRequests,noInferenceProbe:!v.inference});
}catch(error){await record({phase,passed:false,errorClass:error?.name||'Error',...(typeof error?.code==='number'?{rpcCode:error.code}:{})});process.exitCode=1;}
finally{
  await Promise.allSettled([...clients].map(client=>client.close()));control?.stop();if(control)await control.exited;await host?.close();
  const closed=new Promise(resolve=>proxy.close(resolve));proxy.closeAllConnections();await closed;
}
