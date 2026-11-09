import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerBackends } from "../app-server-backends.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import type { Message } from "../app-server-connection.js";
import type { GatewayConfig } from "../config.js";
import { GatewayChatRegistry } from "../gateway-chat-registry.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { gatewayIdentities } from "./identity-cases.js";

const alias = "gateway/sol"; const nativeModel = "gpt-6.1-sol";
async function until<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) { const value = read(); if (value !== undefined) return value; await delay(5); }
  throw new Error("The fixture never reached the expected state");
}

/**
 * One fake SDK plays both engines; the gateway executor is the one launched with the gateway's provider. Saved chats live in
 * `<root>/threads.json`, shared by both, as Codex shares rollouts and SQLite. `fixture/ledger` says which engine answered,
 * a start answers which engine took it (`fixtureEngine`), a start with `hold` stays unanswered until `fixture/release`, `fixture/spawn` announces a sub-agent the way the SDK does: a thread/started notification with the parent in its source.
 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gw-backends-identity-"));
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  const sdk = join(directory, "codex");
  await writeFile(sdk, `#!${process.execPath}
const {createInterface}=require('node:readline');const {readFileSync,writeFileSync,existsSync}=require('node:fs');
if(process.argv.includes('--version')){console.log('codex-cli 0.162.0-alpha.17.2');process.exit(0);}
const args=process.argv.slice(2),root=args[args.indexOf('--fixture-root')+1],saved=root+'/threads.json';
const gateway=args.some(arg=>arg==='model_provider="subscription_gateway"'||arg==='model_provider="gatefox"');let sequence=0,held=null;
const all=()=>existsSync(saved)?JSON.parse(readFileSync(saved,'utf8')):{};
const keep=t=>{const value=all();value[t.id]=t;writeFileSync(saved,JSON.stringify(value));};
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;const p=m.params||{};let result={};
 if(m.method==='config/read')result={config:{model:'${nativeModel}',model_provider:'openai'}};
 if(m.method==='fixture/ledger')result={gateway};
 if(m.method==='thread/start'||m.method==='thread/fork'){const parent=m.method==='thread/fork'?all()[p.threadId]:{};
  const t={id:p.fixtureId||(gateway?'gw-':'native-')+(++sequence),model:p.model||parent.model||'${nativeModel}',modelProvider:p.modelProvider||parent.modelProvider||'openai',ephemeral:p.ephemeral===true};
  const finish=()=>{if(!t.ephemeral)keep(t);send({id:m.id,result:{thread:t,model:t.model,modelProvider:t.modelProvider,serviceTier:null,fixtureEngine:gateway?'gateway':'native'}});send({method:'thread/started',params:{thread:t}});};
  if(p.hold){held=finish;return;}finish();return;}
 if(m.method==='fixture/release'&&held){const finish=held;held=null;finish();}
 if(m.method==='thread/read'||m.method==='thread/resume'){const t=all()[p.threadId];if(!t){send({id:m.id,error:{code:-32600,message:'no rollout found for thread id '+p.threadId}});return;}result={thread:t,model:t.model,modelProvider:t.modelProvider,serviceTier:null};}
 if(m.method==='fixture/spawn'){const t={id:p.child,model:'${nativeModel}',modelProvider:p.provider,source:{subAgent:{thread_spawn:{parent_thread_id:p.threadId,depth:1}}}};keep(t);send({method:'thread/started',params:{thread:t}});}
 send({id:m.id,result});});
`, { mode: 0o700 });
  const state = join(directory, "state"); await mkdir(state, { mode: 0o700 });
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: state, providers: [], clientOnly: true, timeoutMs: 5000 };
  configureTelemetry(state, "test");
  const snapshot = () => ({ revision: "a".repeat(64), models: [{ slug: alias, context_window: 200000 }], path: join(directory, "desktop.json") });
  const catalog = { current: snapshot, refresh: async () => snapshot(), combined: (value: ReturnType<typeof snapshot>) => ({ models: value.models }),
    nativeSlugs: new Set([nativeModel]) } as unknown as DesktopCatalog;
  const priorHome = process.env.CODEX_HOME; process.env.CODEX_HOME = nativeHome;
  const registry = () => new GatewayChatRegistry(state, nativeHome);
  // What the registry held at the moment each notification was handed on, and which engine kind came with it.
  const emitted: Array<{ method: unknown; threadId?: string; engine?: string; recorded?: boolean }> = [];
  const create = async () => {
    const backends = new AppServerBackends(sdk, ["app-server", "--listen", "stdio://", "--fixture-root", directory], config, {}, {}, catalog, async (message: Message, engine?: string) => {
      const thread = (message.params as Message | undefined)?.thread as Message | undefined;
      const threadId = typeof thread?.id === "string" ? thread.id : undefined;
      emitted.push({ method: message.method, threadId, engine, ...(message.method === "thread/started" && threadId ? { recorded: await registry().has(threadId) } : {}) });
    }, () => {});
    await backends.request("initialize", { clientInfo: { name: "backends-identity", version: "1" }, capabilities: { experimentalApi: true } });
    backends.notify({ method: "initialized" });
    return backends;
  };
  const opened: AppServerBackends[] = [];
  const open = async () => { const backends = await create(); opened.push(backends); return backends; };
  const save = async (thread: Message) => {
    const { readFile } = await import("node:fs/promises");
    const path = join(directory, "threads.json");
    const all = await readFile(path, "utf8").then(text => JSON.parse(text) as Record<string, Message>, () => ({} as Record<string, Message>));
    all[String(thread.id)] = thread; await writeFile(path, JSON.stringify(all));
  };
  const engineOf = async (backends: AppServerBackends, threadId: string) => (await backends.request("fixture/ledger", { threadId })).gateway ? "gateway" : "native";
  const classified = async () => { await flushTelemetry(); return (await readTelemetry(state, Date.now() - 60_000)).filter(event => event.event === "gateway_chat_classified"); };
  return { directory, state, nativeHome, registry, emitted, open, save, engineOf, classified,
    async clean() {
      for (const backends of opened) await backends.stop();
      if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
      // Telemetry lines still queued for this state folder must land before it is removed.
      await flushTelemetry(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } };
}

test("thread/start goes where the router's hint says; the provider id in the request never decides", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const backends = await f.open();
    // The native identity's provider id with a gateway hint is a gateway chat ...
    const gateway = await backends.request("thread/start", { fixtureId: "hinted-gateway", model: alias, modelProvider: "openai" }, { engine: "gateway" });
    assert.equal(gateway.fixtureEngine, "gateway");
    assert.equal((gateway.thread as Message).modelProvider, "openai", "the executor got the request as the router sent it");
    // ... and the gateway's own provider id with a native hint, or with no hint at all, starts on the native engine.
    const hinted = await backends.request("thread/start", { fixtureId: "hinted-native", model: nativeModel, modelProvider: "subscription_gateway" }, { engine: "native" });
    assert.equal(hinted.fixtureEngine, "native");
    const unhinted = await backends.request("thread/start", { fixtureId: "unhinted", model: nativeModel, modelProvider: "subscription_gateway" });
    assert.equal(unhinted.fixtureEngine, "native");
    assert.equal(await f.registry().has("hinted-native"), false, "only gateway chats are recorded");
  } finally { await f.clean(); }
});

test("a new gateway chat and its forks are recorded before the reply returns; throwaway chats are not", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const backends = await f.open();
    await backends.request("thread/start", { fixtureId: "recorded-start", model: alias, modelProvider: "subscription_gateway" }, { engine: "gateway" });
    // The reply has returned, so the record is on disk already: nothing waits for the thread/started notification.
    assert.equal(await f.registry().has("recorded-start"), true);
    await backends.request("thread/fork", { threadId: "recorded-start", fixtureId: "recorded-fork" });
    assert.equal(await f.registry().has("recorded-fork"), true);
    await backends.request("thread/start", { fixtureId: "throwaway-start", model: alias, ephemeral: true }, { engine: "gateway" });
    await backends.request("thread/fork", { threadId: "recorded-start", fixtureId: "throwaway-fork", experimentalPredictionMode: true, ephemeral: true });
    assert.equal(await f.registry().has("throwaway-start"), false); assert.equal(await f.registry().has("throwaway-fork"), false);
    // The announcements carry the gateway engine's kind. The client sees a new chat's announcement only after its reply
    // (the session holds it; codex-shim-thread-order covers that), so the reply's record is the one that counts.
    const announced = await until(() => { const found = f.emitted.filter(event => event.method === "thread/started"); return found.length === 4 ? found : undefined; });
    assert.deepEqual(announced.map(event => [event.threadId, event.engine]), [["recorded-start", "gateway"], ["recorded-fork", "gateway"], ["throwaway-start", "gateway"], ["throwaway-fork", "gateway"]]);
  } finally { await f.clean(); }
});

for (const identity of gatewayIdentities) test(`a sub-agent a gateway engine announces is recorded before the announcement goes on (${identity.name})`, { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const backends = await f.open();
    await backends.request("thread/start", { fixtureId: "parent", model: alias, modelProvider: "subscription_gateway" }, { engine: "gateway" });
    // The e7 shape: the sub-agent names a native model, and under the native identity a native provider id too.
    await backends.request("fixture/spawn", { threadId: "parent", child: "sub-agent", provider: identity.provider });
    const announced = f.emitted.find(event => event.method === "thread/started" && event.threadId === "sub-agent");
    assert.deepEqual(announced, { method: "thread/started", threadId: "sub-agent", engine: "gateway", recorded: true });
    // A later connection, which never saw the spawn, still sends the sub-agent to the gateway.
    const later = await f.open();
    await later.request("thread/resume", { threadId: "sub-agent" });
    assert.equal(await f.engineOf(later, "sub-agent"), "gateway");
    // A native engine's announcement is handed on as native and recorded nowhere.
    await backends.request("thread/start", { fixtureId: "native-chat", model: nativeModel }, { engine: "native" });
    assert.deepEqual(await until(() => f.emitted.find(event => event.threadId === "native-chat")), { method: "thread/started", threadId: "native-chat", engine: "native", recorded: false });
  } finally { await f.clean(); }
});

for (const identity of gatewayIdentities) test(`a sub-agent is recorded before its announcement even while a thread/start on the same engine is pending (${identity.name})`, { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const backends = await f.open();
    await backends.request("thread/start", { fixtureId: "parent", model: alias, modelProvider: "subscription_gateway" }, { engine: "gateway" });
    // This start is still unanswered, so the engine counts a chat as being created: the announcement of an ordinary chat is
    // left to that request, but a sub-agent has no request of its own and must be recorded by its announcement.
    const pending = backends.request("thread/start", { fixtureId: "slow", model: alias, modelProvider: "subscription_gateway", hold: true }, { engine: "gateway" });
    let answered = false; void pending.then(() => { answered = true; }, () => { answered = true; });
    await delay(50);
    await backends.request("fixture/spawn", { threadId: "parent", child: "pending-sub-agent", provider: identity.provider });
    const announced = await until(() => f.emitted.find(event => event.method === "thread/started" && event.threadId === "pending-sub-agent"));
    assert.equal(answered, false, "the start was still pending when the sub-agent was announced");
    assert.deepEqual(announced, { method: "thread/started", threadId: "pending-sub-agent", engine: "gateway", recorded: true });
    await backends.request("fixture/release", { threadId: "parent" });
    assert.equal((await pending).fixtureEngine, "gateway");
    assert.equal(await f.registry().has("slow"), true, "the pending start is recorded by its own request");
  } finally { await f.clean(); }
});

for (const identity of gatewayIdentities) test(`the probe path classifies a saved chat by provider, registry, parent and alias (${identity.name})`, { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    await f.save({ id: "saved-alias", model: alias, modelProvider: identity.provider });
    // A gateway chat on a native slug is only known by its registry entry, and its sub-agent by that parent.
    await f.save({ id: "saved-registry", model: nativeModel, modelProvider: identity.provider });
    await f.registry().record("saved-registry", "start");
    await f.save({ id: "saved-child", model: nativeModel, modelProvider: "openai", source: { subAgent: { thread_spawn: { parent_thread_id: "saved-registry" } } } });
    await f.save({ id: "saved-native", model: nativeModel, modelProvider: "openai" });
    const backends = await f.open();
    for (const id of ["saved-alias", "saved-registry", "saved-child", "saved-native"]) await backends.request("thread/resume", { threadId: id });
    assert.deepEqual(await Promise.all(["saved-alias", "saved-registry", "saved-child", "saved-native"].map(id => f.engineOf(backends, id))),
      ["gateway", "gateway", "gateway", "native"]);
    // The classification is recorded once per chat on this connection, with the rule and the method only.
    const events = await f.classified();
    assert.deepEqual(events.map(event => [event.rule, event.method]).sort(), [
      [identity.name !== "openai" ? "legacy_provider" : "alias", "thread/resume"],
      ["native", "thread/resume"],
      ["parent", "thread/resume"],
      [identity.name !== "openai" ? "legacy_provider" : "registry", "thread/resume"],
    ].sort());
    for (const event of events) assert.deepEqual(Object.keys(event).sort(), ["at", "component", "event", "host", "method", "pid", "rule"]);
  } finally { await f.clean(); }
});

for (const identity of gatewayIdentities) test(`an unavailable shared host still answers a native chat's read and refuses a gateway chat's (${identity.name})`, { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    await f.save({ id: "native-read", model: nativeModel, modelProvider: "openai" });
    await f.save({ id: "gateway-read", model: alias, modelProvider: identity.provider });
    await f.save({ id: "registry-read", model: nativeModel, modelProvider: identity.provider }); await f.registry().record("registry-read", "start");
    const backends = await f.open();
    // The plan shares gateway chats, but this adapter cannot reach the host (it has no configuration path to find it).
    (backends as unknown as { sharedGateway: boolean }).sharedGateway = true;
    const read = await backends.request("thread/read", { threadId: "native-read" });
    assert.equal((read.thread as Message).id, "native-read");
    for (const id of ["gateway-read", "registry-read"]) await assert.rejects(backends.request("thread/read", { threadId: id }), { code: -32001 });
  } finally { await f.clean(); }
});
