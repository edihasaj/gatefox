import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerBackends } from "../app-server-backends.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import type { Message } from "../app-server-connection.js";
import type { GatewayConfig } from "../config.js";
import type { GatewaySdkRuntime } from "../gateway-sdk-runtime.js";
import { GatewayChatRegistry } from "../gateway-chat-registry.js";
import { configureTelemetry, flushTelemetry } from "../telemetry.js";

const alias = "gateway/sol"; const nativeModel = "gpt-6.1-sol";

/**
 * One fake SDK plays both engines, as in app-server-backends-identity: the gateway executor is the process marked with
 * HARNESS_GATEWAY_EXECUTOR=1, whatever provider id it was launched with, which is how the gateway SDK tells them apart too.
 * Each process writes how it was launched to `<root>/launch-<pid>.json`. Saved chats live in `<root>/threads.json`, and a
 * start or fork records the provider the request named, or the executor's default `model_provider` when it named none.
 */
async function fixture(chatIdentity?: "openai" | "legacy", sdkServesIdentity = true) {
  const directory = await mkdtemp(join(tmpdir(), "gw-native-identity-"));
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  const sdk = join(directory, "codex");
  await writeFile(sdk, `#!${process.execPath}
const {createInterface}=require('node:readline');const {readFileSync,writeFileSync,existsSync}=require('node:fs');
const args=process.argv.slice(2),root=args[args.indexOf('--fixture-root')+1],saved=root+'/threads.json';
const gateway=process.env.HARNESS_GATEWAY_EXECUTOR==='1';
const setting=key=>{const flag=args.find(arg=>arg.startsWith(key+'='));return flag===undefined?undefined:JSON.parse(flag.slice(key.length+1));};
writeFileSync(root+'/launch-'+process.pid+'.json',JSON.stringify({gateway,args,marker:process.env.HARNESS_GATEWAY_EXECUTOR??null}));
const fallback=gateway?setting('model_provider'):'openai';let sequence=0;
const all=()=>existsSync(saved)?JSON.parse(readFileSync(saved,'utf8')):{};
const keep=t=>{const value=all();value[t.id]=t;writeFileSync(saved,JSON.stringify(value));};
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;const p=m.params||{};let result={};
 if(m.method==='config/read')result={config:{model:'${nativeModel}',model_provider:'openai'}};
 if(m.method==='fixture/ledger')result={gateway};
 if(m.method==='thread/start'||m.method==='thread/fork'){const parent=m.method==='thread/fork'?all()[p.threadId]:{};
  const t={id:p.fixtureId||(gateway?'gw-':'native-')+(++sequence),model:p.model||parent.model||'${nativeModel}',modelProvider:p.modelProvider||fallback,requested:p.modelProvider??null,ephemeral:p.ephemeral===true};
  if(!t.ephemeral)keep(t);send({id:m.id,result:{thread:t,model:t.model,modelProvider:t.modelProvider,serviceTier:null}});send({method:'thread/started',params:{thread:t}});return;}
 if(m.method==='thread/read'||m.method==='thread/resume'){const t=all()[p.threadId];if(!t){send({id:m.id,error:{code:-32600,message:'no rollout found for thread id '+p.threadId}});return;}
  if(m.method==='thread/resume'&&p.modelProvider){t.resumedWith=p.modelProvider;keep(t);}result={thread:t,model:t.model,modelProvider:t.modelProvider,serviceTier:null};}
 if(m.method==='fixture/spawn'){const t={id:p.child,model:'${nativeModel}',modelProvider:fallback,source:{subAgent:{thread_spawn:{parent_thread_id:p.threadId,depth:1}}}};keep(t);send({method:'thread/started',params:{thread:t}});}
 send({id:m.id,result});});
`, { mode: 0o700 });
  const state = join(directory, "state"); await mkdir(state, { mode: 0o700 });
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: state, providers: [], clientOnly: true, timeoutMs: 5000, ...(chatIdentity ? { chatIdentity } : {}) };
  configureTelemetry(state, "test");
  const snapshot = () => ({ revision: "b".repeat(64), models: [{ slug: alias, context_window: 200000 }], path: join(directory, "desktop.json") });
  const catalog = { current: snapshot, refresh: async () => snapshot(), combined: (value: ReturnType<typeof snapshot>) => ({ models: value.models }),
    nativeSlugs: new Set([nativeModel]) } as unknown as DesktopCatalog;
  const priorHome = process.env.CODEX_HOME; process.env.CODEX_HOME = nativeHome;
  // The fake SDK stands in for the verified gateway SDK artifact; `sdkServesIdentity` false is one built before patch v2.
  const runtime = { executable: sdk, binarySha256: "c".repeat(64), selectedModelCompaction: true, ...(sdkServesIdentity ? { executorIdentity: true } : {}) } as GatewaySdkRuntime;
  const opened: AppServerBackends[] = [];
  const open = async (overrides: Message = {}) => {
    const backends = new AppServerBackends(sdk, ["app-server", "--listen", "stdio://", "--fixture-root", directory], config, {}, overrides, catalog, async () => {}, () => {});
    backends.resolveRuntime = async () => runtime;
    opened.push(backends);
    await backends.request("initialize", { clientInfo: { name: "native-identity", version: "1" }, capabilities: { experimentalApi: true } });
    backends.notify({ method: "initialized" });
    return backends;
  };
  const saved = async (): Promise<Record<string, Message>> => JSON.parse(await readFile(join(directory, "threads.json"), "utf8").catch(() => "{}"));
  const save = async (thread: Message) => { const all = await saved(); all[String(thread.id)] = thread; await writeFile(join(directory, "threads.json"), JSON.stringify(all)); };
  const launches = async () => Promise.all((await readdir(directory)).filter(name => name.startsWith("launch-")).map(async name => JSON.parse(await readFile(join(directory, name), "utf8")) as { gateway: boolean; args: string[]; marker: string | null }));
  const engineOf = async (backends: AppServerBackends, threadId: string) => (await backends.request("fixture/ledger", { threadId })).gateway ? "gateway" : "native";
  return { directory, state, nativeHome, open, saved, save, launches, engineOf, registry: () => new GatewayChatRegistry(state, nativeHome),
    async clean() {
      for (const backends of opened) await backends.stop();
      if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
      await flushTelemetry(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } };
}

test("by default an executor records new gateway chats as openai, registers the legacy provider and runs without analytics", { timeout: 20000 }, async () => {
  const f = await fixture();
  // As when the adapter itself was started from inside a gateway chat: its native engine must still not be marked.
  const inherited = process.env.HARNESS_GATEWAY_EXECUTOR; process.env.HARNESS_GATEWAY_EXECUTOR = "1";
  try {
    const backends = await f.open({ base_url: "http://127.0.0.1:3457/v1", supports_websockets: false, request_max_retries: 2, stream_idle_timeout_ms: 90000 });
    if (inherited === undefined) delete process.env.HARNESS_GATEWAY_EXECUTOR; else process.env.HARNESS_GATEWAY_EXECUTOR = inherited;
    const started = await backends.request("thread/start", { fixtureId: "new-chat", model: alias, modelProvider: "subscription_gateway" }, { engine: "gateway" });
    assert.equal(started.modelProvider, "openai");
    assert.equal((await f.saved())["new-chat"].requested, "openai", "the executor was asked for the native identity");
    assert.equal(await f.registry().has("new-chat"), true, "recorded before the reply returned");
    const executor = (await f.launches()).find(launch => launch.gateway)!;
    for (const setting of ['model_provider="openai"', "analytics.enabled=false", 'openai_base_url="http://127.0.0.1:3457/v1"',
      'model_providers.subscription_gateway.base_url="http://127.0.0.1:3457/v1"', "model_providers.subscription_gateway.supports_websockets=false",
      "model_providers.subscription_gateway.request_max_retries=2", "model_providers.subscription_gateway.stream_idle_timeout_ms=90000"]) {
      assert.ok(executor.args.includes(setting), setting);
    }
    const native = (await f.launches()).find(launch => !launch.gateway)!;
    assert.equal(native.marker, null, "the native engine is never marked");
    assert.equal(native.args.some(arg => arg.startsWith("model_provider=") || arg.startsWith("openai_base_url=")), false, "the native engine keeps its own identity");
    // A fork is a new chat as well.
    const fork = await backends.request("thread/fork", { threadId: "new-chat", fixtureId: "new-fork", modelProvider: "subscription_gateway" });
    assert.equal(fork.modelProvider, "openai"); assert.equal(await f.registry().has("new-fork"), true);
    // A sub-agent inherits the executor's identity and is recorded by its announcement.
    await backends.request("fixture/spawn", { threadId: "new-chat", child: "new-sub-agent" });
    assert.equal((await f.saved())["new-sub-agent"].modelProvider, "openai"); assert.equal(await f.registry().has("new-sub-agent"), true);
  } finally {
    if (inherited === undefined) delete process.env.HARNESS_GATEWAY_EXECUTOR; else process.env.HARNESS_GATEWAY_EXECUTOR = inherited;
    await f.clean();
  }
});

test("a resumed chat keeps the provider it was saved with; only the router's request for a new chat is given the identity", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    await f.save({ id: "legacy-chat", model: alias, modelProvider: "subscription_gateway" });
    const backends = await f.open();
    await backends.request("thread/resume", { threadId: "legacy-chat", model: alias, modelProvider: "subscription_gateway" });
    assert.equal(await f.engineOf(backends, "legacy-chat"), "gateway");
    const record = (await f.saved())["legacy-chat"];
    assert.deepEqual({ provider: record.modelProvider, resumedWith: record.resumedWith }, { provider: "subscription_gateway", resumedWith: "subscription_gateway" });
    // A caller that names no provider, or the native one, is passed through: only the gateway's own id is a request for a new gateway chat.
    const unnamed = await backends.request("thread/start", { fixtureId: "unnamed", model: alias }, { engine: "gateway" });
    assert.equal((await f.saved()).unnamed.requested, null); assert.equal(unnamed.modelProvider, "openai", "the executor's default is the identity");
  } finally { await f.clean(); }
});

test("chatIdentity legacy, or a gateway SDK without patch v2, keeps recording new gateway chats as subscription_gateway", { timeout: 20000 }, async () => {
  for (const [identity, servesIdentity] of [["legacy", true], [undefined, false]] as const) {
    const f = await fixture(identity, servesIdentity);
    try {
      const backends = await f.open({ base_url: "http://127.0.0.1:3457/v1" });
      const started = await backends.request("thread/start", { fixtureId: "legacy-start", model: alias, modelProvider: "subscription_gateway" }, { engine: "gateway" });
      assert.equal(started.modelProvider, "subscription_gateway", `${identity} ${servesIdentity}`);
      const executor = (await f.launches()).find(launch => launch.gateway)!;
      assert.ok(executor.args.includes('model_provider="subscription_gateway"'));
      assert.ok(executor.args.includes("analytics.enabled=false"), "analytics are off for every executor");
      assert.equal(await f.registry().has("legacy-start"), true);
    } finally { await f.clean(); }
  }
});

test("an openai gateway chat found through its parent or alias is written to the registry when it is routed; a native one never is", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    await f.registry().record("parent", "start");
    await f.save({ id: "parent", model: alias, modelProvider: "openai" });
    // Spawned while no desktop was connected: a native slug and the native identity, known only through its parent.
    await f.save({ id: "orphan-sub-agent", model: nativeModel, modelProvider: "openai", source: { subAgent: { thread_spawn: { parent_thread_id: "parent", depth: 1 } } } });
    await f.save({ id: "alias-chat", model: alias, modelProvider: "openai" });
    await f.save({ id: "throwaway", model: alias, modelProvider: "openai", ephemeral: true });
    await f.save({ id: "native-chat", model: nativeModel, modelProvider: "openai" });
    const backends = await f.open();
    for (const id of ["orphan-sub-agent", "alias-chat", "throwaway", "native-chat"]) await backends.request("thread/resume", { threadId: id });
    assert.deepEqual(await Promise.all(["orphan-sub-agent", "alias-chat", "throwaway", "native-chat"].map(id => f.engineOf(backends, id))), ["gateway", "gateway", "gateway", "native"]);
    assert.deepEqual(await Promise.all(["orphan-sub-agent", "alias-chat", "throwaway", "native-chat"].map(id => f.registry().has(id))), [true, true, false, false]);
    // The sub-agent no longer needs its parent: a registry without the parent still routes it.
    const raw = JSON.parse(await readFile(join(f.state, "gateway-chats", (await readdir(join(f.state, "gateway-chats"))).find(name => name.endsWith(".json"))!), "utf8"));
    assert.deepEqual(raw.chats.map((chat: Message) => [chat.id, chat.origin]).sort(), [["alias-chat", "started"], ["orphan-sub-agent", "subagent"], ["parent", "start"]]);
  } finally { await f.clean(); }
});
