import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerBackends } from "../app-server-backends.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import { startExecutionHost, executionHostHome } from "../execution-host.js";
import { ExecutionHostClient } from "../execution-host-client.js";
import { object, type Message } from "../app-server-connection.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { setHostDownWindowForTests } from "../executor-reattach.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // The SDK rendezvous, host homes and native-home receipts stay in this file's own folder.
hostRunsInThisProcess(); // The shared host runs inside the test process: see src/tests/in-process-host.ts.

const alias = "claude/fixture"; const otherAlias = "claude/other";
type Logged = { pid: number; method: string; threadId?: string; turnId?: string; modelProvider?: string; model?: string; cwd?: string; runtimeWorkspaceRoots?: string[];
  approvalPolicy?: string; text?: string; excludeTurns?: boolean; config?: Message; serviceTier?: string | null };

/**
 * A fake SDK that plays the native engine (stdio) and the host's gateway generations (a Unix socket). Saved chats live in
 * `<root>/threads.json`, shared by every process as rollouts are; every request a process answers is appended to
 * `<root>/log.jsonl` with the process id, so a test sees which executor got which request. Like the real one, a thread/start
 * or a turn that carries one saves the chat's model, reasoning effort and approval policy, and a thread/resume restores the
 * saved values (and the saved cwd, which a turn or a settings update changes and an explicit resume cwd overrides) unless the resume names a model or provider itself or carries a `config.model` / `config.model_reasoning_effort`
 * key (the SDK's own gate). `fixtureActive` on turn/start leaves the turn running; `fixture/exit` ends a stdio executor as a
 * crash would; `fixture/close` unloads a chat as the engine's own `thread/closed` would; a `<root>/refuse-resume` file makes
 * every executor refuse to resume.
 */
async function fixture(options: { shared?: boolean } = {}) {
  const shared = options.shared ?? true;
  const directory = await mkdtemp(join(tmpdir(), "gw-reattach-"));
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  await writeFile(join(nativeHome, "config.toml"), 'model = "native-original"\n', { mode: 0o600 });
  const sdk = join(directory, "codex");
  await writeFile(sdk, `#!${process.execPath}
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,existsSync,chmodSync,appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {WebSocketServer} from ${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)};
if(process.argv.includes('--version')){console.log('codex-cli 0.162.0-alpha.17.2');process.exit(0);}
const args=process.argv.slice(2);const root=args[args.indexOf('--fixture-root')+1];const saved=root+'/threads.json';const turns=new Map();const loaded=new Set();let sequence=0;
const all=()=>existsSync(saved)?JSON.parse(readFileSync(saved,'utf8')):{};
const keep=v=>{const a=all();a[v.id]=v;writeFileSync(saved,JSON.stringify(a));};
const typed=v=>v!==undefined&&v!==null;
const log=(m)=>{const p=m.params||{};appendFileSync(root+'/log.jsonl',JSON.stringify({pid:process.pid,method:m.method,threadId:p.threadId,turnId:p.turnId,modelProvider:p.modelProvider,model:p.model,cwd:p.cwd,runtimeWorkspaceRoots:p.runtimeWorkspaceRoots,approvalPolicy:p.approvalPolicy,excludeTurns:p.excludeTurns,config:p.config,serviceTier:p.serviceTier,text:p.input?.[0]?.text})+'\\n');};
async function rpc(m,send,drop){if(m.id==null)return;log(m);const p=m.params||{};let result={};
if(m.method==='fixture/disconnect'){drop?.();return;}
if(m.method==='fixture/forget-turn'){turns.delete(p.threadId);}
if(m.method==='fixture/reject-turns-list'){writeFileSync(root+'/reject-turns-list','');}
if(m.method==='config/read')result={config:{agents:{max_concurrent_threads_per_session:30}}};
if(m.method==='thread/loaded/list')result={data:[...loaded],nextCursor:null};
if(m.method==='thread/unsubscribe'){loaded.delete(p.threadId);result={status:'unsubscribed'};}
if(m.method==='thread/delete'||m.method==='thread/archive'){loaded.delete(p.threadId);}
if(m.method==='fixture/close'){loaded.delete(p.threadId);send({method:'thread/closed',params:{threadId:p.threadId}});}
if(m.method==='fixture/exit'){send({id:m.id,result:{}});setTimeout(()=>process.exit(3),20);return;}
if(m.method==='thread/start'){const thread={id:p.fixtureId,model:p.model,modelProvider:p.modelProvider||'subscription_gateway',approvalPolicy:typed(p.approvalPolicy)?p.approvalPolicy:'never',effort:typed(p.config&&p.config.model_reasoning_effort)?p.config.model_reasoning_effort:null,serviceTier:typed(p.serviceTier)?p.serviceTier:null,cwd:p.cwd};keep(thread);loaded.add(thread.id);result={thread,model:thread.model,modelProvider:thread.modelProvider,serviceTier:thread.serviceTier};}
if(m.method==='thread/fork'){const parent=all()[p.threadId]||{};const thread={...parent,id:p.fixtureId,model:p.model||parent.model,modelProvider:p.modelProvider||parent.modelProvider,approvalPolicy:typed(p.approvalPolicy)?p.approvalPolicy:parent.approvalPolicy,cwd:typed(p.cwd)?p.cwd:parent.cwd};keep(thread);loaded.add(thread.id);result={thread,model:thread.model,modelProvider:thread.modelProvider,serviceTier:thread.serviceTier||null};}
if(m.method==='thread/resume'){while(existsSync(root+'/hold-resume'))await new Promise(resolve=>setTimeout(resolve,5));if(existsSync(root+'/refuse-resume')){send({id:m.id,error:{code:-32603,message:'the fixture refuses to resume chats'}});return;}
 const thread=all()[p.threadId];if(!thread){send({id:m.id,error:{code:-32600,message:'no rollout found for thread id '+p.threadId}});return;}
 // The SDK's rule: naming a model or provider, or a config.model / config.model_reasoning_effort key, skips its restore.
 const gated=typed(p.model)||typed(p.modelProvider)||(p.config&&(Object.prototype.hasOwnProperty.call(p.config,'model')||Object.prototype.hasOwnProperty.call(p.config,'model_reasoning_effort')));
 const next={...thread,model:gated?(typed(p.model)?p.model:'config-default'):thread.model,modelProvider:gated?(typed(p.modelProvider)?p.modelProvider:'config-default'):thread.modelProvider,
  approvalPolicy:typed(p.approvalPolicy)?p.approvalPolicy:thread.approvalPolicy,effort:gated?(p.config&&typed(p.config.model_reasoning_effort)?p.config.model_reasoning_effort:'config-default'):thread.effort,
  serviceTier:typed(p.serviceTier)?p.serviceTier:thread.serviceTier||null,cwd:typed(p.cwd)?p.cwd:thread.cwd};
 keep(next);loaded.add(next.id);result={thread:next,model:next.model,modelProvider:next.modelProvider,serviceTier:next.serviceTier};}
if(m.method==='thread/read'){const thread=all()[p.threadId];result={thread:thread?{...thread,turns:[]}:{id:p.threadId,modelProvider:'openai'}};}
if(m.method==='thread/turns/list'){while(existsSync(root+'/hold-turns-list'))await new Promise(resolve=>setTimeout(resolve,5));if(existsSync(root+'/reject-turns-list')){send({id:m.id,error:{code:-32603,message:'fixture snapshot rejected'}});return;}const turn=turns.get(p.threadId);result={data:turn?[turn]:[],nextCursor:null};}
if(m.method==='turn/start'){const a=all();const thread=a[p.threadId];
 if(thread){if(p.model)thread.model=p.model;if(p.cwd)thread.cwd=p.cwd;if(p.approvalPolicy)thread.approvalPolicy=p.approvalPolicy;if(typed(p.effort))thread.effort=p.effort;if(p.config&&typed(p.config.model_reasoning_effort))thread.effort=p.config.model_reasoning_effort;keep(thread);}
 const turn={id:'turn-'+process.pid+'-'+(++sequence),status:p.fixtureActive?'inProgress':'completed'};turns.set(p.threadId,turn);result={turn};send({method:'turn/started',params:{threadId:p.threadId,turn}});if(!p.fixtureActive)send({method:'turn/completed',params:{threadId:p.threadId,turn}});}
if(m.method==='turn/interrupt'){const turn=turns.get(p.threadId);if(turn?.id!==p.turnId||turn.status!=='inProgress'){send({id:m.id,error:{code:-32600,message:'no active turn to interrupt'}});return;}turn.status='interrupted';send({method:'turn/completed',params:{threadId:p.threadId,turn}});}
if(m.method==='thread/settings/update'){const a=all();const thread=a[p.threadId];
 if(thread){if(p.model)thread.model=p.model;if(p.cwd)thread.cwd=p.cwd;if(p.approvalPolicy)thread.approvalPolicy=p.approvalPolicy;if(typed(p.effort))thread.effort=p.effort;if(p.config&&typed(p.config.model_reasoning_effort))thread.effort=p.config.model_reasoning_effort;keep(thread);}result={};}
send({id:m.id,result});}
const listen=args.includes('--listen')?args[args.indexOf('--listen')+1]:'stdio://';
if(listen.startsWith('unix://')){
const socket=listen.slice(7);const server=createServer();const ws=new WebSocketServer({server});
ws.on('connection',client=>client.on('message',bytes=>{void rpc(JSON.parse(bytes),m=>client.send(JSON.stringify(m)),()=>client.close(1000));}));
server.listen(socket,()=>{chmodSync(socket,0o600);});
process.on('SIGTERM',()=>{for(const c of ws.clients)c.terminate();server.close(()=>process.exit(0));});
}else{createInterface({input:process.stdin}).on('line',line=>{void rpc(JSON.parse(line),m=>process.stdout.write(JSON.stringify(m)+'\\n'));});}
`, { mode: 0o700 });
  const configPath = join(directory, "gateway.json");
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: join(directory, "state"), providers: [], clientOnly: true };
  configureTelemetry(config.stateDirectory, "test");
  setHostDownWindowForTests(1500); // Fail fast while the host stays down, but never sit out the five-second production window.
  // Watch the host lookups: a re-attach that finds the host must discover it exactly once, whatever the number of waiting chats.
  const discoverAll = ExecutionHostClient.discover;
  let discovers = 0; const hostClients: ExecutionHostClient[] = [];
  ExecutionHostClient.discover = async (...ask: Parameters<typeof ExecutionHostClient.discover>) => {
    discovers++; const found = await discoverAll(...ask); if (found) hostClients.push(found); return found;
  };
  // As on Studio: the service shares gateway executors, so an adapter needs the host and waits for it when it is down.
  if (shared) await writePrivateJson(join(config.stateDirectory, "service-plan.json"), { version: 1, config: configPath, sharedExecutors: true,
    components: [{ id: "native", kind: "native", command: sdk, args: ["--codex", sdk, "--native-home", nativeHome], log: join(config.stateDirectory, "native.log") }] });
  const previousHome = process.env.CODEX_HOME; process.env.CODEX_HOME = nativeHome;
  let host = shared ? await startExecutionHost({ config, configPath, nativeHome, codex: sdk }) : undefined;
  const snapshot = () => ({ revision: "1".repeat(64), models: [{ slug: alias, display_name: "Fixture" }, { slug: otherAlias, display_name: "Other" }] });
  const catalog = { current: snapshot, refresh: async () => snapshot(), combined: (value: ReturnType<typeof snapshot>) => ({ models: value.models }) } as unknown as DesktopCatalog;
  const events: Message[] = [];
  const args = ["app-server", "--listen", "stdio://", "--fixture-root", directory];
  const backends = shared ? await AppServerBackends.create(sdk, args, config, {}, {}, catalog, async message => { events.push(message); }, () => {}, configPath)
    : new AppServerBackends(sdk, args, config, {}, {}, catalog, async message => { events.push(message); }, () => {});
  await backends.request("initialize", { clientInfo: { name: "reattach", version: "1" }, capabilities: { experimentalApi: true } }); backends.notify({ method: "initialized" });
  const logged = async (): Promise<Logged[]> => (await readFile(join(directory, "log.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const engine = (threadId: string) => (backends as unknown as { bindings: Map<string, { connection: { closed: boolean }; requests: number }> }).bindings.get(threadId);
  const until = async (check: () => boolean | Promise<boolean>, name: string) => { for (let attempt = 0; attempt < 800; attempt++) { if (await check()) return; await delay(10); } throw new Error(name + " never happened"); };
  const events_ = async (name: string) => { await flushTelemetry(); return (await readTelemetry(config.stateDirectory, Date.now() - 120_000)).filter(event => event.event === name); };
  return {
    backends, events, logged, engine, until, telemetry: events_, discovers: () => discovers, directory,
    openHostConnections: () => hostClients.filter(client => !client.closed).length,
    windowClosed: () => until(() => Date.now() >= (backends as unknown as { reattacher: { hostDownUntil: number } }).reattacher.hostDownUntil, "the fail-fast window to pass"),
    holdTurnsList: () => writeFile(join(directory, "hold-turns-list"), ""),
    releaseTurnsList: () => rm(join(directory, "hold-turns-list"), { force: true }),
    holdResume: () => writeFile(join(directory, "hold-resume"), ""),
    releaseResume: () => rm(join(directory, "hold-resume"), { force: true }),
    start: (id: string, provider = "subscription_gateway") => backends.request("thread/start", { fixtureId: id, model: alias, modelProvider: provider, cwd: "/work", approvalPolicy: "never" }, { engine: "gateway" }),
    /** Stops the host, as the service does for an upgrade; its generations go with it. */
    async stopHost() { await host?.close(); host = undefined; },
    async startHost() { host = await startExecutionHost({ config, configPath, nativeHome, codex: sdk }); },
    async clean() {
      await backends.stop(); await host?.close();
      ExecutionHostClient.discover = discoverAll; setHostDownWindowForTests();
      process.env.CODEX_HOME = previousHome; if (previousHome === undefined) delete process.env.CODEX_HOME;
      await flushTelemetry();
      await Promise.allSettled([rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }), rm(executionHostHome(configPath, nativeHome), { recursive: true, force: true })]);
    },
  };
}
const turn = (threadId: string, text: string, extra: Message = {}) => ({ threadId, model: alias, input: [{ type: "text", text }], ...extra });
const lost = (error: Error & { code?: number }) => error.code === -32001 && error.message === "The gateway executor connection was lost; resume this chat to reconnect to its saved or running session.";

test("a host restarted under a loaded chat re-attaches with a resume that leaves model, effort and approvals for the SDK to restore", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.backends.request("thread/start", { fixtureId: "switched", model: alias, modelProvider: "openai", cwd: "/work", approvalPolicy: "never",
      config: { model_reasoning_effort: "low", model_catalog_json: "/catalog.json" } }, { engine: "gateway" });
    // The chat tightened its approvals and moved model and effort after it was loaded.
    await f.backends.request("turn/start", turn("switched", "before the restart", { model: otherAlias, approvalPolicy: "on-request" }));
    await f.backends.request("thread/settings/update", { threadId: "switched", effort: "high" });
    const before = (await f.logged()).find(row => row.method === "thread/start")!.pid;
    await f.stopHost(); await f.until(() => f.engine("switched")?.connection.closed === true, "the executor connection closing");
    await f.startHost();
    await f.backends.request("thread/turns/list", { threadId: "switched", includeTurns: false }); // The turn list re-attaches, as opening the chat would.
    const after = (await f.logged()).filter(row => row.pid !== before && row.threadId === "switched" && row.method !== "thread/read");
    assert.deepEqual(after.map(row => row.method), ["thread/resume", "thread/turns/list"], "one resume, then only the new request");
    const resume = after[0];
    assert.equal(resume.model, undefined, "no start-time model to revert the chat's own");
    assert.equal(resume.modelProvider, undefined, "no provider replay: the SDK restores the id the chat is saved with");
    assert.equal(resume.approvalPolicy, undefined, "no start-time approvals to loosen the chat's own");
    assert.equal(resume.serviceTier, undefined, "nothing loaded without it replays nothing");
    assert.deepEqual(resume.config, { model_catalog_json: "/catalog.json" }, "the replayed config cannot gate the SDK's effort restore");
    assert.equal(resume.cwd, undefined, "no start-time folder to revert the chat's own"); assert.equal(resume.excludeTurns, true);
    const kept = (await f.backends.request("thread/read", { threadId: "switched", includeTurns: false })).thread as Message;
    assert.deepEqual({ model: kept.model, effort: kept.effort, approvals: kept.approvalPolicy, provider: kept.modelProvider },
      { model: otherAlias, effort: "high", approvals: "on-request", provider: "openai" }, "the chat kept what it changed after loading");
    assert.equal((f.engine("switched") as unknown as { requests: number }).requests, 0, "the re-attach left no request pinning the engine");
    const reattached = await f.telemetry("executor_reattached");
    assert.deepEqual(reattached.map(event => [event.reason, event.requests]), [["engine_closed", 1]]);
    assert.deepEqual(Object.keys(reattached[0]).sort(), ["at", "component", "event", "host", "ms", "pid", "reason", "requests"]);
    await f.backends.request("turn/start", turn("switched", "later")); // The re-attached chat works without another resume.
    assert.equal((await f.logged()).filter(row => row.method === "thread/resume").length, 1);
  } finally { await f.clean(); }
});

test("a chat saved as openai and one saved as gatefox each re-attach under their own saved provider", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("mine", "openai"); await f.start("theirs");
    await f.stopHost(); await f.until(() => f.engine("mine")?.connection.closed === true, "the executor connection closing");
    await f.startHost();
    for (const id of ["mine", "theirs"]) await f.backends.request("turn/start", turn(id, "after the restart"));
    const resumes = (await f.logged()).filter(row => row.method === "thread/resume");
    assert.equal(resumes.length, 2); assert.deepEqual(resumes.map(row => row.modelProvider), [undefined, undefined], "neither resume names a provider");
    for (const [id, provider] of [["mine", "openai"], ["theirs", "gatefox"]] as const) {
      const thread = (await f.backends.request("thread/read", { threadId: id, includeTurns: false })).thread as Message;
      assert.equal(thread.modelProvider, provider, `${id} still carries its saved provider`);
    }
  } finally { await f.clean(); }
});

test("concurrent requests for a chat whose executor is gone share one resume", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("busy");
    await f.stopHost(); await f.until(() => f.engine("busy")?.connection.closed === true, "the executor connection closing");
    await f.startHost();
    const answers = await Promise.all([f.backends.request("turn/start", turn("busy", "first")), f.backends.request("thread/read", { threadId: "busy", includeTurns: false }),
      f.backends.request("turn/start", turn("busy", "second"))]);
    assert.equal(answers.length, 3);
    const resumes = (await f.logged()).filter(row => row.method === "thread/resume" && row.threadId === "busy");
    assert.equal(resumes.length, 1, "one resume for every waiting request");
    assert.deepEqual((await f.logged()).filter(row => row.method === "turn/start" && row.threadId === "busy").map(row => row.text).sort(), ["first", "second"]);
    assert.deepEqual((await f.telemetry("executor_reattached")).map(event => [event.reason, event.requests]), [["engine_closed", 3]]);
  } finally { await f.clean(); }
});

test("three chats re-attaching at once make the connection rediscover the host once and leak no control connection", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    for (const id of ["one", "two", "three"]) await f.start(id);
    await f.stopHost(); await f.until(() => f.engine("one")?.connection.closed === true, "the executor connection closing");
    await f.startHost();
    const before = f.discovers(); // The start-time discovery already settled; these re-attaches all find it closed.
    await Promise.all([f.backends.request("turn/start", turn("one", "a")), f.backends.request("turn/start", turn("two", "b")), f.backends.request("turn/start", turn("three", "c"))]);
    assert.equal(f.discovers() - before, 1, "the chats shared one host lookup");
    assert.equal((await f.logged()).filter(row => row.method === "thread/resume").length, 3, "each chat was resumed once");
    await f.backends.stop();
    assert.equal(f.openHostConnections(), 0, "stop leaves no host control connection of the re-attach open");
  } finally { await f.clean(); }
});

test("a host that stays down answers today's error, fails fast inside its window, and the chat recovers once the host is back", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("stranded");
    await f.stopHost(); await f.until(() => f.engine("stranded")?.connection.closed === true, "the executor connection closing");
    await assert.rejects(f.backends.request("turn/start", turn("stranded", "while the host is down")), (error: Error & { code?: number }) => lost(error));
    const failed = await f.telemetry("executor_reattach_failed");
    assert.deepEqual(failed.map(event => [event.reason, event.requests]), [["host_unavailable", 1]]);
    assert.equal((await f.logged()).some(row => row.text === "while the host is down"), false, "nothing was sent anywhere");
    const at = Date.now(); const before = f.discovers();
    await assert.rejects(f.backends.request("turn/start", turn("stranded", "asked again at once")), (error: Error & { code?: number }) => lost(error));
    assert.ok(Date.now() - at < 300, "the second request fails fast instead of kicking and waiting for the host");
    assert.equal(f.discovers(), before, "the failed window started no new host lookup");
    assert.equal((await f.telemetry("executor_reattach_failed")).length, 1, "the refused request added no record");
    await f.startHost(); await f.windowClosed();
    await f.backends.request("turn/start", turn("stranded", "after the host is back"));
    assert.equal((await f.logged()).filter(row => row.method === "thread/resume").length, 1);
    assert.deepEqual((await f.telemetry("executor_reattached")).map(event => [event.reason, event.requests]), [["engine_closed", 1]]);
  } finally { await f.clean(); }
});

test("a request arriving while another chat is still looking for the host reports and records it as engine_closed", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("r1"); await f.start("r2");
    await f.stopHost(); await f.until(() => f.engine("r1")?.connection.closed === true, "the executor connection closing");
    const first = f.backends.request("turn/start", turn("r1", "first while down")).then(() => true, () => false);
    await f.until(() => f.discovers() === 2, "the first re-attach's host lookup to start");
    await f.startHost();
    const second = f.backends.request("turn/start", turn("r2", "second while down")).then(() => true, () => false);
    assert.deepEqual([await first, await second], [true, true]);
    const reattached = await f.telemetry("executor_reattached");
    assert.equal(reattached.length, 2);
    assert.deepEqual(reattached.map(event => event.reason).sort(), ["engine_closed", "engine_closed"],
      "both chats lost their executor with the host: a lookup of the new one still in flight must not relabel the second chat's reason");
    assert.equal((await f.logged()).filter(row => row.method === "thread/resume").length, 2, "each chat resumed once");
  } finally { await f.clean(); }
});

test("thread/unsubscribe on a closed engine is answered locally, while delete and archive still re-attach", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("gone"); await f.start("staying");
    await f.stopHost(); await f.until(() => f.engine("gone")?.connection.closed === true, "the executor connection closing");
    const before = f.discovers();
    assert.deepEqual(await f.backends.request("thread/unsubscribe", { threadId: "gone" }), { status: "notLoaded" });
    assert.equal(f.discovers(), before, "unloading a chat nobody can reach woke no host");
    assert.equal((await f.logged()).some(row => row.method === "thread/resume"), false, "no resume was sent");
    assert.equal(f.engine("gone"), undefined, "the chat's local records are cleared");
    await f.startHost();
    await f.backends.request("thread/delete", { threadId: "staying" });
    assert.deepEqual((await f.logged()).filter(row => row.method === "thread/resume").map(row => row.threadId), ["staying"], "deleting a chat re-attaches it first, as the SDK needs it loaded");
    assert.equal((await f.telemetry("executor_reattached")).map(event => event.reason).length, 1);
    const loads = (f.backends as unknown as { loads: { resumeParams(threadId: string): Message } }).loads;
    assert.deepEqual(loads.resumeParams("staying"), { threadId: "staying", excludeTurns: true }, "a deleted chat's load parameters are forgotten");
  } finally { await f.clean(); }
});

test("a turn that was running when its executor died is not sent again; the new turn runs, and stopping the old one gets the SDK's answer", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("running");
    const running = await f.backends.request("turn/start", turn("running", "long task", { fixtureActive: true }));
    const oldTurn = String((running.turn as Message).id);
    await f.stopHost(); await f.until(() => f.engine("running")?.connection.closed === true, "the executor connection closing");
    await f.startHost();
    await f.backends.request("turn/start", turn("running", "next task"));
    const turns = (await f.logged()).filter(row => row.method === "turn/start" && row.threadId === "running").map(row => row.text);
    assert.deepEqual(turns, ["long task", "next task"], "the running turn was not replayed");
    await assert.rejects(f.backends.request("turn/interrupt", { threadId: "running", turnId: oldTurn }), /no active turn to interrupt/);
  } finally { await f.clean(); }
});

test("a private executor that exited is replaced and the chat resumed with its saved settings; a throwaway chat still has to be started again", { timeout: 30000 }, async () => {
  const f = await fixture({ shared: false });
  try {
    await f.start("private");
    await f.backends.request("thread/start", { fixtureId: "throwaway", model: alias, ephemeral: true }, { engine: "gateway" });
    await f.backends.request("fixture/exit", { threadId: "private" });
    await f.until(() => f.engine("private")?.connection.closed === true, "the executor exiting");
    await f.backends.request("turn/start", turn("private", "after the exit"));
    const rows = (await f.logged()).filter(row => row.threadId === "private" && row.method !== "thread/read");
    assert.deepEqual(rows.map(row => row.method), ["fixture/exit", "thread/resume", "turn/start"]);
    assert.equal(rows[1].approvalPolicy, undefined, "the resume leaves the chat's approvals to its saved settings");
    assert.equal(rows[1].model, undefined, "and the same for the model and provider it once replayed");
    assert.equal(rows[1].excludeTurns, true, "the resume never drags the turn history along");
    assert.notEqual(rows[1].pid, rows[0].pid, "a new executor serves the chat"); assert.equal(rows[2].pid, rows[1].pid);
    assert.equal((f.engine("private") as unknown as { requests: number }).requests, 0, "the re-attach left no request pinning the engine");
    assert.deepEqual((await f.telemetry("executor_reattached")).map(event => event.reason), ["engine_closed"]);
    // The replacement goes the same way: the next unsubscribe is answered here, not by starting yet another executor.
    await f.backends.request("fixture/exit", { threadId: "private" });
    await f.until(() => f.engine("private")?.connection.closed === true, "the replacement exiting");
    assert.deepEqual(await f.backends.request("thread/unsubscribe", { threadId: "private" }), { status: "notLoaded" });
    assert.equal((await f.logged()).filter(row => row.method === "thread/resume").length, 1, "unloading a gone chat woke nobody");
    assert.equal(f.engine("private"), undefined, "its records are cleared");
    await assert.rejects(f.backends.request("turn/start", turn("throwaway", "lost")), (error: Error & { code?: number }) =>
      error.code === -32001 && /Ephemeral chats must be started again/.test(error.message));
  } finally { await f.clean(); }
});

test("a private executor that refuses the resume answers today's error, records resume_failed, and the next request tries again", { timeout: 30000 }, async () => {
  const f = await fixture({ shared: false });
  try {
    await f.start("refused");
    await writeFile(join(f.directory, "refuse-resume"), "");
    await f.backends.request("fixture/exit", { threadId: "refused" });
    await f.until(() => f.engine("refused")?.connection.closed === true, "the executor exiting");
    await assert.rejects(f.backends.request("turn/start", turn("refused", "blocked")), (error: Error & { code?: number }) =>
      error.code === -32001 && /gateway executor exited/.test(error.message));
    assert.deepEqual((await f.telemetry("executor_reattach_failed")).map(event => [event.reason, event.requests]), [["resume_failed", 1]]);
    assert.equal((await f.logged()).some(row => row.text === "blocked"), false, "the refused request reached no executor");
    await rm(join(f.directory, "refuse-resume"));
    await f.backends.request("turn/start", turn("refused", "now it takes it")); // resume_failed opens no fail-fast window: it tries again at once
    assert.equal((await f.logged()).filter(row => row.text === "now it takes it").length, 1);
    assert.equal((await f.telemetry("executor_reattached")).map(event => event.reason).length, 1);
  } finally { await f.clean(); }
});

test("a private chat's request during shutdown answers the old error, records nothing, and does not hang", { timeout: 30000 }, async () => {
  const f = await fixture({ shared: false });
  try {
    await f.start("closing");
    await f.backends.request("fixture/exit", { threadId: "closing" });
    await f.until(() => f.engine("closing")?.connection.closed === true, "the executor exiting");
    const stopping = f.backends.stop(); // stop sets closing before its first await, so the request below finds shutdown begun.
    await assert.rejects(f.backends.request("turn/start", turn("closing", "during the stop")), (error: Error & { code?: number }) =>
      error.code === -32001 && /gateway executor exited/.test(error.message));
    await stopping;
    assert.equal((await f.telemetry("executor_reattach_failed")).length, 0, "the adapter gave up instead of starting a re-attach");
    assert.equal((await f.logged()).some(row => row.method === "thread/resume"), false);
  } finally { await f.clean(); }
});

test("an executor the host restarts refuses the resume, and the chat recovers when it no longer does", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("refused");
    await writeFile(join(f.directory, "refuse-resume"), "");
    await f.stopHost(); await f.until(() => f.engine("refused")?.connection.closed === true, "the executor connection closing");
    await f.startHost();
    await assert.rejects(f.backends.request("turn/start", turn("refused", "blocked")), (error: Error & { code?: number }) => lost(error));
    assert.deepEqual((await f.telemetry("executor_reattach_failed")).map(event => [event.reason, event.requests]), [["resume_failed", 1]]);
    await rm(join(f.directory, "refuse-resume"));
    await f.backends.request("turn/start", turn("refused", "now it takes it"));
    assert.equal((await f.logged()).filter(row => row.method === "thread/resume").length, 2, "each request found the host; only the resume was refused");
  } finally { await f.clean(); }
});

test("a forked chat re-attaches keeping its own folder, not its parent's", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("parent");
    await f.backends.request("thread/fork", { threadId: "parent", fixtureId: "kid", model: alias, cwd: "/fork" });
    await f.stopHost(); await f.until(() => f.engine("kid")?.connection.closed === true, "the executor connection closing");
    await f.startHost();
    await f.backends.request("turn/start", turn("kid", "hello"));
    const resume = (await f.logged()).find(row => row.method === "thread/resume" && row.threadId === "kid")!;
    assert.equal(resume.cwd, undefined, "the fork's folder is left to the SDK too");
    assert.equal(((await f.backends.request("thread/read", { threadId: "kid", includeTurns: false })).thread as Message).cwd, "/fork", "the fork kept its own folder, not its parent's");
    await f.stopHost(); await f.until(() => f.engine("kid")?.connection.closed === true, "the executor connection closing again");
    await f.startHost();
    await f.backends.request("turn/start", turn("parent", "back"));
    assert.equal(((await f.backends.request("thread/read", { threadId: "parent", includeTurns: false })).thread as Message).cwd, "/work");
  } finally { await f.clean(); }
});

test("thread/closed clears the chat's records, so a later re-attach resumes it from its saved settings alone", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.backends.request("thread/start", { fixtureId: "doomed", model: alias, serviceTier: "priority", cwd: "/work" }, { engine: "gateway" });
    const loads = (f.backends as unknown as { loads: { resumeParams(threadId: string): Message } }).loads;
    assert.equal(loads.resumeParams("doomed").serviceTier, "priority", "the connection remembers how it loaded the chat");
    await f.backends.request("fixture/close", { threadId: "doomed" });
    await f.until(() => f.engine("doomed") === undefined, "the thread/closed notice to clear the chat");
    assert.deepEqual(loads.resumeParams("doomed"), { threadId: "doomed", excludeTurns: true }, "after the unload the connection replays nothing it once remembered");
  } finally { await f.clean(); }
});

test("a request on a closed engine during shutdown answers the old error, records nothing, and does not hang", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("closing");
    await f.stopHost(); await f.until(() => f.engine("closing")?.connection.closed === true, "the executor connection closing");
    const stopping = f.backends.stop(); // stop sets closing before its first await, so the request below finds shutdown begun.
    await assert.rejects(f.backends.request("turn/start", turn("closing", "during the stop")), (error: Error & { code?: number }) => lost(error));
    await stopping;
    assert.equal((await f.telemetry("executor_reattach_failed")).length, 0, "the adapter gave up instead of starting a re-attach");
    assert.equal((await f.logged()).some(row => row.method === "thread/resume"), false);
  } finally { await f.clean(); }
});

test("stopping the adapter while a re-attach waits for the host ends it with the old error, without a hang or a leaked connection", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("waiting");
    await f.stopHost(); await f.until(() => f.engine("waiting")?.connection.closed === true, "the executor connection closing");
    const before = f.discovers();
    const request = f.backends.request("turn/start", turn("waiting", "while the host is down")).then(() => undefined, (error: Error & { code?: number }) => error);
    await f.until(() => f.discovers() > before, "the re-attach's host lookup to start");
    const stopped = Date.now();
    await f.backends.stop();
    const error = await request;
    assert.ok(error && lost(error), "the request got the old error");
    assert.ok(Date.now() - stopped < 10_000, "stopping did not wait out the host wait");
    assert.equal((await f.logged()).some(row => row.method === "thread/resume" || row.text === "while the host is down"), false, "nothing was resumed or sent");
    assert.equal(f.openHostConnections(), 0, "no control connection stays open");
  } finally { await f.clean(); }
});

test("a connection the live host dropped is re-attached to the generation that still owns the chat, never to a second writer", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("kept");
    const owner = (await f.logged()).find(row => row.method === "thread/start")!.pid;
    // The generation drops this adapter's connection while the host stays up.
    await f.backends.request("fixture/disconnect", { threadId: "kept" }).catch(() => undefined);
    await f.until(() => f.engine("kept")?.connection.closed === true, "the executor connection closing");
    await f.backends.request("turn/start", turn("kept", "after the drop"));
    const rows = (await f.logged()).filter(row => row.threadId === "kept" && ["thread/resume", "turn/start"].includes(row.method));
    assert.deepEqual(rows.map(row => [row.method, row.pid === owner]), [["thread/resume", true], ["turn/start", true]], "the owning generation serves the chat again");
    assert.deepEqual((await f.telemetry("executor_reattached")).map(event => event.reason), ["generation_retired"]);
  } finally { await f.clean(); }
});

test("a terminal race and a second active chat both recover after one shared socket drops", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("active");
    const started = await f.backends.request("turn/start", turn("active", "keep running", { fixtureActive: true }));
    const turnId = String(object(started.turn).id);
    await f.start("peer");
    const peer = await f.backends.request("turn/start", turn("peer", "also running", { fixtureActive: true }));
    const peerTurnId = String(object(peer.turn).id);
    await f.holdTurnsList();
    await f.backends.request("fixture/disconnect", { threadId: "active" }).catch(() => undefined);
    await f.until(async () => (await f.logged()).some(row => row.method === "thread/turns/list" && row.threadId === "active"), "the recovery snapshot starting");
    await f.backends.request("turn/interrupt", { threadId: "active", turnId });
    await f.releaseTurnsList();
    await f.until(() => f.events.filter(event => event.method === "turn/completed" && object(event.params).threadId === "active").length === 1, "the live terminal reaching the desktop");
    await f.until(() => (f.engine("peer") as unknown as { active: Map<string, string> }).active.get("peer") === peerTurnId, "the second active chat reconnecting");
    await delay(50);
    assert.equal(f.events.some(event => event.method === "error" && ["active", "peer"].includes(String(object(event.params).threadId))), false, "a live owner did not report either recovered turn as lost");
    assert.equal(f.events.filter(event => event.method === "turn/completed" && object(event.params).threadId === "active").length, 1, "the saved snapshot did not duplicate the terminal");
    assert.equal((f.engine("active") as unknown as { active: Map<string, string> }).active.has("active"), false, "the completed turn was not resurrected as active");
    const rows = (await f.logged()).filter(row => ["active", "peer"].includes(String(row.threadId)) && ["thread/resume", "turn/start"].includes(row.method));
    assert.deepEqual(rows.map(row => [row.threadId, row.method]), [["active", "turn/start"], ["peer", "turn/start"], ["active", "thread/resume"], ["peer", "thread/resume"]], "recovery only resumed each saved chat once");
  } finally { await f.clean(); }
});

test("an unsubscribe during proactive recovery suppresses its stale lost-turn error", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("leaving");
    const started = await f.backends.request("turn/start", turn("leaving", "keep running", { fixtureActive: true }));
    await f.holdTurnsList();
    await f.backends.request("fixture/disconnect", { threadId: "leaving" }).catch(() => undefined);
    await f.until(async () => (await f.logged()).some(row => row.method === "thread/turns/list" && row.threadId === "leaving"), "the recovery snapshot starting");
    assert.deepEqual(await f.backends.request("thread/unsubscribe", { threadId: "leaving" }), { status: "unsubscribed" });
    await f.releaseTurnsList();
    await delay(50);
    assert.equal(f.engine("leaving"), undefined, "the explicit unsubscribe retained no executor binding");
    assert.equal(f.events.some(event => event.method === "error" && object(event.params).threadId === "leaving"), false, "a stale recovery did not report a lost turn after unsubscribe");
    assert.equal(f.events.some(event => event.method === "turn/completed" && object(event.params).threadId === "leaving"), false, "a stale recovery did not publish a terminal after unsubscribe");
    assert.ok(started.turn, "the fixture started the active turn before the disconnect");
  } finally { await f.releaseTurnsList(); await f.clean(); }
});

test("a second socket loss for the same recovered turn falls back without another automatic resume", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("again");
    const started = await f.backends.request("turn/start", turn("again", "keep running", { fixtureActive: true }));
    const turnId = String(object(started.turn).id);
    await f.backends.request("fixture/disconnect", { threadId: "again" }).catch(() => undefined);
    await f.until(() => (f.engine("again") as unknown as { active: Map<string, string> }).active.get("again") === turnId, "the first recovery completing");
    await f.until(async () => (await f.logged()).some(row => row.method === "thread/resume" && row.threadId === "again"), "the first resume recording");
    const resumes = (await f.logged()).filter(row => row.method === "thread/resume" && row.threadId === "again").length;
    await f.backends.request("fixture/disconnect", { threadId: "again" }).catch(() => undefined);
    await f.until(() => f.events.some(event => event.method === "error" && object(event.params).threadId === "again"), "the repeat-loss fallback");
    assert.equal((await f.logged()).filter(row => row.method === "thread/resume" && row.threadId === "again").length, resumes, "the second loss did not start another automatic resume");
    assert.equal(f.events.some(event => event.method === "turn/completed" && object(event.params).threadId === "again"), false, "the fallback did not invent a terminal turn");
  } finally { await f.clean(); }
});

test("proactive recovery joins a foreground resume flight and restores the active turn", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("joined");
    const started = await f.backends.request("turn/start", turn("joined", "keep running", { fixtureActive: true }));
    const turnId = String(object(started.turn).id);
    const state = f.backends as unknown as { recoverActiveTurn: (...args: unknown[]) => Promise<unknown> };
    const original = state.recoverActiveTurn.bind(state); let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    state.recoverActiveTurn = async (...args) => { enter(); await gate; return original(...args); };
    await f.holdResume();
    await f.backends.request("fixture/disconnect", { threadId: "joined" }).catch(() => undefined);
    await entered;
    const foreground = f.backends.request("thread/read", { threadId: "joined", includeTurns: false });
    await f.until(async () => (await f.logged()).some(row => row.method === "thread/resume" && row.threadId === "joined"), "the foreground resume starting");
    release(); await f.releaseResume(); await foreground;
    await f.until(() => (f.engine("joined") as unknown as { active: Map<string, string> }).active.get("joined") === turnId, "the joined proactive recovery restoring the turn");
    assert.equal(f.events.some(event => event.method === "error" && object(event.params).threadId === "joined"), false, "a joined foreground resume did not produce a lost-turn error");
    assert.equal((await f.logged()).filter(row => row.method === "thread/resume" && row.threadId === "joined").length, 1, "both paths shared one SDK resume");
  } finally { await f.releaseResume(); await f.clean(); }
});

test("a proactive resume with no authoritative turn still reports the saved chat as disconnected", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("missing");
    await f.backends.request("turn/start", turn("missing", "keep running", { fixtureActive: true }));
    await f.holdTurnsList();
    await f.backends.request("fixture/disconnect", { threadId: "missing" }).catch(() => undefined);
    await f.until(async () => (await f.logged()).some(row => row.method === "thread/turns/list" && row.threadId === "missing"), "the recovery snapshot starting");
    await f.backends.request("fixture/forget-turn", { threadId: "missing" });
    await f.releaseTurnsList();
    await f.until(() => f.events.some(event => event.method === "error" && object(event.params).threadId === "missing"), "the explicit lost-turn error");
    assert.equal(f.events.some(event => event.method === "turn/completed" && object(event.params).threadId === "missing"), false, "missing evidence never invents a terminal turn");
  } finally { await f.releaseTurnsList(); await f.clean(); }
});

test("a rejected proactive snapshot still reports the saved chat as disconnected", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("rejected");
    await f.backends.request("turn/start", turn("rejected", "keep running", { fixtureActive: true }));
    await f.holdTurnsList();
    await f.backends.request("fixture/disconnect", { threadId: "rejected" }).catch(() => undefined);
    await f.until(async () => (await f.logged()).some(row => row.method === "thread/turns/list" && row.threadId === "rejected"), "the recovery snapshot starting");
    await f.backends.request("fixture/reject-turns-list", { threadId: "rejected" });
    await f.releaseTurnsList();
    await f.until(() => f.events.some(event => event.method === "error" && object(event.params).threadId === "rejected"), "the explicit lost-turn error");
    assert.equal(f.events.some(event => event.method === "turn/completed" && object(event.params).threadId === "rejected"), false, "a rejected snapshot never invents a terminal turn");
  } finally { await f.releaseTurnsList(); await f.clean(); }
});

test("a chat whose folder changed after loading re-attaches without a folder or roots, and stays where it moved", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.backends.request("thread/start", { fixtureId: "moved", model: alias, cwd: "/dir-a", runtimeWorkspaceRoots: ["/dir-a"], approvalPolicy: "never" }, { engine: "gateway" });
    await f.backends.request("thread/settings/update", { threadId: "moved", cwd: "/dir-b" });
    const before = (await f.logged()).find(row => row.method === "thread/start")!.pid;
    await f.stopHost(); await f.until(() => f.engine("moved")?.connection.closed === true, "the executor connection closing");
    await f.startHost();
    await f.backends.request("thread/turns/list", { threadId: "moved", includeTurns: false });
    const resume = (await f.logged()).find(row => row.method === "thread/resume" && row.threadId === "moved" && row.pid !== before)!;
    assert.equal(resume.cwd, undefined, "an explicit folder would win over the one the chat moved to");
    assert.equal(resume.runtimeWorkspaceRoots, undefined, "explicit roots would skip the SDK's restore of the chat's own");
    assert.equal(((await f.backends.request("thread/read", { threadId: "moved", includeTurns: false })).thread as Message).cwd, "/dir-b", "the chat stays in the folder it moved to");
  } finally { await f.clean(); }
});

test("an unsubscribe that arrives during a re-attach unloads the chat on the executor it landed on, and leaves no binding", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("leaving");
    const before = (await f.logged()).find(row => row.method === "thread/start")!.pid;
    await f.stopHost(); await f.until(() => f.engine("leaving")?.connection.closed === true, "the executor connection closing");
    await f.startHost();
    const reattacher = (f.backends as unknown as { reattacher: { running(threadId: string): unknown } }).reattacher;
    const turnRequest = f.backends.request("turn/start", turn("leaving", "starts the re-attach")).then(() => undefined, () => undefined);
    assert.ok(reattacher.running("leaving"), "the re-attach is running when the unsubscribe arrives");
    const answer = await f.backends.request("thread/unsubscribe", { threadId: "leaving" });
    await turnRequest;
    assert.deepEqual(answer, { status: "unsubscribed" }, "the executor the chat landed on answered, not a local notLoaded");
    const rows = (await f.logged()).filter(row => row.threadId === "leaving" && row.pid !== before);
    const resume = rows.find(row => row.method === "thread/resume")!; const unsubscribe = rows.find(row => row.method === "thread/unsubscribe")!;
    assert.ok(resume && unsubscribe, "the chat was resumed, then unsubscribed");
    assert.equal(unsubscribe.pid, resume.pid, "the unsubscribe reached the new executor");
    assert.equal(f.engine("leaving"), undefined, "no binding is left behind");
  } finally { await f.clean(); }
});

test("a host that came back inside the fail-fast window ends it: another chat re-attaches without waiting it out", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("first"); await f.start("second");
    await f.stopHost(); await f.until(() => f.engine("first")?.connection.closed === true, "the executor connection closing");
    await assert.rejects(f.backends.request("turn/start", turn("first", "while the host is down")), (error: Error & { code?: number }) => lost(error));
    const window = (f.backends as unknown as { reattacher: { hostDownUntil: number } }).reattacher;
    assert.ok(Date.now() < window.hostDownUntil, "the failed lookup opened the fail-fast window");
    await f.startHost();
    await f.backends.request("thread/resume", { threadId: "first" }); // The user resumes the chat; the host answers.
    assert.equal(window.hostDownUntil, 0, "a live host lookup clears the window");
    await f.backends.request("turn/start", turn("second", "the host is back"));
    assert.equal((await f.logged()).filter(row => row.method === "thread/resume" && row.threadId === "second").length, 1, "the other chat re-attached at once");
    assert.equal((await f.telemetry("executor_reattach_failed")).length, 1, "only the first failed lookup was recorded");
  } finally { await f.clean(); }
});
