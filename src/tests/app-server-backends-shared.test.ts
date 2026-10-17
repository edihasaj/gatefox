import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { AppServerBackends } from "../app-server-backends.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { startExecutionHost, executionHostHome } from "../execution-host.js";
import { SocketAppServerConnection } from "../socket-app-server-connection.js";
import type { Message } from "../app-server-connection.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { SharedNativeConnection } from "../shared-native-connection.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";
import { gatewayIdentities } from "./identity-cases.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.

const alias = "claude/fixture";
type FeatureVariant = "legacy" | "canonical";
async function fixture(featureVariant?: FeatureVariant, priority?: boolean, sharedNative = false, gatewayIntent?: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "gw-backends-"));
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  const nativeConfig = 'model = "native-original"\n' + (priority === undefined ? "" : "[features]\nfast_mode = false\n");
  await writeFile(join(nativeHome, "config.toml"), nativeConfig, { mode: 0o600 });
  const sdk = join(directory, "codex");
  await writeFile(sdk, `#!${process.execPath}
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {WebSocketServer} from ${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)};
if(process.argv.includes('--version')){console.log('codex-cli 0.162.0-alpha.17.2');process.exit(0);}
const args=process.argv.slice(2);const root=args[args.indexOf('--fixture-root')+1];const saved=root+'/threads.json';const loaded=new Set();const turns=new Map();
const cliFeatures={};for(let i=0;i<args.length;i++)if(args[i]==='-c'){const value=args[++i];const equal=value.indexOf('=');const key=value.slice(0,equal);if(key.startsWith('features.')){try{cliFeatures[key]=JSON.parse(value.slice(equal+1));}catch{}}}
for(let i=0;i<args.length;i++){const arg=args[i];if((arg==='--enable'||arg==='--disable')&&args[i+1]==='fast_mode'){cliFeatures['features.fast_mode']=arg==='--enable';i++;}else if(arg==='--enable=fast_mode'||arg==='--disable=fast_mode')cliFeatures['features.fast_mode']=arg.startsWith('--enable');}
function metadata(){return existsSync(saved)?JSON.parse(readFileSync(saved,'utf8')):{};}
async function rpc(m,send,drop){if(m.id==null)return;let result={};
if(m.method==='config/read')result={config:{agents:{max_concurrent_threads_per_session:30}}};
if(m.method==='fixture/features')result={cliFeatures};
if(m.method==='turn/start')result={wireServiceTier:cliFeatures['features.fast_mode']===false?null:m.params.serviceTier??null,effort:m.params.effort,approvalPolicy:m.params.approvalPolicy,sandboxPolicy:m.params.sandboxPolicy};
if(m.method==='turn/start'&&m.params.fixtureActive){const turn={id:'fixture-active-turn',status:'inProgress'};turns.set(m.params.threadId,turn);result.turn=turn;send({method:'turn/started',params:{threadId:m.params.threadId,turn}});}
if(m.method==='turn/interrupt'){const turn=turns.get(m.params.threadId);if(turn?.id!==m.params.turnId){send({id:m.id,error:{code:-32600,message:'Wrong active fixture turn'}});return;}turn.status='interrupted';send({method:'turn/completed',params:{threadId:m.params.threadId,turn}});}
if(m.method==='thread/read'){const thread=metadata()[m.params.threadId];const live=listen.startsWith('unix://')&&loaded.has(m.params.threadId);const turn=turns.get(m.params.threadId);result={executorPid:process.pid,thread:thread?{...thread,status:live?{type:turn?.status==='inProgress'?'active':'idle',activeFlags:[]}:{type:'notLoaded'},turns:live?(turn?[turn]:[]):[{id:'stale-file-turn',status:'interrupted'}]}:{id:m.params.threadId,modelProvider:'openai'}};}
if(m.method==='thread/queue/add'){const item=(m.params.input||[]).find(i=>i.type==='localImage');if(item){if(item.path.includes('/protected/')){send({id:m.id,error:{code:-32600,message:'local queued attachment is invalid: Operation not permitted (os error 1)'}});return;}let size=0;try{size=readFileSync(item.path).length;}catch(e){send({id:m.id,error:{code:-32600,message:'local queued attachment is invalid: '+e.code+' '+item.path}});return;}result={readPath:item.path,size};}else result={readPath:null};}
if(m.method==='thread/loaded/list')result={data:[...loaded],nextCursor:null};
if(m.method==='thread/start'){
if(m.params.delayMs)await new Promise(r=>setTimeout(r,m.params.delayMs));
const id=m.params.fixtureId;const thread={id,modelProvider:m.params.modelProvider||'subscription_gateway',model:m.params.model};
const all=metadata();all[id]=thread;writeFileSync(saved,JSON.stringify(all));loaded.add(id);result={thread,model:m.params.model,modelProvider:thread.modelProvider,executorPid:process.pid,serviceTier:m.params.serviceTier??null};
}
if(m.method==='thread/resume'){const thread=metadata()[m.params.threadId];if(!thread){send({id:m.id,error:{code:-32600,message:'Unknown fixture thread'}});return;}loaded.add(thread.id);result={thread,model:thread.model,modelProvider:m.params.modelProvider||thread.modelProvider,executorPid:process.pid};}
if(m.method==='thread/unsubscribe')loaded.delete(m.params.threadId);
if(m.method==='fixture/disconnect'){drop();return;}
send({id:m.id,result});}
const listen=args.includes('--listen')?args[args.indexOf('--listen')+1]:'stdio://';
if(listen.startsWith('unix://')){
const socket=listen.slice(7);const server=createServer();const ws=new WebSocketServer({server});
ws.on('connection',client=>client.on('message',bytes=>{void rpc(JSON.parse(bytes),m=>client.send(JSON.stringify(m)),()=>client.close(1000));}));
server.listen(socket,()=>{chmodSync(socket,0o600);process.stdout.write('FIXTURE_READY\\n');});
process.on('SIGTERM',()=>{for(const c of ws.clients)c.terminate();server.close(()=>process.exit(0));});
}else{createInterface({input:process.stdin}).on('line',line=>{void rpc(JSON.parse(line),m=>process.stdout.write(JSON.stringify(m)+'\\n'),()=>process.exit(0));});}
`, { mode: 0o700 });
  const configPath = join(directory, "gateway.json");
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: join(directory, "state"), providers: [], clientOnly: true };
  if (gatewayIntent !== undefined) await writePrivateJson(join(config.stateDirectory, "service-plan.json"), { version: 1, config: configPath, sharedExecutors: gatewayIntent,
    components: [{ id: "native", kind: "native", command: sdk, args: ["--codex", sdk, "--native-home", nativeHome], log: join(config.stateDirectory, "native.log") }] });
  const previousHome = process.env.CODEX_HOME; process.env.CODEX_HOME = nativeHome;
  const host = await startExecutionHost({ config, configPath, nativeHome, codex: sdk });
  const nativeSocket = join(directory, "original-native.sock");
  const nativeOwner = sharedNative ? spawn(sdk, ["app-server", "--listen", "unix://" + nativeSocket, "--fixture-root", directory], { stdio: ["ignore", "pipe", "ignore"] }) : undefined;
  const nativeOwnerExited = nativeOwner && new Promise<void>(resolve => nativeOwner.once("close", () => resolve()));
  let control: SocketAppServerConnection | undefined;
  const adapters = new Set<AppServerBackends>();
  const clean = async () => {
    const failures: unknown[] = [];
    const collect = (results: PromiseSettledResult<unknown>[]) => { for (const result of results) if (result.status === "rejected") failures.push(result.reason); };
    collect(await Promise.allSettled([...adapters].map(adapter => adapter.stop())));
    control?.stop();
    const stopNative = async () => {
      if (!nativeOwner || !nativeOwnerExited) return;
      nativeOwner.kill("SIGTERM");
      const timer = setTimeout(() => nativeOwner.kill("SIGKILL"), 1500);
      try { await nativeOwnerExited; } finally { clearTimeout(timer); }
    };
    collect(await Promise.allSettled([control?.exited, host.close(), stopNative()]));
    process.env.CODEX_HOME = previousHome; if (previousHome === undefined) delete process.env.CODEX_HOME;
    collect(await Promise.allSettled([rm(directory, { recursive: true, force: true }), rm(executionHostHome(configPath, nativeHome), { recursive: true, force: true })]));
    if (failures.length) throw new AggregateError(failures, "Shared backend fixture cleanup failed");
  };
  try {
  if (nativeOwner) await new Promise<void>((resolve, reject) => {
    // A socket directory entry can precede listen readiness on macOS. Wait for
    // the fake SDK's bound, owner-only listener rather than its path alone.
    let output = "";
    const ready = (chunk: Buffer) => { output += chunk.toString(); if (output.includes("FIXTURE_READY\n")) finish(); };
    const exited = () => finish(new Error("Shared native fixture exited before readiness"));
    const failed = () => finish(new Error("Shared native fixture failed before readiness"));
    const timer = setTimeout(() => finish(new Error("Shared native fixture socket did not start")), 5000);
    const finish = (error?: Error) => {
      clearTimeout(timer); nativeOwner.stdout?.off("data", ready); nativeOwner.off("close", exited); nativeOwner.off("error", failed);
      if (error) reject(error); else resolve();
    };
    nativeOwner.stdout?.on("data", ready); nativeOwner.once("close", exited); nativeOwner.once("error", failed);
  });
  control = new SocketAppServerConnection(join(executionHostHome(configPath, nativeHome), "host.sock"), async () => {}); await control.ready;
  let generation = 0;
  const snapshot = () => ({ revision: String(generation).repeat(64), models: [{ slug: alias, display_name: "Fixture " + generation, ...(priority ? { service_tiers: [{ id: "priority", name: "Fast", description: "Priority route" }], default_service_tier: null } : {}) }] });
  const catalog = { current: snapshot, refresh: async () => snapshot(), combined: (value: ReturnType<typeof snapshot>) => ({ models: value.models }) } as unknown as DesktopCatalog;
  const events: Message[] = [];
  let nativeExits = 0;
  const createBackend = async (reverse = false, variant = featureVariant) => {
    const entries: [string, unknown][] = [["agents", { max_concurrent_threads_per_session: 30 }], ["web_search", "disabled"], ["sandbox_mode", "read-only"]];
    const featureArgs: string[] = [];
    if (variant) {
      const core = { code_mode: { enabled: true, default_exec_yield_time_ms: 1500, experimental_show_cell_overhead: true }, guardianv2: { enabled: true, persist_scores: false, review_threshold: 0.6 } };
      entries.push(["features", variant === "legacy" ? { ...core, codex_hooks: false, code_mode_tool_description_first: true, guardianv2: { ...core.guardianv2, thread_context: false } } : { ...core, hooks: false }]);
      featureArgs.push("-c", variant === "legacy" ? "features.codex_hooks=false" : "features.hooks=false", "-c", "features.code_mode.enabled=true");
      if (variant === "legacy") featureArgs.push("-c", "features.code_mode_tool_description_first=true", "-c", "features.guardianv2.thread_context=false");
    }
    const settings = Object.fromEntries(reverse ? entries.reverse() : entries);
    if (priority !== undefined) { settings.features = { ...(settings.features as Message || {}), fast_mode: false }; featureArgs.push("-c", "features.fast_mode=false", "--disable=fast_mode"); }
    const args = ["app-server", "--listen", "stdio://", "--fixture-root", directory, ...featureArgs];
    const emit = async (message: Message) => { events.push(message); }; const exited = () => { nativeExits++; };
    const adapter = gatewayIntent === undefined ? new AppServerBackends(sdk, args, config, settings, {}, catalog, emit, exited, configPath,
      sharedNative ? (_args, onMessage, onExit) => new SharedNativeConnection(nativeSocket, onMessage, onExit) : undefined)
      : await AppServerBackends.create(sdk, args, config, settings, {}, catalog, emit, exited, configPath);
    adapters.add(adapter); return adapter;
  };
  const backends = await createBackend();
  await backends.request("initialize", { clientInfo: { name: "fixture", version: "1" }, capabilities: { experimentalApi: true } }); backends.notify({ method: "initialized" });
  return { config, directory, nativeHome, nativeConfig, backends, control, events, nativeExits: () => nativeExits, next: () => { generation++; },
    async another(variant?: FeatureVariant) { const adapter = await createBackend(true, variant); await adapter.request("initialize", { clientInfo: { name: "second-fixture", version: "1" }, capabilities: { experimentalApi: true } }); adapter.notify({ method: "initialized" }); return adapter; },
    // `provider` is the id the chat is saved with; the gateway hint, not the id, sends the start to the shared executor.
    start: (id: string, delayMs = 0, provider = "subscription_gateway") => backends.request("thread/start", { fixtureId: id, delayMs, model: alias, modelProvider: provider }, { engine: "gateway" }),
    clean,
  };
  } catch (error) {
    try { await clean(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Shared backend fixture setup failed"); }
    throw error;
  }
}

test("adapter releases a closed chat's generation before acquiring a fifth catalog", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 4; index++) { await f.start("chat-" + index); f.next(); }
    await assert.rejects(f.start("chat-4"), /Four gateway generations/);
    await f.backends.request("thread/unsubscribe", { threadId: "chat-0" });
    assert.equal(((await f.start("chat-4")).thread as Message).id, "chat-4");
    const status = await f.control.request("execution/status", {}); assert.equal((status.generations as unknown[]).length, 4);
    assert.deepEqual(await f.control.request("execution/find", { threadId: "chat-0" }), { found: false });
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model = "native-original"\n');
  } finally { await f.clean(); }
});

test("a per-connection factory plan does not inherit an older gateway-only host", { timeout: 20000 }, async () => {
  const f = await fixture(undefined, undefined, false, false);
  try {
    const started = await f.start("per-connection-intent-chat");
    assert.equal(((await f.control.request("execution/status", {})).generations as Message[]).length, 0);
    assert.notEqual(started.executorPid, (await f.backends.native.request("thread/read", { threadId: "ordinary-native-chat" })).executorPid);
    assert.equal(f.backends.native.closed, false); assert.equal(f.backends.native.shared, undefined);
  } finally { await f.clean(); }
});

test("required gateway sharing refuses fallback during host outage while native chats stay usable", { timeout: 20000 }, async () => {
  const f = await fixture(undefined, undefined, false, true);
  const ownerPath = join(executionHostHome(join(f.directory, "gateway.json"), f.nativeHome), "owner.json");
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  try {
    await writePrivateJson(ownerPath, { ...owner, state: "stopped", pid: 0 });
    await assert.rejects(f.start("must-not-fallback"), (error: Error & { code?: number }) => error.code === -32001 && /unavailable/.test(error.message));
    assert.equal(((await f.control.request("execution/status", {})).generations as Message[]).length, 0);
    await assert.rejects(access(join(f.config.stateDirectory, "desktop-generations")), { code: "ENOENT" });
    const native = await f.backends.request("thread/read", { threadId: "ordinary-native-chat" });
    assert.equal((native.thread as Message).modelProvider, "openai"); assert.equal(f.backends.native.closed, false);
  } finally { await writePrivateJson(ownerPath, owner); await f.clean(); }
});

test("a second adapter reads and stops a shared active gateway chat before consulting stale native metadata", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const started = await f.start("shared-active-chat");
    const turn = (await f.backends.request("turn/start", { threadId: "shared-active-chat", fixtureActive: true })).turn as Message;
    const second = await f.another();
    const stale = await second.native.request("thread/read", { threadId: "shared-active-chat", includeTurns: true });
    assert.equal(((stale.thread as Message).status as Message).type, "notLoaded");
    assert.equal((((stale.thread as Message).turns as Message[])[0]).status, "interrupted");
    const live = await second.request("thread/read", { threadId: "shared-active-chat", includeTurns: true });
    assert.equal(live.executorPid, started.executorPid); assert.equal(((live.thread as Message).status as Message).type, "active");
    assert.equal((((live.thread as Message).turns as Message[])[0]).id, turn.id);
    await second.request("turn/interrupt", { threadId: "shared-active-chat", turnId: turn.id });
    const stopped = await second.request("thread/read", { threadId: "shared-active-chat", includeTurns: true });
    assert.equal(stopped.executorPid, started.executorPid); assert.equal((((stopped.thread as Message).turns as Message[])[0]).status, "interrupted");
    const unknown = await second.request("thread/read", { threadId: "ordinary-native-chat" });
    assert.notEqual(unknown.executorPid, started.executorPid); assert.equal((unknown.thread as Message).modelProvider, "openai");
    assert.equal(((await f.control.request("execution/status", {})).generations as Message[]).length, 1);
  } finally { await f.clean(); }
});

test("shared gateway socket loss leaves legacy native work alive and never invents gateway completion", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const started = await f.start("shared-loss-chat");
    await f.backends.request("turn/start", { threadId: "shared-loss-chat", fixtureActive: true });
    await assert.rejects(f.backends.request("fixture/disconnect", { threadId: "shared-loss-chat" }), /socket closed/);
    for (let attempt = 0; attempt < 100 && !f.events.some(message => message.method === "error"); attempt++) await delay(5);
    assert.equal(f.events.some(message => message.method === "error"), true);
    assert.equal(f.events.some(message => message.method === "turn/completed"), false);
    assert.equal(f.nativeExits(), 0); assert.equal(f.backends.native.closed, false);
    await f.backends.native.request("fixture/features", {});
    const second = await f.another(); const live = await second.request("thread/read", { threadId: "shared-loss-chat", includeTurns: true });
    assert.equal(live.executorPid, started.executorPid); assert.equal(((live.thread as Message).status as Message).type, "active");
  } finally { await f.clean(); }
});

test("intentional idle gateway retirement keeps a shared-native frontend connected", { timeout: 20000 }, async () => {
  const f = await fixture(undefined, undefined, true);
  try {
    const first = await f.start("retired-idle-chat"); await f.backends.request("thread/unsubscribe", { threadId: "retired-idle-chat" });
    f.next(); const second = await f.start("new-catalog-chat"); await delay(20);
    assert.notEqual(second.executorPid, first.executorPid); assert.equal(f.nativeExits(), 0);
    assert.equal(f.backends.native.closed, false); await f.backends.native.request("fixture/features", {});
  } finally { await f.clean(); }
});

test("unexpected shared gateway loss closes only frontend transport when native also is shared", { timeout: 20000 }, async () => {
  const f = await fixture(undefined, undefined, true);
  try {
    const started = await f.start("both-shared-loss-chat"); await f.backends.request("turn/start", { threadId: "both-shared-loss-chat", fixtureActive: true });
    await assert.rejects(f.backends.request("fixture/disconnect", { threadId: "both-shared-loss-chat" }), /socket closed/);
    for (let attempt = 0; attempt < 100 && !f.nativeExits(); attempt++) await delay(5);
    assert.equal(f.nativeExits(), 1); assert.equal(f.backends.native.closed, false);
    assert.equal(f.events.some(message => message.method === "error" || message.method === "turn/completed"), false);
    await f.backends.native.request("fixture/features", {});
    const second = await f.another(); const live = await second.request("thread/read", { threadId: "both-shared-loss-chat", includeTurns: true });
    assert.equal(live.executorPid, started.executorPid); assert.equal(((live.thread as Message).status as Message).type, "active");
  } finally { await f.clean(); }
});

for (const identity of gatewayIdentities) test(`gateway ownership lookup outage preserves verified native reads and fails closed for gateway history (${identity.name})`, { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    await f.start("gateway-lookup-outage", 0, identity.provider); const second = await f.another(); await f.control.request("execution/find", { threadId: "gateway-lookup-outage" });
    await f.control.request("execution/release", { revision: (await f.control.request("execution/find", { threadId: "gateway-lookup-outage" })).revision });
    // Fresh discovery cannot use this isolated execution host; native children stay alive.
    const state = second as unknown as { pool: () => Promise<unknown> }; await state.pool();
    const ownerPath = join(executionHostHome(join(f.directory, "gateway.json"), f.nativeHome), "owner.json");
    const owner = JSON.parse(await readFile(ownerPath, "utf8")); await writeFile(ownerPath, JSON.stringify({ ...owner, state: "stopped" }), { mode: 0o600 });
    // An already-open control connection can still respond; force rediscovery.
    const holder = second as unknown as { poolPending?: Promise<{ close(): void }> }; (await holder.poolPending)?.close(); await delay(5);
    const native = await second.request("thread/read", { threadId: "ordinary-native-chat" }); assert.equal((native.thread as Message).modelProvider, "openai");
    await assert.rejects(second.request("thread/read", { threadId: "gateway-lookup-outage" }), /unavailable/);
    assert.equal(second.native.closed, false);
    await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
  } finally { await f.clean(); }
});

test("independent adapters share one writer despite different native settings key order", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const second = await f.another();
    const firstStart = await f.start("first-adapter");
    const secondStart = await second.request("thread/start", { fixtureId: "second-adapter", model: alias, modelProvider: "subscription_gateway" }, { engine: "gateway" });
    assert.equal(secondStart.executorPid, firstStart.executorPid);
    const status = await f.control.request("execution/status", {}); assert.equal((status.generations as Message[]).length, 1);
    assert.equal((await f.control.request("execution/find", { threadId: "first-adapter" })).revision, (await f.control.request("execution/find", { threadId: "second-adapter" })).revision);
  } finally { await f.clean(); }
});

test("legacy and canonical feature settings share one writer and retain current feature values", { timeout: 20000 }, async () => {
  const f = await fixture("legacy");
  try {
    const canonical = await f.another("canonical");
    const first = await f.start("legacy-feature-chat");
    const second = await canonical.request("thread/start", { fixtureId: "canonical-feature-chat", model: alias, modelProvider: "subscription_gateway" }, { engine: "gateway" });
    assert.equal(first.executorPid, second.executorPid);
    const oldOwner = await f.control.request("execution/find", { threadId: "legacy-feature-chat" });
    const newOwner = await f.control.request("execution/find", { threadId: "canonical-feature-chat" });
    assert.equal(oldOwner.revision, newOwner.revision);
    assert.equal((await f.control.request("execution/status", {})).generations instanceof Array, true);
    assert.equal(((await f.control.request("execution/status", {})).generations as Message[]).length, 1);
    const observed = await f.backends.request("fixture/features", { threadId: "legacy-feature-chat" });
    assert.deepEqual(observed.cliFeatures, { "features.hooks": false, "features.code_mode.enabled": true, "features.step_model_switching": true });
    const snapshot = await readFile(join(f.config.stateDirectory, "desktop-generations", "shared-v1-" + oldOwner.revision, "desktop-engine", "config.toml"), "utf8");
    assert.equal(snapshot.includes("codex_hooks"), false); assert.equal(snapshot.includes("code_mode_tool_description_first"), false); assert.equal(snapshot.includes("thread_context"), false);
    assert.match(snapshot, /"hooks" = false/);
    assert.match(snapshot, /"code_mode" = \{ "enabled" = true, "default_exec_yield_time_ms" = 1500, "experimental_show_cell_overhead" = true \}/);
    assert.match(snapshot, /"guardianv2" = \{ "enabled" = true, "persist_scores" = false, "review_threshold" = 0\.6 \}/);
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model = "native-original"\n');
  } finally { await f.clean(); }
});

test("shared priority-capable executors enable fast mode while native flags and standard default remain intact", { timeout: 20000 }, async () => {
  const f = await fixture(undefined, true);
  try {
    assert.equal(((await f.backends.native.request("fixture/features", {})).cliFeatures as Message)["features.fast_mode"], false);
    const standard = await f.start("priority-capable-standard-chat"); assert.equal(standard.serviceTier, null);
    const gateway = (await f.backends.request("fixture/features", { threadId: "priority-capable-standard-chat" })).cliFeatures as Message;
    assert.equal(gateway["features.fast_mode"], true);
    const request = { threadId: "priority-capable-standard-chat", serviceTier: "priority", effort: "high", approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } };
    assert.deepEqual(await f.backends.request("turn/start", request), { wireServiceTier: "priority", effort: "high", approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } });
    assert.equal((await f.backends.request("turn/start", { ...request, serviceTier: null })).wireServiceTier, null);
    assert.equal(((await f.backends.native.request("fixture/features", {})).cliFeatures as Message)["features.fast_mode"], false);
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), f.nativeConfig);
    const owner = await f.control.request("execution/find", { threadId: "priority-capable-standard-chat" });
    const snapshot = await readFile(join(f.config.stateDirectory, "desktop-generations", "shared-v1-" + owner.revision, "desktop-engine", "config.toml"), "utf8");
    assert.match(snapshot, /"fast_mode" = false/); assert.equal(snapshot.includes('"service_tier" = "priority"'), false);
  } finally { await f.clean(); }
});

test("shared executors without priority metadata do not override the native fast-mode setting", { timeout: 20000 }, async () => {
  const f = await fixture(undefined, false);
  try {
    const standard = await f.start("ordinary-chat"); assert.equal(standard.serviceTier, null);
    const gateway = (await f.backends.request("fixture/features", { threadId: "ordinary-chat" })).cliFeatures as Message;
    assert.equal(gateway["features.fast_mode"], false);
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), f.nativeConfig);
  } finally { await f.clean(); }
});

test("parallel starts survive catalog changes before their first SDK response", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const older = f.start("delayed-chat", 100); f.next(); const newer = f.start("newer-chat", 10);
    const results = await Promise.all([older, newer]); assert.deepEqual(results.map(value => (value.thread as Message).id), ["delayed-chat", "newer-chat"]);
    assert.notEqual((await f.control.request("execution/find", { threadId: "delayed-chat" })).revision, (await f.control.request("execution/find", { threadId: "newer-chat" })).revision);
  } finally { await f.clean(); }
});

test("SDK client disconnect resumes through the same live writer and retains its new lease", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const started = await f.start("reconnect-chat"); const original = await f.control.request("execution/find", { threadId: "reconnect-chat" });
    await assert.rejects(f.backends.request("fixture/disconnect", { threadId: "reconnect-chat" }), /socket closed/);
    const resumed = await f.backends.request("thread/resume", { threadId: "reconnect-chat", model: alias });
    assert.equal(resumed.executorPid, started.executorPid); assert.equal((resumed.thread as Message).id, "reconnect-chat");
    assert.equal((await f.control.request("execution/find", { threadId: "reconnect-chat" })).revision, original.revision);
    await f.backends.request("thread/unsubscribe", { threadId: "reconnect-chat" });
    // Reacquired same-generation connection must retain its lease even while empty.
    const descriptor = (digit: string) => ({ revision: digit.repeat(64), args: ["app-server", "--fixture-root", f.directory], settings: {}, catalog: { models: [{ slug: alias }] }, aliases: [alias] });
    for (const digit of ["a", "b", "c"]) await f.control.request("execution/acquire", descriptor(digit));
    await assert.rejects(f.control.request("execution/acquire", descriptor("d")), /Four gateway generations/);
    const status = await f.control.request("execution/status", {});
    assert.equal((status.generations as Message[]).filter(value => value.revision === original.revision).length, 1);
    assert.equal((status.generations as Message[]).length, 4);
  } finally { await f.clean(); }
});

async function queuedImage(f: Awaited<ReturnType<typeof fixture>>, directory: string) {
  await mkdir(join(f.directory, directory), { recursive: true });
  const path = join(f.directory, directory, "shot.png"); await writeFile(path, "png-bytes"); return path;
}
const queueAdd = (f: Awaited<ReturnType<typeof fixture>>, threadId: string, path: string) =>
  f.backends.request("thread/queue/add", { threadId, clientUserMessageId: "m1", input: [{ type: "localImage", path }] });

test("a service-owned gateway executor reads queued attachments from a staged copy, which is removed afterwards", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    await f.start("queue-chat");
    // The fixture refuses files under protected/, as the service is refused the user's private folders.
    const original = await queuedImage(f, "protected");
    const result = await queueAdd(f, "queue-chat", original);
    assert.match(String(result.readPath), /queued-attachments\/[0-9a-f-]+\.png$/); assert.equal(result.size, 9);
    assert.deepEqual(await readdir(join(f.config.stateDirectory, "queued-attachments")), [], "the copy does not outlive the call");
    assert.equal(await readFile(original, "utf8"), "png-bytes");
  } finally { await f.clean(); }
});

test("a per-connection gateway executor keeps the attached path as the desktop sent it", { timeout: 20000 }, async () => {
  const f = await fixture(undefined, undefined, false, false);
  try {
    await f.start("queue-chat");
    const original = await queuedImage(f, "attachments");
    assert.equal((await queueAdd(f, "queue-chat", original)).readPath, original);
    await assert.rejects(access(join(f.config.stateDirectory, "queued-attachments")), { code: "ENOENT" });
  } finally { await f.clean(); }
});

test("an attachment the adapter cannot read reaches the SDK unchanged so its own error is reported", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    await f.start("queue-chat");
    const missing = join(f.directory, "gone", "shot.png");
    await assert.rejects(queueAdd(f, "queue-chat", missing), (error: Error & { code?: number }) => error.code === -32600 && error.message === "local queued attachment is invalid: ENOENT " + missing);
  } finally { await f.clean(); }
});
