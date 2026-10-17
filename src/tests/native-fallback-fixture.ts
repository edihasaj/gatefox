import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerBackends } from "../app-server-backends.js";
import type { Message } from "../app-server-connection.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { executionHostHome, executionHostMarker, sdkIdentity } from "../execution-host-storage.js";
import { nativeHomeOwnerPath } from "../native-execution-host-storage.js";
import { flushTelemetry, readTelemetry, type TelemetryEvent } from "../telemetry.js";

/** The version the host pins; the fixture codex reports it so a host can run it as its gateway runtime and native engine. */
export const pinned = "codex-cli 0.162.0-alpha.17.2";
export async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) { if (await check()) return; await delay(10); }
  assert.fail(`Native fallback fixture: ${what} did not happen`);
}
/** One start of the fixture codex: a private stdio engine, the host's native engine, or a gateway generation. */
export interface Launch { kind: "stdio" | "native" | "generation"; pid: number; lease: { hostPid: number; sdkState: string; private: boolean } | null }

// Every start appends one line saying how it runs and what the native-home receipt said at that moment, so a test can prove
// the lease was written before the engine started. A stdio engine leaves when its adapter's pipe closes, as the real one does.
const script = `#!${process.execPath}
import {createServer} from 'node:http';
import {appendFileSync,chmodSync,readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {WebSocketServer} from ${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)};
if(process.argv.includes('--version')){console.log(${JSON.stringify(pinned)});process.exit(0);}
const args=process.argv.slice(2);const listen=args.includes('--listen')?args[args.indexOf('--listen')+1]:'stdio://';
const kind=listen.startsWith('unix://')?(listen.endsWith('/native.sock')?'native':'generation'):'stdio';
let lease=null;try{const r=JSON.parse(readFileSync(process.env.GW_FIXTURE_LEASE,'utf8'));lease={hostPid:r.hostPid,sdkState:r.sdkState,private:!!r.privateOwner};}catch{}
if(process.env.GW_FIXTURE_LOG)appendFileSync(process.env.GW_FIXTURE_LOG,JSON.stringify({kind,pid:process.pid,lease})+'\\n');
let sequence=0;const threads=new Map();
function rpc(m,send){if(m.id==null)return;const p=m.params||{};let result={};
if(m.method==='initialize')result={userAgent:'native-fallback-fixture'};
if(m.method==='config/read')result={config:{}};
if(m.method==='thread/loaded/list'||m.method==='experimentalFeature/list')result={data:[],nextCursor:null};
if(m.method==='thread/start'){const id='native-chat-'+(++sequence);threads.set(id,{id,modelProvider:'openai'});result={thread:threads.get(id),executorPid:process.pid,modelProvider:'openai'};}
if(m.method==='thread/read'){const t=threads.get(p.threadId);if(!t){send({id:m.id,error:{code:-32600,message:'Unknown fixture thread'}});return;}result={thread:t,executorPid:process.pid};}
if(m.method==='turn/start'){result={turn:{id:'native-turn',status:'inProgress'}};send({method:'turn/started',params:{threadId:p.threadId,turn:result.turn}});}
if(m.method==='fixture/exit'){send({id:m.id,result:{}});setTimeout(()=>process.exit(0),10);return;}
send({id:m.id,result});}
if(kind==='stdio'){const lines=createInterface({input:process.stdin});lines.on('line',line=>rpc(JSON.parse(line),m=>process.stdout.write(JSON.stringify(m)+'\\n')));lines.on('close',()=>process.exit(0));}
else{const socket=listen.slice(7);const server=createServer();const ws=new WebSocketServer({server});
ws.on('connection',c=>c.on('message',b=>rpc(JSON.parse(b),m=>c.send(JSON.stringify(m)))));
server.listen(socket,()=>chmodSync(socket,0o600));process.on('SIGTERM',()=>{for(const c of ws.clients)c.terminate();server.close(()=>process.exit(0));});}
`;

/**
 * A Mac whose service plan shares native chats (and gateway chats unless `plan` says otherwise), with no host running: the
 * host home exists, as it does after a host crashed, but holds no receipt until a test writes one. Call inside a test of a
 * file that ran `isolateExecutionRoots()`, so receipts and sockets stay in the file's own folder.
 */
export async function fallbackFixture(plan: Message = { sharedExecutors: true }) {
  const directory = await mkdtemp(join(tmpdir(), "gw-native-fallback-"));
  const nativeHome = join(directory, "native"); const state = join(directory, "state");
  await mkdir(nativeHome, { mode: 0o700 }); await mkdir(state, { mode: 0o700 });
  const configText = 'model = "native-original"\n'; await writeFile(join(nativeHome, "config.toml"), configText, { mode: 0o600 });
  const sdk = join(directory, "codex"); const log = join(directory, "launches.log"); await writeFile(sdk, script, { mode: 0o700 });
  const configPath = join(directory, "gateway.json");
  const config: GatewayConfig = { version: 1, port: 3457, clientOnly: true, providers: [], stateDirectory: state };
  await writePrivateJson(configPath, config);
  await writePrivateJson(join(state, "service-plan.json"), { version: 1, config: configPath, sharedNativeExecutor: true, ...plan,
    components: [{ id: "native", kind: "native", command: sdk, args: ["--daemon", "--relay-home", join(directory, "relay"), "--codex", sdk, "--native-home", nativeHome], log: join(state, "native.log") }] });
  const home = executionHostHome(configPath, nativeHome); await mkdir(home, { mode: 0o700, recursive: true });
  const receipt = nativeHomeOwnerPath(nativeHome);
  const saved = { CODEX_HOME: process.env.CODEX_HOME, GW_FIXTURE_LOG: process.env.GW_FIXTURE_LOG, GW_FIXTURE_LEASE: process.env.GW_FIXTURE_LEASE };
  Object.assign(process.env, { CODEX_HOME: nativeHome, GW_FIXTURE_LOG: log, GW_FIXTURE_LEASE: receipt });
  const snapshot = { models: [] as Message[], revision: "fixture" };
  const catalog = { current: () => snapshot, refresh: async () => snapshot, combined: (value: typeof snapshot) => ({ models: value.models }), nativeSlugs: new Set<string>() } as unknown as DesktopCatalog;
  const adapters = new Set<AppServerBackends>();
  async function create() {
    const events: Message[] = []; let exits = 0;
    const adapter = await AppServerBackends.create(sdk, ["app-server", "--listen", "stdio://"], config, {}, {}, catalog,
      async message => { events.push(message); }, () => { exits++; }, configPath);
    adapters.add(adapter);
    return { adapter, events, exits: () => exits };
  }
  const launches = async (): Promise<Launch[]> => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line) as Launch);
  /** A host receipt for this configuration: stopped by default, as a host that shut down or never came back leaves it. */
  const hostReceipt = async (fields: Message = {}) => writePrivateJson(join(home, "owner.json"), { version: 1, managed: executionHostMarker, configPath: resolve(configPath),
    nativeHome: resolve(nativeHome), ...await sdkIdentity(sdk), socketPath: join(home, "host.sock"), pid: 0, state: "stopped", generations: [], capabilities: ["native", "gateway"], ...fields });
  const events = async (name: string, since: number): Promise<TelemetryEvent[]> => { await flushTelemetry(); return (await readTelemetry(state, since)).filter(event => event.event === name); };
  return { directory, nativeHome, config, configPath, home, sdk, receipt, create, launches, hostReceipt, events, adapters,
    async clean() {
      await Promise.allSettled([...adapters].map(adapter => adapter.stop()));
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      assert.equal(await readFile(join(nativeHome, "config.toml"), "utf8"), configText);
      await rm(directory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); await rm(dirname(receipt), { recursive: true, force: true });
    } };
}
