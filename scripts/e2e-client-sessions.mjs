// Real Claude Code and the installed Codex SDK, with synthetic Claude inference only.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

const {values}=parseArgs({options:{package:{type:'string'},claude:{type:'string'},code:{type:'string'},root:{type:'string'},fixture:{type:'string'}}});
for(const name of ['package','claude','root'])assert.ok(values[name],'Pass --'+name);
const output=resolve(values.root),code=resolve(values.code??'.'),pkg=resolve(values.package),claude=await fs.realpath(values.claude);
await fs.mkdir(output,{mode:0o700});
const protectedFiles=[join(homedir(),'.codex/config.toml'),join(homedir(),'.claude/settings.json'),join(homedir(),'.claude.json')];
const digest=async path=>{try{return createHash('sha256').update(await fs.readFile(path)).digest('hex')}catch(error){if(error.code==='ENOENT')return null;throw error}};
const before=await Promise.all(protectedFiles.map(digest));
const scratch=await fs.realpath(await fs.mkdtemp('/tmp/gwcs-'));
await fs.writeFile(join(scratch,'package.json'),'{}\n',{mode:0o600});
const home=join(scratch,'home'),native=join(scratch,'codex'),work=join(scratch,'work');
for(const path of [home,native,work])await fs.mkdir(path,{mode:0o700});
// These overrides apply only to this isolated test process and its children.
process.env.HOME=home;process.env.CODEX_HOME=native;process.env.TMPDIR=scratch;
delete process.env.GATEWAY_TELEMETRY;process.env.GATEWAY_ERROR_REPORTS='off';
const load=name=>import(pathToFileURL(join(code,'dist',name+'.js')));
const {gatewaySdkRuntime}=await load('gateway-sdk-runtime');
const runtime=await gatewaySdkRuntime(pkg);assert.ok(runtime?.executorIdentity,'Use the verified installed SDK');
const {startGateway}=await load('server'),{gatewayToken}=await load('config'),{modelCatalog}=await load('catalog');
const {ClaudeSubscription}=await load('providers/claude'),{claudeLive}=await load('providers/claude-live');
const {flushUsageLedger}=await load('usage-ledger');
const {configureTelemetry,flushTelemetry,readTelemetry}=await load('telemetry');
const telemetryRoot=join(scratch,'telemetry');configureTelemetry(telemetryRoot,'test');
// Release archives omit tests; a retained fixture can independently verify installed code.
const {installClaudeFixture}=await import(pathToFileURL(values.fixture?resolve(values.fixture):join(code,'dist/tests/claude-cli-fixture.js')));
const fixture=await installClaudeFixture();
const alias='fixture/claude',observed=[],failures=[],dimensions=[];
const config={version:1,port:0,stateDirectory:join(scratch,'state'),providers:[{id:'fixture',type:'claude-subscription',models:{[alias]:'fixture'},
 claudeSessions:{mode:'live',warmup:0},modelMetadata:{[alias]:{contextWindow:131072,reasoningEfforts:['low','medium','high']}}}]};
const gateway=await startGateway(config,provider=>{
 const backend=new ClaudeSubscription(provider);
 return {async *infer(request,signal,context){observed.push({protocol:context.clientProtocol,session:!!context.sessionId,thread:!!context.threadId});
  const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,12);
  dimensions.push({identity:hash([context.threadId,context.sessionId]),effort:request.reasoning?.effort,tier:request.service_tier,
   tools:hash(request.tools),leading:(Array.isArray(request.input)?request.input:[]).filter(item=>item.role==='system'||item.role==='developer').map(item=>{
    const text=typeof item.content==='string'?item.content:JSON.stringify(item.content);
    return {billing:text.includes('x-anthropic-billing-header:'),length:text.length,digest:hash(item)};
   })});
  yield*backend.infer(request,signal,context)}};
},undefined,{onFailure(failure){failures.push(failure.code)}});
const base='http://127.0.0.1:'+gateway.address().port,token=await gatewayToken(config.stateDirectory);
const childEnv=Object.fromEntries(['PATH','LANG','LC_ALL','USER','LOGNAME','SHELL'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
Object.assign(childEnv,{HOME:home,TMPDIR:scratch,DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'});
const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
let client,lines,phase='setup',passed=false;const notifications=[],pending=new Map();let sequence=0;
const rpc=(method,params={})=>new Promise((resolveRpc,reject)=>{
 const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Fixture RPC timeout'))},30000);
 pending.set(id,{resolve:value=>{clearTimeout(timer);resolveRpc(value)},reject:error=>{clearTimeout(timer);reject(error)}});
 client.stdin.write(JSON.stringify({id,method,params})+'\n');
});
async function waitFor(check){const deadline=Date.now()+45000;while(Date.now()<deadline){const value=check();if(value)return value;await delay(20)}throw Error('Fixture turn timeout')}
const proof={passed:false,noPaidInference:true,clients:[]};
try{
 phase='claude-code';
 const path=join(work,'claude-proof.txt'),value=randomUUID();
 await fixture.setScenario({cache:true,replies:[{calls:[{tool:'Write',input:{file_path:path,content:value}}]},
  {calls:[{tool:'Read',input:{file_path:path}}]},{text:'CLAUDE_CLIENT_SESSION_OK'}]});
 const start=await fixture.capture(),offset=observed.length;
 const matcher=path.replace(/^\//,'//');
 const settings=join(home,'claude-settings.json');
 await fs.writeFile(settings,JSON.stringify({permissions:{allow:[`Read(${matcher})`,`Edit(${matcher})`]}}),{mode:0o600});
 const args=['--settings',settings,'--print','--model',alias,'--output-format','stream-json','--verbose','--setting-sources','',
  '--tools','Read,Write','--permission-mode','dontAsk','--allowedTools',`Read(${matcher}),Edit(${matcher})`,'--max-turns','8',
  '--disable-slash-commands','--strict-mcp-config','--mcp-config',JSON.stringify({mcpServers:{}}),'--no-session-persistence'];
 const cli=spawn(claude,args,{cwd:work,env:{...childEnv,ANTHROPIC_BASE_URL:base,ANTHROPIC_API_KEY:token},stdio:['pipe','pipe','ignore']});
 client=cli;const messages=[];lines=createInterface({input:cli.stdout});
 lines.on('line',line=>{if(messages.length<4096){try{messages.push(JSON.parse(line))}catch{}}});
 const completion=new Promise((resolveChild,reject)=>{cli.once('error',reject);cli.once('close',resolveChild)});
 cli.stdin.end('Use Write to create the requested proof file, then Read it, then answer.');
 let timeout;
 const exit=await Promise.race([completion,new Promise((_,reject)=>{timeout=setTimeout(()=>{cli.kill('SIGKILL');reject(Error('Claude Code fixture timeout'))},60000)})]).finally(()=>clearTimeout(timeout));
 phase='claude-code-exit';proof.claudeExit=exit;proof.claudeEventTypes=[...new Set(messages.map(message=>message.type))];proof.gatewayFailureCodes=failures;
 proof.nativeToolCalls=messages.flatMap(message=>message.message?.content??[]).filter(part=>part.type==='tool_use').map(part=>({name:part.name,pathMatches:part.input?.file_path===path,contentMatches:part.input?.content===value}));
 proof.nativeToolErrors=messages.flatMap(message=>message.message?.content??[]).filter(part=>part.type==='tool_result'&&part.is_error).map(part=>{
  const text=JSON.stringify(part.content);return {permission:/permission|not allowed|denied/i.test(text),input:/invalid|parameter|input/i.test(text),readRequired:/read.*first|not.*read|must.*read/i.test(text),missing:/not exist|not found/i.test(text),length:text.length};
 });
 assert.equal(exit,0);phase='claude-code-proof';assert.equal((await fs.readFile(path,'utf8')).trimEnd(),value);
 phase='claude-code-result';proof.claudeResultFlags=messages.filter(message=>message.type==='result').map(message=>({error:!!message.is_error,subtype:message.subtype}));
 assert.ok(messages.some(message=>message.type==='result'&&!message.is_error));
 phase='claude-code-identity';const calls=observed.slice(offset);proof.claudeRouting=calls;assert.equal(calls.length,3);assert.ok(calls.every(call=>call.protocol==='messages'&&call.session&&!call.thread));
 phase='claude-code-session';const started=(await fixture.capture()).slice(start.length).filter(row=>row.start);proof.claudeProviderModes=started.map(row=>row.start);assert.equal(started.length,1);assert.equal(started[0].start,'live');
 proof.clients.push({client:'Claude Code',requests:calls.length,providerProcesses:1,toolWriteReadVerified:true,nativeMetadataContinuity:true});
 lines.close();client=undefined;

 phase='codex-app-server';
 const codexPath=join(work,'codex-proof.txt'),codexValue=randomUUID();
 await fixture.setScenario({cache:true,replies:[{calls:[{tool:'exec_command',input:{cmd:`/usr/bin/printf %s ${quote(codexValue)} > ${quote(codexPath)}`,yield_time_ms:1000,max_output_tokens:100}}]},
  {text:'CODEX_CLIENT_SESSION_OK'},{text:'CODEX_FOLLOWUP_OK'}]});
 const codexStart=(await fixture.capture()).length,codexOffset=observed.length;
 await fs.writeFile(join(native,'models.json'),JSON.stringify(modelCatalog(config)),{mode:0o600});
 await fs.writeFile(join(native,'config.toml'),[
  `model = "${alias}"`,'model_provider = "subscription_gateway"','model_reasoning_effort = "medium"',
  'model_catalog_json = '+JSON.stringify(join(native,'models.json')),'web_search = "disabled"',
  '[model_providers.subscription_gateway]','name = "Continuity fixture"','base_url = '+JSON.stringify(base+'/v1'),
  'wire_api = "responses"','env_key = "GATEWAY_CLIENT_SESSION_FIXTURE_KEY"','supports_websockets = false',
  'request_max_retries = 0','stream_max_retries = 0','[features]','remote_control = false',
 ].join('\n')+'\n',{mode:0o600});
 assert.equal(spawnSync('git',['init','--quiet',work],{env:childEnv}).status,0);
 client=spawn(runtime.executable,['app-server','--listen','stdio://'],{cwd:work,env:{...childEnv,CODEX_HOME:native,
  CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED:'1',GATEWAY_CLIENT_SESSION_FIXTURE_KEY:token},stdio:['pipe','pipe','ignore']});
 client.stdin.on('error',()=>{});lines=createInterface({input:client.stdout});
 client.once('exit',()=>{for(const entry of pending.values())entry.reject(Error('Fixture SDK exited'));pending.clear()});
 lines.on('line',line=>{try{
  const message=JSON.parse(line),entry=pending.get(message.id);
  if(entry){pending.delete(message.id);message.error?entry.reject(Error('Fixture SDK RPC failed')):entry.resolve(message.result)}
  else if(message.id!==undefined&&message.method)client.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'No fixture approval handler'}})+'\n');
  else if(message.method&&notifications.length<4096)notifications.push(message);
 }catch{}});
 await rpc('initialize',{clientInfo:{name:'gateway_client_session_fixture',version:'1'}});client.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
 const thread=await rpc('thread/start',{model:alias,cwd:work,approvalPolicy:'never',sandbox:'workspace-write',ephemeral:false});
 const turn=await rpc('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'Create the proof using the supplied command tool.'}]});
 const done=await waitFor(()=>notifications.find(event=>event.method==='turn/completed'&&event.params.turn.id===turn.turn.id));
 assert.equal(done.params.turn.status,'completed');assert.equal(await fs.readFile(codexPath,'utf8'),codexValue);
 await rpc('thread/resume',{threadId:thread.thread.id,model:alias,cwd:work,approvalPolicy:'never',sandbox:'workspace-write'});
 const next=await rpc('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'Continue the same saved chat.'}]});
 const nextDone=await waitFor(()=>notifications.find(event=>event.method==='turn/completed'&&event.params.turn.id===next.turn.id));
 assert.equal(nextDone.params.turn.status,'completed');
 const history=await rpc('thread/read',{threadId:thread.thread.id,includeTurns:true});assert.ok(history.thread.turns.length>=2);
 const codexCalls=observed.slice(codexOffset);assert.equal(codexCalls.length,3);assert.ok(codexCalls.every(call=>call.thread));
 const codexStarts=(await fixture.capture()).slice(codexStart).filter(row=>row.start);assert.equal(codexStarts.length,1);assert.equal(codexStarts[0].start,'live');
 assert.equal(claudeLive({max:6,parkMinutes:60}).sessions().length,2,'Native clients retain separate provider sessions');
 proof.clients.push({client:'Codex app-server',requests:codexCalls.length,providerProcesses:1,toolWriteVerified:true,savedChatResumeAndFollowup:true});
 assert.deepEqual(await Promise.all(protectedFiles.map(digest)),before);passed=true;
}catch{proof.failurePhase=phase;proof.providerRequests=observed.length;proof.requestDimensions=dimensions;process.exitCode=1}
finally{
 await flushTelemetry();proof.sessionOutcomes=(await readTelemetry(telemetryRoot,0)).filter(row=>row.event==='claude_session').map(row=>({outcome:row.outcome,reason:row.missReason}));
 lines?.close();if(client){client.stdin.end();client.kill('SIGTERM')}
 await claudeLive({max:6,parkMinutes:60}).stop();gateway.closeAllConnections();await new Promise(resolveClose=>gateway.close(resolveClose));
 await flushUsageLedger();await fixture.restore();
 proof.nativeConfigurationUnchanged=JSON.stringify(await Promise.all(protectedFiles.map(digest)))===JSON.stringify(before);
 proof.passed=passed&&proof.nativeConfigurationUnchanged;
 if(!proof.passed)proof.retainedScratch=scratch;
 await fs.writeFile(join(output,'proof.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600});
 if(proof.passed)await fs.rm(scratch,{recursive:true,force:true});
 console.log(JSON.stringify(proof));
 assert.ok(proof.nativeConfigurationUnchanged,'Native client configurations changed during the isolated check');
}
