import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { AppServerBackends } from "../app-server-backends.js";
import { object, type Message } from "../app-server-connection.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { executionHostHome, executionHostMarker, sdkIdentity, socketIdentity } from "../execution-host-storage.js";

/**
 * A fake execution host (control socket) and shared native engine (native socket) for adapter tests. The calling test file
 * isolates its execution roots and runs the host in process; see shared-native-backends.test.ts.
 */

/** Waits by the clock, not by a count of polls, so a loaded machine gets the same ten seconds as an idle one. */
export async function until(check: () => boolean, timeoutMs = 10_000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await delay(5)) if (check()) return;
  if (check()) return;
  assert.fail("Shared native fixture did not reach expected state");
}
export async function listener(path: string, handle: (client: WebSocket, message: Message) => void) {
  const server = createServer(); const sockets = new WebSocketServer({ server });
  sockets.on("connection", client => client.on("message", bytes => handle(client, object(JSON.parse(String(bytes))))));
  server.listen(path); await once(server, "listening"); await chmod(path, 0o600);
  return { sockets, async close() { for (const client of sockets.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); sockets.close(); } };
}
export const send = (client: WebSocket, message: Message) => client.send(JSON.stringify(message));
export const revision = "a".repeat(64);
export const instanceId = "11111111-1111-4111-8111-111111111111";
export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gw-shared-native-backends-"));
  const nativeHome = join(directory, "native"); const state = join(directory, "state");
  await mkdir(nativeHome, { mode: 0o700 }); await mkdir(state, { mode: 0o700 });
  const configText = 'model = "native-original"\n'; const authText = '{"fixtureOnly":"original-primary-secret"}\n';
  await writeFile(join(nativeHome, "config.toml"), configText, { mode: 0o600 }); await writeFile(join(nativeHome, "auth.json"), authText, { mode: 0o600 });
  const sdk = join(directory, "codex"); const spawnMarker = join(directory, "spawned");
  await writeFile(sdk, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(spawnMarker)},JSON.stringify({home:process.env.CODEX_HOME,authPresent:fs.existsSync(process.env.CODEX_HOME+'/auth.json')}));\n`, { mode: 0o700 });
  const configPath = join(directory, "gateway.json");
  const config: GatewayConfig = { version: 1, port: 3457, clientOnly: true, providers: [], stateDirectory: state };
  await writePrivateJson(configPath, config);
  await writePrivateJson(join(state, "service-plan.json"), { version: 1, config: configPath, sharedNativeExecutor: true,
    components: [{ id: "native", kind: "native", command: sdk, args: ["--daemon", "--relay-home", join(directory, "relay"), "--codex", sdk, "--native-home", nativeHome], log: join(state, "native.log") }] });
  const home = executionHostHome(configPath, nativeHome); await mkdir(home, { mode: 0o700, recursive: true });
  const nativePath = join(home, "native.sock"); const controlPath = join(home, "host.sock");
  const calls: Message[] = []; const nativeCalls: Message[] = []; const initializations: Message[] = []; const replies: Message[] = [];
  const threads = new Map<string, Message>(); const pending = new Map<string, Message>(); let sequence = 0;
  const native = await listener(nativePath, (client, message) => {
    nativeCalls.push(message);
    if (typeof message.method !== "string") { replies.push(message); return; }
    if (message.id === undefined) return;
    const params = object(message.params); let result: Message = {};
    if (message.method === "initialize") { initializations.push(params); result = { userAgent: "actual-native-fixture" }; }
    if (message.method === "account/read") result = { account: { type: "chatgpt", email: "fixture-primary@example.test" } };
    if (message.method === "config/read") result = { config: { model: "native-original", features: { hooks: false } } };
    if (message.method === "thread/start") {
      const id = "native-chat-" + ++sequence; const thread = { id, cwd: params.cwd, modelProvider: "openai" }; threads.set(id, thread);
      result = { thread, executorPid: process.pid, model: "native-original", modelProvider: "openai" };
    }
    if (message.method === "thread/read" || message.method === "thread/resume") {
      const thread = threads.get(String(params.threadId));
      if (!thread) { send(client, { id: message.id, error: { code: -32600, message: "Unknown fixture native thread" } }); return; }
      result = { thread, executorPid: process.pid, model: "native-original", modelProvider: "openai" };
      const request = pending.get(String(params.threadId)); if (message.method === "thread/resume" && request) send(client, request);
    }
    if (message.method === "turn/start") {
      result = { turn: { id: params.fixtureTurnId || "native-turn", status: "inProgress" } };
      const thread = threads.get(String(params.threadId)); if (thread) thread.turns = [result.turn];
      send(client, { method: "turn/started", params: { threadId: params.threadId, turn: result.turn } });
    }
    if (message.method === "turn/interrupt") {
      const thread = threads.get(String(params.threadId));
      if (thread && Array.isArray(thread.turns)) for (const turn of thread.turns) if (object(turn).id === params.turnId) object(turn).status = "interrupted";
      send(client, { method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
    }
    if (message.method === "fixture/approval") {
      const request = { id: 77, method: "item/commandExecution/requestApproval", params: { threadId: params.threadId, turnId: "native-turn", command: "fixture-only" } };
      pending.set(String(params.threadId), request); send(client, request);
    }
    if (message.method === "fixture/inconsistent") {
      const request = pending.get(String(params.threadId)); if (request) send(client, { ...request, params: { ...object(request.params), command: "changed-fixture" } });
    }
    if (message.method === "fixture/drop") { client.terminate(); return; }
    if (["thread/read", "thread/resume"].includes(message.method) && typeof params.delayMs === "number") {
      const reply = structuredClone({ id: message.id, result }); setTimeout(() => send(client, reply), params.delayMs); return;
    }
    send(client, { id: message.id, result });
  });
  // `refuseNative`: how many native/acquire requests to refuse as a host does while another live owner holds the native home.
  const hooks = { stallRelease: false, refuseNative: 0, nativeState: "running", deathObservedAt: 0, emit: undefined as undefined | ((message: Message) => Promise<void>) };
  const control = await listener(controlPath, (client, message) => {
    calls.push(message);
    if (message.method === "execution/release" && hooks.stallRelease) return;
    if (message.method === "native/acquire" && hooks.refuseNative > 0) { hooks.refuseNative--; send(client, { id: message.id, error: { code: -32000, message: "Native execution ownership is held by a live owner; existing ownership was preserved" } }); }
    else if (message.method === "native/acquire") send(client, { id: message.id, result: { kind: "native", revision, socketPath: nativePath, pid: process.pid, instanceId } });
    else if (message.method === "native/release") send(client, { id: message.id, result: {} });
    else if (message.method === "native/death") send(client, { id: message.id, result: { confirmed: hooks.nativeState === "exited" && Date.now() >= hooks.deathObservedAt && object(message.params).revision === revision && object(message.params).pid === process.pid && object(message.params).instanceId === instanceId, exitedAtMs: Date.now() } });
    else if (message.method === "execution/status") send(client, { id: message.id, result: { pid: process.pid, native: { kind: "native", revision, socketPath: nativePath, pid: hooks.nativeState === "exited" ? 0 : process.pid, state: hooks.nativeState } } });
    else send(client, { id: message.id, error: { code: -32000, message: "Native-only fixture forbids gateway control" } });
  });
  const owner = { version: 1, managed: executionHostMarker, configPath, nativeHome, ...await sdkIdentity(sdk), socketPath: controlPath,
    socket: await socketIdentity(controlPath), pid: process.pid, state: "running", generations: [], capabilities: ["native"] };
  await writePrivateJson(join(home, "owner.json"), owner);
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = nativeHome;
  const adapters = new Set<AppServerBackends>(); const snapshot = { models: [] as Message[], revision: "fixture" };
  const catalog = { current: () => snapshot, refresh: async () => snapshot, combined: (value: typeof snapshot) => ({ models: value.models }) } as unknown as DesktopCatalog;
  async function create() {
    const events: Message[] = []; let exits = 0;
    const adapter = await AppServerBackends.create(sdk, ["app-server", "--listen", "stdio://"], config, { features: { hooks: false } }, {}, catalog,
      async message => { events.push(message); await hooks.emit?.(message); }, () => { exits++; }, configPath);
    adapters.add(adapter); await adapter.request("initialize", { clientInfo: { name: "Codex Desktop", version: "fixture" }, capabilities: { experimentalApi: true } });
    adapter.notify({ method: "initialized" });
    return { adapter, events, exits: () => exits };
  }
  return { directory, nativeHome, config, configPath, home, sdk, create, calls, nativeCalls, threads, initializations, replies, owner, hooks, snapshot, spawnMarker,
    disconnectControl() { for (const client of control.sockets.clients) client.terminate(); },
    /** A host restart: the engine socket and the control connection close, and the host answers again at the same paths. */
    restartHost() { for (const client of native.sockets.clients) client.terminate(); for (const client of control.sockets.clients) client.terminate(); },
    closeNative: () => native.close(),
    nativeMessages(messages: Message[]) { for (const client of native.sockets.clients) for (const message of messages) send(client, message); },
    nativeDeath(observationDelayMs = 0) { hooks.nativeState = "exited"; hooks.deathObservedAt = Date.now() + observationDelayMs; for (const client of native.sockets.clients) client.terminate(); },
    async noSpawn() { await assert.rejects(readFile(spawnMarker), { code: "ENOENT" }); },
    async clean() {
      await Promise.all([...adapters].map(adapter => adapter.stop())); await control.close(); await native.close();
      if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
      assert.equal(await readFile(join(nativeHome, "config.toml"), "utf8"), configText); assert.equal(await readFile(join(nativeHome, "auth.json"), "utf8"), authText);
      await rm(directory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true });
    } };
}
