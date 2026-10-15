import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerBackends } from "../app-server-backends.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { startExecutionHost, executionHostHome } from "../execution-host.js";
import type { Message } from "../app-server-connection.js";
import type { GatewayConfig } from "../config.js";

export const largeModel = "claude/large-fixture";
export const smallModel = "codex/small-fixture";
export interface FixtureCall { method: string; params: Message; model: string; gateway: boolean }

export async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let count = 0; count < 400; count++) { if (await check()) return; await delay(5); }
  throw new Error("Compaction integration fixture did not reach the expected state");
}

export async function compactionSdkFixture(shared = false, goalsEnabled = true) {
  const directory = await mkdtemp(join(tmpdir(), "gw-compact-backend-"));
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  const nativeConfig = 'model = "native-original"\n';
  await writeFile(join(nativeHome, "config.toml"), nativeConfig, { mode: 0o600 });
  const sdk = join(directory, "codex");
  await writeFile(sdk, `#!${process.execPath}
const {createInterface}=require('node:readline');
const {createServer}=require('node:http');
const {readFileSync,writeFileSync,existsSync,chmodSync}=require('node:fs');
const {WebSocketServer}=require(${JSON.stringify(resolve("node_modules/ws"))});
if(process.argv.includes('--version')){console.log('codex-cli 0.162.0-alpha.17.2');process.exit(0);}
const args=process.argv.slice(2),root=args[args.indexOf('--fixture-root')+1],saved=root+'/threads.json';
const overrides={};for(let i=0;i<args.length;i++)if(args[i]==='-c'){const value=args[++i],at=value.indexOf('=');try{overrides[value.slice(0,at)]=JSON.parse(value.slice(at+1));}catch{}}
const gateway=overrides.model_provider==='subscription_gateway',threads=new Map(),calls=[];
let clock=Date.now(),sequence=0,hold=false,readDelay=0;
const metadata=()=>existsSync(saved)?JSON.parse(readFileSync(saved,'utf8')):{};
function persist(t){const all=metadata();all[t.id]=t;writeFileSync(saved,JSON.stringify(all));}
const get=id=>threads.get(id)||metadata()[id];
function notify(send,method,params){send({method,params,emittedAtMs:++clock});}
function usage(send,t,last,window){notify(send,'thread/tokenUsage/updated',{threadId:t.id,turnId:t.active||'seed-turn',tokenUsage:{last:{totalTokens:last},total:{totalTokens:9000000},modelContextWindow:window}});}
function finished(send,t,id,status,compact){t.active=null;t.status={type:status==='failed'?'systemError':'idle'};persist(t);if(compact&&status==='completed'){usage(send,t,300,t.model===${JSON.stringify(smallModel)}?27000:45000);notify(send,'item/completed',{threadId:t.id,turnId:id,item:{type:'contextCompaction',id:'compact-item-'+id}});}notify(send,'turn/completed',{threadId:t.id,turn:{id,status,items:[],error:status==='failed'?{message:'fixture failed',codexErrorInfo:'responseStreamDisconnected'}:null}});}
async function rpc(m,send){if(m.id==null)return;const p=m.params||{};let result={};
if(m.method==='fixture/ledger'){send({id:m.id,result:{calls}});return;}
calls.push({method:m.method,params:p,model:get(p.threadId)?.model||'',gateway});
if(m.method==='config/read')result={config:{model:'native-original',model_provider:'openai',agents:{max_concurrent_threads_per_session:30}}};
if(m.method==='thread/start'){const id=p.fixtureId||'thread-'+(++sequence);const t={id,model:p.model||'native-original',modelProvider:p.modelProvider||'openai',reasoningEffort:p.effort||'medium',status:{type:'idle'},active:null,path:null};threads.set(id,t);persist(t);result={thread:t,model:t.model,modelProvider:t.modelProvider,serviceTier:null};}
if(m.method==='thread/read'||m.method==='thread/resume'){if(readDelay&&m.method==='thread/read'){notify(send,'fixture/readStarted',{threadId:p.threadId});await new Promise(r=>setTimeout(r,readDelay));}const t=get(p.threadId);if(!t){send({id:m.id,error:{code:-32000,message:'fixture thread absent'}});return;}if(m.method==='thread/resume')threads.set(t.id,t);result={thread:t,model:t.model,modelProvider:t.modelProvider,serviceTier:null};}
if(m.method==='thread/loaded/list')result={data:[...threads.keys()],nextCursor:null};
if(m.method==='thread/goal/get'){if(!${JSON.stringify(goalsEnabled)}){send({id:m.id,error:{code:-32601,message:'fixture goals disabled'}});return;}result={goal:get(p.threadId).goal||null};}
if(m.method==='fixture/goal'){const t=get(p.threadId);t.goal=p.status?{threadId:t.id,status:p.status}:null;persist(t);}
if(m.method==='thread/settings/update'){const t=get(p.threadId);if(p.model)t.model=p.model;if(p.effort)t.reasoningEffort=p.effort;if(p.collaborationMode?.settings?.model){t.model=p.collaborationMode.settings.model;if(Object.hasOwn(p.collaborationMode.settings,'reasoning_effort'))t.reasoningEffort=p.collaborationMode.settings.reasoning_effort;}persist(t);notify(send,'thread/settings/updated',{threadId:t.id,threadSettings:{model:t.model,modelProvider:t.modelProvider,serviceTier:p.serviceTier??null,effort:t.reasoningEffort}});}
if(m.method==='fixture/usage'){const t=get(p.threadId);usage(send,t,p.lastTokens??40010,p.contextWindow??45000);}
if(m.method==='fixture/failedCompact'){const t=get(p.threadId),id='failed-compact-'+(++sequence);notify(send,'item/started',{threadId:t.id,turnId:id,item:{type:'contextCompaction',id:'failed-item'}});finished(send,t,id,'failed',false);}
if(m.method==='fixture/holdCompact')hold=!!p.value;
if(m.method==='fixture/readDelay')readDelay=p.milliseconds||0;
if(m.method==='thread/rollback'){const t=get(p.threadId);t.active=null;t.status={type:'idle'};persist(t);result={thread:t};}
if(m.method==='thread/compact/start'){const t=get(p.threadId),id='owned-compact-'+(++sequence);t.active=id;t.status={type:'active',activeFlags:[]};persist(t);notify(send,'turn/started',{threadId:t.id,turn:{id,status:'inProgress',items:[]}});notify(send,'item/started',{threadId:t.id,turnId:id,item:{type:'contextCompaction',id:'compact-item-'+id}});if(!hold)setTimeout(()=>finished(send,t,id,'completed',true),10);}
if(m.method==='turn/start'){const t=get(p.threadId);if(t.active){result={turn:{id:t.active,status:'inProgress'},steered:true};}else{if(p.collaborationMode?.settings?.model){t.model=p.collaborationMode.settings.model;if(Object.hasOwn(p.collaborationMode.settings,'reasoning_effort'))t.reasoningEffort=p.collaborationMode.settings.reasoning_effort;}else{if(p.model)t.model=p.model;if(p.effort)t.reasoningEffort=p.effort;}const id='ordinary-turn-'+(++sequence);t.active=id;t.status={type:'active',activeFlags:[]};persist(t);notify(send,'turn/started',{threadId:t.id,turn:{id,status:'inProgress',items:[]}});result={turn:{id,status:'inProgress'}};if(!p.fixtureKeepActive)setTimeout(()=>finished(send,t,id,'completed',false),5);}}
if(m.method==='turn/steer')result={turnId:get(p.threadId).active};
if(m.method==='turn/interrupt'){const t=get(p.threadId);if(t.active!==p.turnId){send({id:m.id,error:{code:-32600,message:'fixture interrupt must name actual active turn'}});return;}finished(send,t,p.turnId,'interrupted',false);}
if(m.method==='thread/unsubscribe'){threads.delete(p.threadId);if(!p.fixtureNoClosed)notify(send,'thread/closed',{threadId:p.threadId});}
send({id:m.id,result});}
const listen=args.includes('--listen')?args[args.indexOf('--listen')+1]:'stdio://';
if(listen.startsWith('unix://')){const socket=listen.slice(7),server=createServer(),ws=new WebSocketServer({server});ws.on('connection',client=>client.on('message',bytes=>{void rpc(JSON.parse(bytes),m=>client.send(JSON.stringify(m)));}));server.listen(socket,()=>chmodSync(socket,0o600));process.on('SIGTERM',()=>{for(const c of ws.clients)c.terminate();server.close(()=>process.exit(0));});}
else createInterface({input:process.stdin}).on('line',line=>{void rpc(JSON.parse(line),m=>process.stdout.write(JSON.stringify(m)+'\\n'));});
`, { mode: 0o700 });
  const configPath = join(directory, "gateway.json");
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: join(directory, "state"), providers: [], clientOnly: true, timeoutMs: 5000 };
  await mkdir(config.stateDirectory, { mode: 0o700 }); await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const priorHome = process.env.CODEX_HOME; process.env.CODEX_HOME = nativeHome;
  const host = shared ? await startExecutionHost({ config, configPath, nativeHome, codex: sdk }) : undefined;
  let generation = 0;
  const snapshot = () => ({ revision: String(generation).repeat(64), models: [
    { slug: largeModel, context_window: 50000, effective_context_window_percent: 90 },
    { slug: smallModel, context_window: generation ? 500000 : 30000, effective_context_window_percent: 90 },
  ] });
  const catalog = { current: snapshot, refresh: async () => snapshot(), combined: (s: ReturnType<typeof snapshot>) => ({ models: s.models }) } as unknown as DesktopCatalog;
  const events: Message[] = [];
  const backends = new AppServerBackends(sdk, ["app-server", "--listen", "stdio://", "--fixture-root", directory], config, { features: { goals: goalsEnabled } }, {}, catalog,
    async message => { events.push(message); }, () => {}, shared ? configPath : undefined);
  await backends.request("initialize", { clientInfo: { name: "compaction-integration-fixture", version: "1" }, capabilities: { experimentalApi: true } });
  backends.notify({ method: "initialized" });
  const ledger = async (threadId: string) => (await backends.request("fixture/ledger", { threadId })).calls as FixtureCall[];
  return { directory, config, nativeHome, nativeConfig, backends, events, ledger, nextCatalog() { generation++; },
    async start(threadId: string, model = largeModel) { return backends.request("thread/start", { fixtureId: threadId, model, modelProvider: "subscription_gateway" }); },
    async usage(threadId: string, lastTokens = 40010, contextWindow = 45000) {
      await backends.request("fixture/usage", { threadId, lastTokens, contextWindow });
      await until(() => events.some(e => e.method === "thread/tokenUsage/updated" && (e.params as Message)?.threadId === threadId));
    },
    async nativeUnchanged() { return await readFile(join(nativeHome, "config.toml"), "utf8") === nativeConfig; },
    async clean() {
      // An accepted ordinary turn can still be publishing its terminal event.
      // Keep its private metadata directory until forwarding has finished.
      await until(() => events.filter(e => e.method === "turn/started" && String((e.params as Message)?.turn && ((e.params as Message).turn as Message).id).startsWith("ordinary-turn"))
        .every(started => events.some(ended => ended.method === "turn/completed" && ((ended.params as Message)?.turn as Message)?.id === ((started.params as Message).turn as Message).id))).catch(() => {});
      await backends.stop(); await host?.close(); if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
      await rm(directory, { recursive: true, force: true }); if (shared) await rm(executionHostHome(configPath, nativeHome), { recursive: true, force: true }); },
  };
}
