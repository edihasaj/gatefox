import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerBackends } from "../app-server-backends.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import { startExecutionHost, executionHostHome } from "../execution-host.js";
import { releaseSkewMessages } from "../execution-host-engine.js";
import { setHostDownWindowForTests } from "../executor-reattach.js";
import type { GatewaySdkRuntime } from "../gateway-sdk-runtime.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // The SDK rendezvous, host homes and native-home receipts stay in this file's own folder.
hostRunsInThisProcess(); // The shared host runs inside the test process: see src/tests/in-process-host.ts.

const alias = "claude/fixture";
const shaOf = (digit: string) => digit.repeat(64);

/** A fake SDK for the native engine (stdio) and the host's generations (a Unix socket); chats are saved under `--fixture-root`. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gw-skew-adapter-"));
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  await writeFile(join(nativeHome, "config.toml"), 'model = "native-original"\n', { mode: 0o600 });
  const sdk = join(directory, "codex");
  await writeFile(sdk, `#!${process.execPath}
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {WebSocketServer} from ${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)};
if(process.argv.includes('--version')){console.log('codex-cli 0.162.0-alpha.17.2');process.exit(0);}
const args=process.argv.slice(2);const root=args[args.indexOf('--fixture-root')+1];const saved=root+'/threads.json';const loaded=new Set();
const all=()=>existsSync(saved)?JSON.parse(readFileSync(saved,'utf8')):{};
function rpc(m,send){if(m.id==null)return;const p=m.params||{};let result={};
if(m.method==='config/read')result={config:{agents:{max_concurrent_threads_per_session:30}}};
if(m.method==='thread/loaded/list')result={data:[...loaded],nextCursor:null};
if(m.method==='thread/unsubscribe'){loaded.delete(p.threadId);result={status:'unsubscribed'};}
if(m.method==='thread/start'){const thread={id:p.fixtureId,model:p.model,modelProvider:p.modelProvider||'subscription_gateway'};const a=all();a[thread.id]=thread;writeFileSync(saved,JSON.stringify(a));loaded.add(thread.id);result={thread,model:thread.model,modelProvider:thread.modelProvider};}
if(m.method==='thread/resume'){const thread=all()[p.threadId];if(!thread){send({id:m.id,error:{code:-32600,message:'no rollout found'}});return;}loaded.add(thread.id);result={thread,model:thread.model,modelProvider:thread.modelProvider};}
if(m.method==='thread/read'){const thread=all()[p.threadId];result={thread:thread?{...thread,turns:[]}:{id:p.threadId,modelProvider:'openai'}};}
if(m.method==='turn/start'){const turn={id:'turn-'+process.pid,status:'completed'};result={turn};send({method:'turn/started',params:{threadId:p.threadId,turn}});send({method:'turn/completed',params:{threadId:p.threadId,turn}});}
send({id:m.id,result});}
const listen=args.includes('--listen')?args[args.indexOf('--listen')+1]:'stdio://';
if(listen.startsWith('unix://')){
const socket=listen.slice(7);const server=createServer();const ws=new WebSocketServer({server});
ws.on('connection',client=>client.on('message',bytes=>rpc(JSON.parse(bytes),m=>client.send(JSON.stringify(m)))));
server.listen(socket,()=>chmodSync(socket,0o600));
process.on('SIGTERM',()=>{for(const c of ws.clients)c.terminate();server.close(()=>process.exit(0));});
}else{createInterface({input:process.stdin}).on('line',line=>rpc(JSON.parse(line),m=>process.stdout.write(JSON.stringify(m)+'\\n')));}
`, { mode: 0o700 });
  const configPath = join(directory, "gateway.json");
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: join(directory, "state"), providers: [], clientOnly: true };
  setHostDownWindowForTests(1500);
  await writePrivateJson(join(config.stateDirectory, "service-plan.json"), { version: 1, config: configPath, sharedExecutors: true,
    components: [{ id: "native", kind: "native", command: sdk, args: ["--codex", sdk, "--native-home", nativeHome], log: join(config.stateDirectory, "native.log") }] });
  const previousHome = process.env.CODEX_HOME; process.env.CODEX_HOME = nativeHome;
  const runtime = (digit: string): GatewaySdkRuntime => ({ executable: sdk, binarySha256: shaOf(digit), selectedModelCompaction: true, executorIdentity: true, codeModeHost: false });
  let host: Awaited<ReturnType<typeof startExecutionHost>> | undefined;
  const startHost = async (digit: string) => { host = await startExecutionHost({ config, configPath, nativeHome, codex: sdk, gatewayRuntime: async () => runtime(digit) }); };
  const snapshot = () => ({ revision: "1".repeat(64), models: [{ slug: alias, display_name: "Fixture" }] });
  const catalog = { current: snapshot, refresh: async () => snapshot(), combined: (value: ReturnType<typeof snapshot>) => ({ models: value.models }) } as unknown as DesktopCatalog;
  await startHost("a");
  // The adapter is the release whose gateway SDK is "a".
  const backends = await AppServerBackends.create(sdk, ["app-server", "--listen", "stdio://", "--fixture-root", directory], config, {}, {}, catalog, async () => {}, () => {}, configPath);
  backends.resolveRuntime = async () => runtime("a");
  await backends.request("initialize", { clientInfo: { name: "skew", version: "1" }, capabilities: { experimentalApi: true } }); backends.notify({ method: "initialized" });
  const engine = (threadId: string) => (backends as unknown as { bindings: Map<string, { connection: { closed: boolean } }> }).bindings.get(threadId);
  const until = async (check: () => boolean, name: string) => { for (let attempt = 0; attempt < 800; attempt++) { if (check()) return; await delay(10); } throw new Error(name + " never happened"); };
  return {
    backends, engine, until,
    start: (id: string) => backends.request("thread/start", { fixtureId: id, model: alias, modelProvider: "subscription_gateway", cwd: "/work", approvalPolicy: "never" }, { engine: "gateway" }),
    /** The service moved to another release: its host runs the SDK `digit` now. */
    async moveHost(digit: string) { await host?.close(); host = undefined; await startHost(digit); },
    async clean() {
      await backends.stop(); await host?.close(); setHostDownWindowForTests();
      process.env.CODEX_HOME = previousHome; if (previousHome === undefined) delete process.env.CODEX_HOME;
      await Promise.allSettled([rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }), rm(executionHostHome(configPath, nativeHome), { recursive: true, force: true })]);
    },
  };
}
const skew = (error: Error & { code?: number }) => error.message === releaseSkewMessages.adapter_older;

test("an adapter beside a host of another release shows the host's release-skew message when it starts a chat", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("before");
    await f.moveHost("b");
    await assert.rejects(f.start("after"), skew);
    await assert.rejects(f.backends.request("thread/start", { fixtureId: "again", model: alias, modelProvider: "subscription_gateway", cwd: "/work" }, { engine: "gateway" }), skew,
      "and again, since the host is up and answering: the refusal does not arm the host-down window");
  } finally { await f.clean(); }
});

test("a chat whose executor went away with the old host re-attaches with the same message instead of 'connection was lost'", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("loaded");
    await f.moveHost("b"); await f.until(() => f.engine("loaded")?.connection.closed === true, "the executor connection closing");
    await assert.rejects(f.backends.request("turn/start", { threadId: "loaded", model: alias, input: [{ type: "text", text: "hello" }] }), skew);
    await assert.rejects(f.backends.request("thread/resume", { threadId: "loaded" }), skew);
  } finally { await f.clean(); }
});
