import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import { installRoot } from './install-root.mjs';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {createServer as tcpServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID,createHash} from 'node:crypto';

// Uses an isolated launchd label, state, credentials, and mock upstream. Never
// changes desktop registration or the working gateway service.
if(process.platform!=='darwin'||!process.argv[2])throw Error('Usage: node scripts/e2e-service-supervisor.mjs /absolute/installed/bin/gateway');
const run=promisify(execFile);const command=resolve(process.argv[2]);
const root=join(installRoot(resolve(dirname(command),'..')),'current');
const {servicePlist}=await import(pathToFileURL(join(root,'package/dist/mac-service.js')));
const {writePrivateJson,readClientToken}=await import(pathToFileURL(join(root,'package/dist/config.js')));
const directory=await mkdtemp(join(tmpdir(),'gateway-service-e2e-'));const configPath=join(directory,'config.json');
const label='com.edihasaj.subscription-gateway.verify-'+randomUUID();const target=`gui/${process.getuid()}/${label}`;
const plist=join(directory,'service.plist');const statusFile=join(directory,'service-status.json');
const nativeConfig=join(homedir(),'.codex/config.toml');
const digest=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const beforeConfig=await digest(nativeConfig);const owned=new Set();
async function nativePid(){try{return (await run('/bin/launchctl',['print',`gui/${process.getuid()}/com.edihasaj.subscription-gateway.native`])).stdout.match(/^\s*pid = (\d+)$/m)?.[1];}catch{return undefined;}}
const beforeNative=await nativePid();
async function until(check){for(let i=0;i<150;i++){try{if(await check())return;}catch{}await delay(100);}throw Error('Isolated service did not reach its expected state');}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
async function status(){const value=JSON.parse(await readFile(statusFile,'utf8'));owned.add(value.pid);for(const component of value.components)if(component.pid)owned.add(component.pid);return value;}
const upstream=createServer((req,res)=>{
  req.resume();res.writeHead(200,{'content-type':'text/event-stream'});
  res.write('data: '+JSON.stringify({model:'fixture',choices:[{index:0,delta:{content:'SERVICE_STREAM_OK'},finish_reason:null}]})+'\n\n');
  res.write('data: '+JSON.stringify({model:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
const reserve=tcpServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
await writeFile(join(directory,'fixture-key'),'isolated-fixture-key',{mode:0o600});
await writePrivateJson(configPath,{version:1,port,stateDirectory:directory,providers:[{id:'fixture',type:'chat-completions-api',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,credentialFile:join(directory,'fixture-key'),models:{fixture:'fixture'}}]});
const node=join(root,'runtime/bin/node');
const plan={version:1,config:configPath,components:[
  {id:'inference',kind:'inference',command,args:['serve','--config',configPath],log:join(directory,'inference.log')},
  {id:'relay-fixture',kind:'native',command:node,args:['-e','setInterval(()=>{},1000)'],log:join(directory,'relay.log')},
  {id:'desktop-fixture',kind:'desktop',command:node,args:['-e',"console.log('LOGIN_ONCE')"],log:join(directory,'desktop.log')},
]};
await writePrivateJson(join(directory,'service-plan.json'),plan);
await writeFile(plist,servicePlist(node,join(root,'package/dist/cli.js'),configPath,join(directory,'supervisor.log'),'/usr/bin:/bin',command,'daemon').replace(`<string>com.edihasaj.subscription-gateway</string>`,`<string>${label}</string>`),{mode:0o600});
let token;let booted=false;const result={directory,realLaunchd:true,mockRelay:true};
async function stream(){
  const response=await fetch(`http://127.0.0.1:${port}/v1/responses`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({model:'fixture',input:'hello',stream:true})});
  assert.equal(response.status,200);const text=await response.text();assert.match(text,/SERVICE_STREAM_OK/);assert.match(text,/response.completed/);
}
try{
  await run('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,plist]);booted=true;
  await until(async()=>{const current=await status();return current.components.every(child=>['running','complete'].includes(child.state))&&(await fetch(`http://127.0.0.1:${port}/health`)).ok;});
  token=await readClientToken(join(directory,'client-token'));await stream();result.streaming=true;
  const before=await status();const inference=before.components.find(child=>child.id==='inference').pid;const relay=before.components.find(child=>child.id==='relay-fixture').pid;
  process.kill(inference,'SIGKILL');
  await until(async()=>{const after=await status();return after.components.find(child=>child.id==='inference').pid&&after.components.find(child=>child.id==='inference').pid!==inference&&(await fetch(`http://127.0.0.1:${port}/health`)).ok;});
  assert.equal((await status()).components.find(child=>child.id==='relay-fixture').pid,relay);await stream();result.childCrashRecovery=true;
  const running=await status();const previousChildren=running.components.flatMap(child=>child.pid?[child.pid]:[]);
  process.kill(running.pid,'SIGKILL');
  await until(async()=>{const after=await status();return after.pid!==running.pid&&after.components.every(child=>['running','complete'].includes(child.state))&&(await fetch(`http://127.0.0.1:${port}/health`)).ok;});
  assert.ok(previousChildren.every(pid=>!alive(pid)),'launchd must retire the crashed supervisor’s old children');
  await stream();result.supervisorCrashRecovery=true;
  assert.equal((await readFile(join(directory,'desktop.log'),'utf8')).trim().split('\n').length,2);result.loginOncePerSupervisor=true;
}finally{
  if(booted)await run('/bin/launchctl',['bootout',target]);
  await until(async()=>[...owned].every(pid=>!alive(pid)));
  await new Promise(resolve=>upstream.close(resolve));
  await run('trash',[plist]);
}
assert.equal(await nativePid(),beforeNative);assert.equal(await digest(nativeConfig),beforeConfig);
result.workingRelayPreserved=true;result.nativeConfigPreserved=true;result.noOwnedChildrenLeft=true;
await writePrivateJson(join(directory,'results.json'),result);console.log(JSON.stringify(result));
