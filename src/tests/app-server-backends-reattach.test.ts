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
import type { Message } from "../app-server-connection.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // The SDK rendezvous, host homes and native-home receipts stay in this file's own folder.
hostRunsInThisProcess(); // The shared host runs inside the test process: see src/tests/in-process-host.ts.

const alias = "claude/fixture"; const otherAlias = "claude/other";
type Logged = { pid: number; method: string; threadId?: string; turnId?: string; modelProvider?: string; model?: string; cwd?: string; approvalPolicy?: string; text?: string };

/**
 * A fake SDK that plays the native engine (stdio) and the host's gateway generations (a Unix socket). Saved chats live in
 * `<root>/threads.json`, shared by every process as rollouts are; every request a process answers is appended to
 * `<root>/log.jsonl` with the process id, so a test sees which executor got which request. `fixtureActive` on turn/start
 * leaves the turn running; `fixture/exit` ends a stdio executor as a crash would.
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
const log=(m)=>{const p=m.params||{};appendFileSync(root+'/log.jsonl',JSON.stringify({pid:process.pid,method:m.method,threadId:p.threadId,turnId:p.turnId,modelProvider:p.modelProvider,model:p.model,cwd:p.cwd,approvalPolicy:p.approvalPolicy,text:p.input?.[0]?.text})+'\\n');};
async function rpc(m,send,drop){if(m.id==null)return;log(m);const p=m.params||{};let result={};
if(m.method==='fixture/disconnect'){drop?.();return;}
if(m.method==='config/read')result={config:{agents:{max_concurrent_threads_per_session:30}}};
if(m.method==='thread/loaded/list')result={data:[...loaded],nextCursor:null};
if(m.method==='thread/unsubscribe')loaded.delete(p.threadId);
if(m.method==='fixture/exit'){send({id:m.id,result:{}});setTimeout(()=>process.exit(3),20);return;}
if(m.method==='thread/start'){const thread={id:p.fixtureId,modelProvider:p.modelProvider||'subscription_gateway',model:p.model};const value=all();value[thread.id]=thread;writeFileSync(saved,JSON.stringify(value));loaded.add(thread.id);result={thread,model:p.model,modelProvider:thread.modelProvider,serviceTier:null};}
if(m.method==='thread/resume'){const thread=all()[p.threadId];if(!thread){send({id:m.id,error:{code:-32600,message:'no rollout found for thread id '+p.threadId}});return;}loaded.add(thread.id);result={thread,model:p.model||thread.model,modelProvider:p.modelProvider||thread.modelProvider,serviceTier:null};}
if(m.method==='thread/read'){const thread=all()[p.threadId];result={thread:thread?{...thread,turns:[]}:{id:p.threadId,modelProvider:'openai'}};}
if(m.method==='turn/start'){const turn={id:'turn-'+process.pid+'-'+(++sequence),status:p.fixtureActive?'inProgress':'completed'};turns.set(p.threadId,turn);result={turn};send({method:'turn/started',params:{threadId:p.threadId,turn}});if(!p.fixtureActive)send({method:'turn/completed',params:{threadId:p.threadId,turn}});}
if(m.method==='turn/interrupt'){const turn=turns.get(p.threadId);if(turn?.id!==p.turnId||turn.status!=='inProgress'){send({id:m.id,error:{code:-32600,message:'no active turn to interrupt'}});return;}turn.status='interrupted';send({method:'turn/completed',params:{threadId:p.threadId,turn}});}
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
  const engine = (threadId: string) => (backends as unknown as { bindings: Map<string, { connection: { closed: boolean } }> }).bindings.get(threadId);
  const until = async (check: () => boolean | Promise<boolean>, name: string) => { for (let attempt = 0; attempt < 400; attempt++) { if (await check()) return; await delay(10); } throw new Error(name + " never happened"); };
  const events_ = async (name: string) => { await flushTelemetry(); return (await readTelemetry(config.stateDirectory, Date.now() - 60_000)).filter(event => event.event === name); };
  return {
    backends, events, logged, engine, until, telemetry: events_,
    start: (id: string, provider = "subscription_gateway") => backends.request("thread/start", { fixtureId: id, model: alias, modelProvider: provider, cwd: "/work", approvalPolicy: "never" }, { engine: "gateway" }),
    /** Stops the host, as the service does for an upgrade; its generations go with it. */
    async stopHost() { await host?.close(); host = undefined; },
    async startHost() { host = await startExecutionHost({ config, configPath, nativeHome, codex: sdk }); },
    async clean() {
      await backends.stop(); await host?.close();
      process.env.CODEX_HOME = previousHome; if (previousHome === undefined) delete process.env.CODEX_HOME;
      await flushTelemetry();
      await Promise.allSettled([rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }), rm(executionHostHome(configPath, nativeHome), { recursive: true, force: true })]);
    },
  };
}
const turn = (threadId: string, text: string, extra: Message = {}) => ({ threadId, model: alias, input: [{ type: "text", text }], ...extra });

test("a host restarted under a loaded chat: the next turn is sent after one automatic resume that keeps the chat's saved provider", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("loaded", "openai");
    // The chat switched models after it was loaded: the re-attach loads it with the model it now uses.
    await f.backends.request("turn/start", turn("loaded", "before the restart", { model: otherAlias }));
    const before = (await f.logged()).find(row => row.method === "thread/start")!.pid;
    await f.stopHost(); await f.until(() => f.engine("loaded")?.connection.closed === true, "the executor connection closing");
    await f.startHost();
    const answer = await f.backends.request("turn/start", turn("loaded", "after the restart"));
    assert.equal(typeof (answer.turn as Message).id, "string");
    // Metadata reads (the compaction check reads the chat's model) are not chat requests.
    const after = (await f.logged()).filter(row => row.pid !== before && row.threadId === "loaded" && row.method !== "thread/read");
    assert.deepEqual(after.map(row => row.method), ["thread/resume", "turn/start"], "one resume, then only the new request");
    assert.deepEqual({ provider: after[0].modelProvider, model: after[0].model, cwd: after[0].cwd, approvalPolicy: after[0].approvalPolicy },
      { provider: "openai", model: otherAlias, cwd: "/work", approvalPolicy: "never" }, "the chat is loaded as it was, under its saved provider");
    assert.equal(after[1].text, "after the restart");
    const reattached = await f.telemetry("executor_reattached");
    assert.deepEqual(reattached.map(event => [event.reason, event.requests]), [["engine_closed", 1]]);
    assert.equal(typeof reattached[0].ms, "number");
    assert.deepEqual(Object.keys(reattached[0]).sort(), ["at", "component", "event", "host", "ms", "pid", "reason", "requests"]);
    // The re-attached chat now works without another resume.
    await f.backends.request("turn/start", turn("loaded", "later"));
    assert.equal((await f.logged()).filter(row => row.method === "thread/resume").length, 1);
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

test("a host that stays down answers today's error, and the chat recovers once the host is back", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.start("stranded");
    await f.stopHost(); await f.until(() => f.engine("stranded")?.connection.closed === true, "the executor connection closing");
    await assert.rejects(f.backends.request("turn/start", turn("stranded", "while the host is down")), (error: Error & { code?: number }) =>
      error.code === -32001 && error.message === "The gateway executor connection was lost; resume this chat to reconnect to its saved or running session.");
    assert.deepEqual((await f.telemetry("executor_reattach_failed")).map(event => [event.reason, event.requests]), [["host_unavailable", 1]]);
    assert.equal((await f.logged()).some(row => row.text === "while the host is down"), false, "nothing was sent anywhere");
    await f.startHost();
    await f.backends.request("turn/start", turn("stranded", "after the host is back"));
    assert.equal((await f.logged()).filter(row => row.method === "thread/resume").length, 1);
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

test("a private executor that exited is replaced and the chat resumed; a throwaway chat still has to be started again", { timeout: 30000 }, async () => {
  const f = await fixture({ shared: false });
  try {
    await f.start("private");
    await f.backends.request("thread/start", { fixtureId: "throwaway", model: alias, ephemeral: true }, { engine: "gateway" });
    await f.backends.request("fixture/exit", { threadId: "private" });
    await f.until(() => f.engine("private")?.connection.closed === true, "the executor exiting");
    await f.backends.request("turn/start", turn("private", "after the exit"));
    const rows = (await f.logged()).filter(row => row.threadId === "private" && row.method !== "thread/read");
    assert.deepEqual(rows.map(row => row.method), ["fixture/exit", "thread/resume", "turn/start"]);
    assert.notEqual(rows[1].pid, rows[0].pid, "a new executor serves the chat"); assert.equal(rows[2].pid, rows[1].pid);
    assert.deepEqual((await f.telemetry("executor_reattached")).map(event => event.reason), ["engine_closed"]);
    await assert.rejects(f.backends.request("turn/start", turn("throwaway", "lost")), (error: Error & { code?: number }) =>
      error.code === -32001 && /Ephemeral chats must be started again/.test(error.message));
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
