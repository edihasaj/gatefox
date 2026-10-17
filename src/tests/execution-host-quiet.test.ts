import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { startExecutionHost, executionHostHome, type ExecutionDescriptor, type ExecutionRecord } from "../execution-host.js";
import { sdkIdentity } from "../execution-host-storage.js";
import type { NativeExecutionRecord } from "../native-execution-host-engine.js";
import { nativeHomeOwnerPath } from "../native-execution-host-storage.js";
import { SocketAppServerConnection } from "../socket-app-server-connection.js";
import type { GatewayConfig } from "../config.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.

/**
 * A stand-in SDK that answers what the quiet check asks, in the pinned SDK's v2 shapes: `thread/read` with the live status
 * (`active` while a turn runs or waits for an approval), `thread/turns/list` with the newest turn and its `completedAt` in
 * seconds. `fixture/turn` sets a chat's newest turn, `fixture/status` forces a status, `fixture/updated` its `updatedAt` and
 * `ephemeral`, `fixture/turnReads` counts the newest-turn reads, and `fixture/exit` ends the engine.
 */
export const quietSdkSource = (ws: string) => `#!${process.execPath}
import {createServer} from 'node:http';
import {WebSocketServer} from ${JSON.stringify(ws)};
if(process.argv.includes('--version')){console.log('codex-cli 0.162.0-alpha.17.2');process.exit(0);}
const args=process.argv.slice(2);const socket=args[args.indexOf('--listen')+1].slice(7);
const server=createServer();const wss=new WebSocketServer({server});const loaded=new Map();let turnReads=0;
const now=()=>Date.now()/1000;
wss.on('connection',client=>client.on('message',bytes=>{const m=JSON.parse(bytes);if(m.id==null)return;let result={};const id=m.params&&m.params.threadId;
if(m.method==='thread/loaded/list')result={data:[...loaded.keys()],nextCursor:null};
if(m.method==='thread/start'||m.method==='thread/resume'){const chat=loaded.get(id)||{id,updatedAt:now(),turn:null,status:null};loaded.set(id,chat);result={thread:{id}};}
if(m.method==='thread/unsubscribe')loaded.delete(id);
if(m.method==='thread/read'){const chat=loaded.get(id);result={thread:chat?{id,updatedAt:chat.updatedAt,ephemeral:!!chat.ephemeral,status:chat.status||(chat.turn&&chat.turn.status==='inProgress'?{type:'active',activeFlags:[]}:{type:'idle'})}:null};}
if(m.method==='thread/turns/list'){turnReads++;const chat=loaded.get(id);result={data:chat&&chat.turn?[chat.turn]:[],nextCursor:null,backwardsCursor:null};}
if(m.method==='fixture/turn'){const chat=loaded.get(id);chat.turn={id:'turn-'+Math.random(),rootTurnId:null,items:[],itemsView:'notLoaded',status:m.params.status,error:null,startedAt:m.params.startedAt??now(),completedAt:m.params.completedAt??null,durationMs:null};}
if(m.method==='fixture/status'){loaded.get(id).status=m.params.status;}
if(m.method==='fixture/updated'){Object.assign(loaded.get(id),{updatedAt:m.params.updatedAt,ephemeral:m.params.ephemeral});}
if(m.method==='fixture/turnReads')result={turnReads};
if(m.method==='fixture/exit'){process.exit(0);}
client.send(JSON.stringify({id:m.id,result}));}));
server.listen(socket);
process.on('SIGTERM',()=>{for(const c of wss.clients)c.terminate();server.close(()=>process.exit(0));});
`;

async function fixture(capabilities?: Array<"gateway" | "native">) {
  const directory = await mkdtemp(join(tmpdir(), "gw-quiet-")); const configPath = join(directory, "gateway.json");
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  await writeFile(join(nativeHome, "config.toml"), 'model = "native-original"\n', { mode: 0o600 });
  const codex = join(directory, "codex");
  await writeFile(codex, quietSdkSource(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href), { mode: 0o700 });
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: join(directory, "state"), providers: [], clientOnly: true };
  const hostHome = executionHostHome(configPath, nativeHome);
  const descriptor: ExecutionDescriptor = { revision: "a".repeat(64), args: ["app-server", "--listen", "stdio://"], settings: { model: "fixture" }, catalog: { models: [{ slug: "fixture" }] }, aliases: ["fixture"] };
  const nativeSdkVerifier = async (path: string) => { const identity = await sdkIdentity(path); return { nativeSdkExecutable: identity.codex, nativeSdkSha256: identity.sdkSha256 }; };
  const host = await startExecutionHost({ config, configPath, nativeHome, codex, ...(capabilities ? { capabilities, nativeSdkVerifier } : {}) });
  const socket = new WebSocket(`ws+unix://${join(hostHome, "host.sock")}:/`); await once(socket, "open"); let sequence = 0;
  const control = <T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture timed out")), 10000);
      const listener = (bytes: WebSocket.RawData) => { const message = JSON.parse(bytes.toString()); if (message.id !== id) return; clearTimeout(timer); socket.off("message", listener); message.error ? reject(new Error(message.error.message)) : resolve(message.result); };
      socket.on("message", listener); socket.send(JSON.stringify({ id, method, params }));
    });
  };
  const engines: SocketAppServerConnection[] = [];
  /** A client of one engine, as an adapter would hold it; it starts (loads) the chat it is given. */
  const chat = async (socketPath: string, threadId: string) => {
    const engine = new SocketAppServerConnection(socketPath, async () => {}); engines.push(engine); await engine.ready;
    await engine.request("initialize", {}); engine.send({ method: "initialized", params: {} });
    await engine.request("thread/start", { threadId });
    return { turn: (params: object) => engine.request("fixture/turn", { threadId, ...params }), status: (status: object) => engine.request("fixture/status", { threadId, status }),
      updated: (updatedAt: number, ephemeral = false) => engine.request("fixture/updated", { threadId, updatedAt, ephemeral }),
      turnReads: async () => (await engine.request("fixture/turnReads", {})).turnReads as number, engine };
  };
  const clean = async () => {
    for (const engine of engines) engine.stop();
    socket.terminate(); await host.close();
    await rm(dirname(nativeHomeOwnerPath(nativeHome)), { recursive: true, force: true }); await rm(hostHome, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true });
  };
  return { host, control, chat, descriptor, nativeHome, clean };
}
const seconds = (msAgo = 0) => (Date.now() - msAgo) / 1000;

test("a quiet stop ignores leases and loaded chats, but waits for a running turn and for the quiet time after it", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const record = await f.control<ExecutionRecord>("execution/acquire", f.descriptor); // This control connection now holds a lease.
    const chat = await f.chat(record.socketPath, "quiet-chat");
    assert.equal(await f.host.prepareStop(), false, "the strict idle check refuses a lease and a loaded chat");
    await chat.turn({ status: "inProgress" });
    assert.equal(await f.host.prepareQuietStop!(400), undefined, "a running turn refuses");
    await chat.turn({ status: "completed", completedAt: seconds() });
    assert.equal(await f.host.prepareQuietStop!(400), undefined, "a turn that ended within the quiet time refuses");
    await delay(450);
    assert.deepEqual(await f.host.prepareQuietStop!(400), { loadedChats: 1 }, "quiet: the lease and the loaded chat did not block it");
    // The gate is closed exactly as for an idle stop: no acquire or find slips in before the close.
    await assert.rejects(f.control("execution/find", { threadId: "quiet-chat" }), /quiescing/);
    await assert.rejects(f.control("execution/acquire", f.descriptor), /quiescing/);
    assert.equal(await f.host.prepareQuietStop!(400), undefined, "a second quiet stop while the gate is closed refuses");
    f.host.resume();
    assert.equal((await f.control<ExecutionRecord>("execution/find", { threadId: "quiet-chat" })).revision, record.revision, "resume reopens the gate");
  } finally { await f.clean(); }
});

test("a chat waiting on an approval, an unreadable chat and an engine whose turn ended long ago", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const record = await f.control<ExecutionRecord>("execution/acquire", f.descriptor);
    const chat = await f.chat(record.socketPath, "approval-chat");
    await chat.turn({ status: "completed", completedAt: seconds(3_600_000) });
    await chat.status({ type: "loading" });
    assert.equal(await f.host.prepareQuietStop!(60_000), undefined, "a status the pinned SDK does not define is not proof of quiet");
    await chat.status({ type: "idle" });
    assert.deepEqual(await f.host.prepareQuietStop!(60_000), { loadedChats: 1 }, "the newest turn ended an hour ago");
    f.host.resume();
    await chat.status({ type: "active", activeFlags: ["waitingOnApproval"] });
    assert.equal(await f.host.prepareQuietStop!(60_000), undefined, "a turn waiting on an approval is a running turn");
    await chat.status({ type: "idle" });
    assert.equal(await f.host.prepareQuietStop!(60_000), undefined, "seen waiting at the last check, so its turn ended at the latest now");
  } finally { await f.clean(); }
});

test("an engine that exits during a turn clears its turns, and the turn counts as ended at the next check", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const record = await f.control<ExecutionRecord>("execution/acquire", f.descriptor);
    const chat = await f.chat(record.socketPath, "exit-chat");
    await chat.turn({ status: "inProgress" });
    assert.equal(await f.host.prepareQuietStop!(400), undefined);
    await assert.rejects(chat.engine.request("fixture/exit", {}));
    for (let attempt = 0; attempt < 200 && !((await f.control<{ generations: Array<{ state: string }> }>("execution/status")).generations[0]?.state === "exited"); attempt++) await delay(10);
    assert.equal(await f.host.prepareQuietStop!(400), undefined, "the turn the exit cut ended just now");
    await delay(450);
    assert.deepEqual(await f.host.prepareQuietStop!(400), { loadedChats: 0 }, "nothing runs once the quiet time has passed");
    f.host.resume();
  } finally { await f.clean(); }
});

test("a native chat's running turn blocks a quiet stop as a gateway chat's does", { timeout: 30000 }, async () => {
  const f = await fixture(["native", "gateway"]);
  try {
    const native = await f.control<NativeExecutionRecord>("native/acquire", { args: ["app-server", "--listen", "stdio://"], cwd: dirname(f.nativeHome) });
    const chat = await f.chat(native.socketPath, "native-chat");
    await chat.turn({ status: "inProgress" });
    assert.equal(await f.host.prepareQuietStop!(60_000), undefined, "a running native turn refuses");
    await chat.turn({ status: "interrupted", completedAt: null, startedAt: seconds(3_600_000) });
    assert.equal(await f.host.prepareQuietStop!(60_000), undefined, "seen running at the last check, so it ended at the latest now");
    assert.deepEqual(await f.host.prepareQuietStop!(0), { loadedChats: 1 });
    f.host.resume();
  } finally { await f.clean(); }
});

test("a saved chat untouched for well over the quiet time is judged by its read alone, without replaying its history", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const record = await f.control<ExecutionRecord>("execution/acquire", f.descriptor);
    const chat = await f.chat(record.socketPath, "idle-for-days");
    await chat.turn({ status: "completed", completedAt: seconds(2 * 86_400_000) }); await chat.updated(seconds(2 * 86_400_000));
    assert.deepEqual(await f.host.prepareQuietStop!(300_000), { loadedChats: 1 });
    assert.equal(await chat.turnReads(), 0, "the newest turn was not read");
    f.host.resume();
    // A throwaway chat has no saved history, so its updatedAt proves nothing: its newest turn is read.
    await chat.updated(seconds(2 * 86_400_000), true); await chat.turn({ status: "completed", completedAt: seconds(1000) });
    assert.equal(await f.host.prepareQuietStop!(300_000), undefined, "its turn ended a second ago");
    assert.equal(await chat.turnReads(), 1);
  } finally { await f.clean(); }
});
