import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { startExecutionHost, executionHostHome, type ExecutionDescriptor, type ExecutionHostOptions } from "../execution-host.js";
import { sdkIdentity } from "../execution-host-storage.js";
import { nativeHomeOwnerPath } from "../native-execution-host-storage.js";
import { SocketAppServerConnection } from "../socket-app-server-connection.js";
import type { GatewayConfig } from "../config.js";

/**
 * A stand-in SDK that answers what the quiet check asks, the way the pinned SDK does (protocol v2): `thread/read` with the
 * live status (`active` while a turn runs or waits for an approval) and an `updatedAt` that is the time of the read for a
 * chat that saved nothing yet or is throwaway; `thread/backgroundTerminals/list`; `thread/turns/list` with the newest turn
 * and its `completedAt` in seconds, refused for a throwaway chat and for one with nothing saved yet.
 * `fixture/turn` sets a chat's newest turn (which saves the chat), `fixture/status` forces a status, `fixture/updated` sets
 * `updatedAt` and `ephemeral`, `fixture/terminal` starts (`running`) or ends a background terminal or makes the list fail
 * (`fail`), `fixture/turnReads` counts a chat's newest-turn reads, `fixture/calls` counts every non-fixture request this engine answered, `fixture/lateActive` makes a chat report `active` once it has been read that many times, `fixture/broken` makes `thread/loaded/list` fail, `fixture/exit` ends it.
 */
const source = (ws: string) => `#!${process.execPath}
import {createServer} from 'node:http';
import {WebSocketServer} from ${JSON.stringify(ws)};
if(process.argv.includes('--version')){console.log('codex-cli 0.162.0-alpha.17.2');process.exit(0);}
const args=process.argv.slice(2);const socket=args[args.indexOf('--listen')+1].slice(7);
const server=createServer();const wss=new WebSocketServer({server});const loaded=new Map();let broken=false;const calls={};
const now=()=>Date.now()/1000;
wss.on('connection',client=>client.on('message',bytes=>{const m=JSON.parse(bytes);if(m.id==null)return;let result={};const id=m.params&&m.params.threadId;const chat=id&&loaded.get(id);
const fail=message=>client.send(JSON.stringify({id:m.id,error:{code:-32600,message}}));if(!m.method.startsWith('fixture/'))calls[m.method]=(calls[m.method]||0)+1;
if(m.method==='thread/loaded/list'){if(broken)return fail('fixture: broken');result={data:[...loaded.keys()],nextCursor:null};}
if(m.method==='thread/start'||m.method==='thread/resume'){if(!chat)loaded.set(id,{id,updatedAt:now(),saved:false,ephemeral:false,turn:null,status:null,terminal:false,turnReads:0});result={thread:{id}};}
if(m.method==='thread/unsubscribe')loaded.delete(id);
if(m.method==='thread/read'){const late=chat&&chat.lateActive!==undefined&&(chat.reads=(chat.reads||0)+1)>chat.lateActive;result={thread:chat?{id,updatedAt:chat.saved&&!chat.ephemeral?chat.updatedAt:now(),ephemeral:chat.ephemeral,status:late?{type:'active',activeFlags:[]}:chat.status||(chat.turn&&chat.turn.status==='inProgress'?{type:'active',activeFlags:[]}:{type:'idle'})}:null};}
if(m.method==='thread/backgroundTerminals/list'){if(chat.terminal==='fail')return fail('fixture: terminals unavailable');result={data:chat.terminal?[{itemId:'item-1',processId:'42',command:'npm run dev',cwd:'/tmp',osPid:null,cpuPercent:null,rssKb:null}].slice(0,m.params.limit??1):[],nextCursor:null};}
if(m.method==='thread/turns/list'){chat.turnReads++;if(chat.ephemeral)return fail('ephemeral threads do not support thread/turns/list');if(chat.listFails||!chat.saved)return fail('no rollout found for thread id '+id);result={data:chat.turn?[chat.turn]:[],nextCursor:null,backwardsCursor:null};}
if(m.method==='fixture/turn'){chat.saved=true;chat.turn={id:'turn-'+Math.random(),rootTurnId:null,items:[],itemsView:'notLoaded',status:m.params.status,error:null,startedAt:m.params.startedAt===undefined?now():m.params.startedAt,completedAt:m.params.completedAt??null,durationMs:null};}
if(m.method==='fixture/saved')chat.saved=true;
if(m.method==='fixture/listFails')chat.listFails=true;
if(m.method==='fixture/status')chat.status=m.params.status;
if(m.method==='fixture/updated')Object.assign(chat,{updatedAt:m.params.updatedAt,ephemeral:m.params.ephemeral});
if(m.method==='fixture/terminal')chat.terminal=m.params.state;
if(m.method==='fixture/turnReads')result={turnReads:chat.turnReads};
if(m.method==='fixture/calls')result={calls};
if(m.method==='fixture/lateActive'){chat.reads=0;chat.lateActive=m.params.after;}
if(m.method==='fixture/broken')broken=true;
if(m.method==='fixture/exit')process.exit(0);
client.send(JSON.stringify({id:m.id,result}));}));
server.listen(socket);
process.on('SIGTERM',()=>{for(const c of wss.clients)c.terminate();server.close(()=>process.exit(0));});
`;

export const seconds = (msAgo = 0) => (Date.now() - msAgo) / 1000;

/** A host in this process, with one stand-in SDK for its engines, a control connection and engine clients. */
export async function quietHost(capabilities?: Array<"gateway" | "native">, hostOptions?: (codex: string) => Partial<ExecutionHostOptions>) {
  const directory = await mkdtemp(join(tmpdir(), "gw-quiet-")); const configPath = join(directory, "gateway.json");
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  await writeFile(join(nativeHome, "config.toml"), 'model = "native-original"\n', { mode: 0o600 });
  const codex = join(directory, "codex");
  await writeFile(codex, source(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href), { mode: 0o700 });
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: join(directory, "state"), providers: [], clientOnly: true };
  const hostHome = executionHostHome(configPath, nativeHome);
  const descriptor: ExecutionDescriptor = { revision: "a".repeat(64), args: ["app-server", "--listen", "stdio://"], settings: { model: "fixture" }, catalog: { models: [{ slug: "fixture" }] }, aliases: ["fixture"] };
  const nativeSdkVerifier = async (path: string) => { const identity = await sdkIdentity(path); return { nativeSdkExecutable: identity.codex, nativeSdkSha256: identity.sdkSha256 }; };
  const host = await startExecutionHost({ config, configPath, nativeHome, codex, ...(capabilities ? { capabilities, nativeSdkVerifier } : {}), ...hostOptions?.(codex) });
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
    const call = (method: string, params: object = {}) => engine.request(method, { threadId, ...params });
    return { engine, turn: (params: object) => call("fixture/turn", params), status: (status: object) => call("fixture/status", { status }),
      updated: (updatedAt: number, ephemeral = false) => call("fixture/updated", { updatedAt, ephemeral }),
      terminal: (state: boolean | "fail") => call("fixture/terminal", { state }), saved: () => call("fixture/saved"), listFails: () => call("fixture/listFails"),
      turnReads: async () => (await call("fixture/turnReads")).turnReads as number,
      calls: async () => (await call("fixture/calls")).calls as Record<string, number>, lateActive: (after: number) => call("fixture/lateActive", { after }) };
  };
  const clean = async () => {
    for (const engine of engines) engine.stop();
    socket.terminate(); await host.close();
    await rm(dirname(nativeHomeOwnerPath(nativeHome)), { recursive: true, force: true }); await rm(hostHome, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true });
  };
  return { host, control, chat, descriptor, configPath, nativeHome, codex, clean };
}
