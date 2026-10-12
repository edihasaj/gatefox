import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { AppServerBackends } from "../app-server-backends.js";
import { object, type Message } from "../app-server-connection.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { executionHostHome, executionHostMarker, sdkIdentity, socketIdentity } from "../execution-host-storage.js";
import type { ExecutionHostClient } from "../execution-host-client.js";
import { nativeHomeOwnerPath } from "../native-execution-host-storage.js";

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 400; attempt++) { if (check()) return; await delay(5); }
  assert.fail("Shared native fixture did not reach expected state");
}
async function listener(path: string, handle: (client: WebSocket, message: Message) => void) {
  const server = createServer(); const sockets = new WebSocketServer({ server });
  sockets.on("connection", client => client.on("message", bytes => handle(client, object(JSON.parse(String(bytes))))));
  server.listen(path); await once(server, "listening"); await chmod(path, 0o600);
  return { sockets, async close() { for (const client of sockets.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); sockets.close(); } };
}
const send = (client: WebSocket, message: Message) => client.send(JSON.stringify(message));
const revision = "a".repeat(64);
const instanceId = "11111111-1111-4111-8111-111111111111";
async function fixture() {
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
  const hooks = { stallRelease: false, nativeState: "running", deathObservedAt: 0, emit: undefined as undefined | ((message: Message) => Promise<void>) };
  const control = await listener(controlPath, (client, message) => {
    calls.push(message);
    if (message.method === "execution/release" && hooks.stallRelease) return;
    if (message.method === "native/acquire") send(client, { id: message.id, result: { kind: "native", revision, socketPath: nativePath, pid: process.pid, instanceId } });
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

test("two native adapters retain original account and shared session after either client closes", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); const second = await f.create();
    const started = await first.adapter.request("thread/start", { cwd: f.directory }); const id = String(object(started.thread).id);
    await first.adapter.request("turn/start", { threadId: id }); await first.adapter.stop();
    const resumed = await second.adapter.request("thread/resume", { threadId: id });
    assert.equal(resumed.executorPid, started.executorPid); assert.equal(object(resumed.thread).id, id);
    assert.equal(first.events.some(message => message.method === "error" || object(object(message.params).turn).status === "failed"), false);
    assert.deepEqual(await second.adapter.request("account/read", {}), { account: { type: "chatgpt", email: "fixture-primary@example.test" } });
    await second.adapter.request("turn/interrupt", { threadId: id, turnId: "native-turn" });
    await until(() => second.events.some(message => object(object(message.params).turn).status === "interrupted"));
    assert.equal(f.initializations.length, 2); assert.equal(object(f.initializations[0].clientInfo).name, "Codex Desktop");
    assert.equal(object(f.calls.find(message => message.method === "native/acquire")?.params).cwd, f.directory);
    assert.equal(f.calls.some(message => String(message.method).startsWith("execution/")), false);
    await f.noSpawn();
  } finally { await f.clean(); }
});

test("native-only adapter intent does not inherit gateway sharing from an older both-capability host", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await writePrivateJson(join(f.home, "owner.json"), { ...f.owner, capabilities: ["native", "gateway"] });
    const planPath = join(f.config.stateDirectory, "service-plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8")); await writePrivateJson(planPath, { ...plan, sharedExecutors: false });
    f.snapshot.models.push({ slug: "claude/fixture", display_name: "Claude fixture" });
    const first = await f.create(); assert.equal(first.adapter.native.shared, true);
    // The fixture CLI exits after recording its private gateway home. A shared
    // route would instead call the host's forbidden execution/acquire method.
    await assert.rejects(first.adapter.request("thread/start", { model: "claude/fixture", modelProvider: "subscription_gateway" }), /exited/);
    const spawned = JSON.parse(await readFile(f.spawnMarker, "utf8"));
    assert.notEqual(spawned.home, f.nativeHome); assert.ok(spawned.home.startsWith(join(f.config.stateDirectory, "desktop-generations") + "/"));
    assert.equal(spawned.authPresent, false); assert.equal(f.calls.some(message => String(message.method).startsWith("execution/")), false);
    assert.deepEqual(await first.adapter.request("account/read", {}), { account: { type: "chatgpt", email: "fixture-primary@example.test" } });
    assert.equal(first.adapter.native.closed, false);
  } finally { await f.clean(); }
});

test("turning off native sharing refuses a second original-native SDK while the old host owns it", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create();
    const planPath = join(f.config.stateDirectory, "service-plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8")); await writePrivateJson(planPath, { ...plan, sharedNativeExecutor: false });
    await assert.rejects(f.create(), (error: Error & { code?: number }) => error.code === -32001 && /still owns/.test(error.message));
    assert.equal(f.calls.filter(message => message.method === "native/acquire").length, 1); await f.noSpawn();
    assert.equal(first.adapter.native.closed, false); await first.adapter.request("account/read", {});
  } finally { await f.clean(); }
});

test("a global live or unconfirmed native-home lease blocks legacy native spawn without a local host receipt", { timeout: 10000 }, async () => {
  const f = await fixture(); const globalPath = nativeHomeOwnerPath(f.nativeHome);
  try {
    const planPath = join(f.config.stateDirectory, "service-plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8")); await writePrivateJson(planPath, { ...plan, sharedNativeExecutor: false });
    await rm(join(f.home, "owner.json"));
    for (const state of [{ hostPid: process.pid, pid: 0, sdkState: "idle" }, { hostPid: 0, pid: 0, sdkState: "starting" }]) {
      await writePrivateJson(globalPath, { version: 1, managed: "subscription-gateway-native-execution-owner", configPath: join(f.directory, "other.json"),
        nativeHome: f.nativeHome, codex: f.owner.codex, sdkSha256: f.owner.sdkSha256, socketPath: join(f.home, "native.sock"), state: "running", ...state });
      await assert.rejects(f.create(), (error: Error & { code?: number }) => error.code === -32001);
      await f.noSpawn();
    }
    assert.equal(f.calls.length, 0);
  } finally { await rm(dirname(globalPath), { recursive: true, force: true }); await f.clean(); }
});

test("native adapter shutdown rejects a stalled host control operation before waiting for creation", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); f.hooks.stallRelease = true;
    // A generation retirement awaits this real control RPC in the creation queue.
    const state = first.adapter as unknown as { nativeHost: { client: ExecutionHostClient }; creating: Promise<unknown> };
    const release = state.nativeHost.client.release("b".repeat(64));
    state.creating = release.catch(() => {});
    await until(() => f.calls.some(message => message.method === "execution/release"));
    await Promise.race([first.adapter.stop(), delay(1000).then(() => { throw new Error("Shutdown waited for the host RPC timeout"); })]);
    await assert.rejects(release, /closed/); assert.equal(f.threads.size, 0); await f.noSpawn();
  } finally { f.disconnectControl(); await f.clean(); }
});

test("shared native default workspace applies only to new chats", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create();
    const started = await first.adapter.request("thread/start", { cwd: null });
    assert.equal(object(started.thread).cwd, process.cwd());
    await first.adapter.request("thread/resume", { threadId: object(started.thread).id });
    await first.adapter.request("thread/fork", { threadId: object(started.thread).id });
    await first.adapter.native.request("config/read", {}); await first.adapter.native.request("config/read", { cwd: null });
    await first.adapter.native.request("configRequirements/read", {}); await first.adapter.native.request("externalAgentConfig/detect", { cwds: [f.directory] });
    for (const method of ["thread/resume", "thread/fork", "configRequirements/read", "externalAgentConfig/detect"]) {
      assert.equal(Object.hasOwn(object(f.nativeCalls.find(message => message.method === method)?.params), "cwd"), false);
    }
    const reads = f.nativeCalls.filter(message => message.method === "config/read");
    assert.deepEqual(reads.map(message => object(message.params)), [{}, { cwd: null }]);
    await f.noSpawn();
  } finally { await f.clean(); }
});

test("shared-native transport loss closes frontend without reporting native SDK death", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); const started = await first.adapter.request("thread/start", { cwd: f.directory }); const id = String(object(started.thread).id);
    await first.adapter.request("turn/start", { threadId: id });
    await first.adapter.request("fixture/drop", {}).catch(() => {}); await until(() => first.exits() === 1);
    assert.equal(first.events.some(message => message.method === "error" || message.method === "turn/completed"), false);
    const second = await f.create(); assert.equal(object((await second.adapter.request("thread/resume", { threadId: id })).thread).id, id);
    assert.equal(f.threads.has(id), true); await f.noSpawn();
  } finally { await f.clean(); }
});

test("confirmed native SDK death reports the actual active turn from a warm resume snapshot", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); const id = String(object((await first.adapter.request("thread/start", {})).thread).id);
    await first.adapter.request("turn/start", { threadId: id }); await first.adapter.stop();
    const second = await f.create(); await second.adapter.request("thread/resume", { threadId: id });
    assert.equal(second.events.some(message => message.method === "turn/started"), false);
    f.nativeDeath(); await until(() => second.exits() === 1);
    const failed = second.events.filter(message => object(object(message.params).turn).status === "failed");
    assert.equal(failed.length, 1); assert.equal(object(failed[0].params).threadId, id); assert.equal(object(object(failed[0].params).turn).id, "native-turn");
    assert.equal(second.events.filter(message => message.method === "error").length, 1);
    assert.doesNotMatch(JSON.stringify(second.events), /original-primary-secret/); await f.noSpawn();
  } finally { await f.clean(); }
});

test("native socket EOF before the host close observer waits only for the exact launch death", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); const id = String(object((await first.adapter.request("thread/start", {})).thread).id);
    await first.adapter.request("turn/start", { threadId: id }); f.nativeDeath(100);
    await until(() => first.adapter.native.closed); assert.equal(first.exits(), 0);
    await until(() => first.exits() === 1);
    const lookups = f.calls.filter(message => message.method === "native/death"); assert.ok(lookups.length >= 2);
    for (const lookup of lookups) assert.deepEqual(lookup.params, { revision, pid: process.pid, instanceId });
    const failed = first.events.filter(message => object(object(message.params).turn).status === "failed");
    assert.equal(failed.length, 1); assert.equal(object(object(failed[0].params).turn).id, "native-turn");
  } finally { await f.clean(); }
});

test("native unsubscribe and warm resume replace a stale active turn with the real current turn", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); const id = String(object((await first.adapter.request("thread/start", {})).thread).id);
    await first.adapter.request("turn/start", { threadId: id }); await first.adapter.request("thread/unsubscribe", { threadId: id });
    const second = await f.create(); await second.adapter.request("turn/interrupt", { threadId: id, turnId: "native-turn" });
    await second.adapter.request("turn/start", { threadId: id, fixtureTurnId: "native-next-turn" });
    await first.adapter.request("thread/resume", { threadId: id }); f.nativeDeath(); await until(() => first.exits() === 1);
    const failed = first.events.filter(message => object(object(message.params).turn).status === "failed");
    assert.deepEqual(failed.map(message => object(object(message.params).turn).id), ["native-next-turn"]);
  } finally { await f.clean(); }
});

test("a delayed native resume snapshot cannot replace a newer actual turn notification", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); const id = String(object((await first.adapter.request("thread/start", {})).thread).id);
    await first.adapter.request("turn/start", { threadId: id });
    const resume = first.adapter.request("thread/resume", { threadId: id, delayMs: 75 });
    await until(() => f.nativeCalls.some(message => message.method === "thread/resume"));
    const turn = { id: "native-newer-turn", status: "inProgress" }; f.threads.get(id)!.turns = [turn];
    f.nativeMessages([{ method: "turn/started", params: { threadId: id, turn } }]);
    await resume; f.nativeDeath(); await until(() => first.exits() === 1);
    const failed = first.events.filter(message => object(object(message.params).turn).status === "failed");
    assert.deepEqual(failed.map(message => object(object(message.params).turn).id), ["native-newer-turn"]);
  } finally { await f.clean(); }
});

test("buffered native completion drains before confirmed SDK death is assessed", { timeout: 10000 }, async () => {
  const f = await fixture(); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const first = await f.create();
    f.hooks.emit = async message => { if (message.method === "turn/started") await held; };
    f.nativeMessages([{ method: "turn/started", params: { threadId: "buffered-chat", turn: { id: "buffered-turn", status: "inProgress" } } },
      { method: "turn/completed", params: { threadId: "buffered-chat", turn: { id: "buffered-turn", status: "completed" } } }]);
    await until(() => first.events.length === 1); await delay(5); f.nativeDeath();
    await until(() => first.adapter.native.closed); assert.equal(first.exits(), 0);
    release(); await until(() => first.exits() === 1);
    assert.deepEqual(first.events.map(message => message.method), ["turn/started", "turn/completed"]);
    assert.equal(object(object(first.events[1].params).turn).status, "completed"); await f.noSpawn();
  } finally { release(); await f.clean(); }
});

test("deliberate shared-native stop discards queued notifications without awaiting blocked output", { timeout: 10000 }, async () => {
  const f = await fixture(); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const first = await f.create();
    f.hooks.emit = async message => { if (message.method === "turn/started") await held; };
    f.nativeMessages([{ method: "turn/started", params: { threadId: "held-chat", turn: { id: "held-turn", status: "inProgress" } } },
      { method: "turn/completed", params: { threadId: "held-chat", turn: { id: "held-turn", status: "completed" } } }]);
    await until(() => first.events.length === 1);
    await Promise.race([first.adapter.stop(), delay(1000, undefined, { ref: false }).then(() => { throw new Error("Client stop waited for blocked output"); })]);
    release(); await first.adapter.native.drained;
    assert.deepEqual(first.events.map(message => message.method), ["turn/started"]); assert.equal(first.exits(), 1);
    await f.noSpawn();
  } finally { release(); await f.clean(); }
});

test("warm native resume reuses pending approval ID and rejects inconsistent replay", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); const id = String(object((await first.adapter.request("thread/start", { cwd: f.directory })).thread).id);
    await first.adapter.request("fixture/approval", { threadId: id }); await first.adapter.request("thread/resume", { threadId: id });
    await until(() => first.events.filter(message => message.method === "item/commandExecution/requestApproval").length === 2);
    const approvals = first.events.filter(message => message.method === "item/commandExecution/requestApproval"); assert.equal(approvals[0].id, approvals[1].id);
    assert.equal(first.adapter.reply({ id: approvals[0].id, result: { decision: "accept" } }), true);
    await until(() => f.replies.length === 1); assert.equal(f.replies[0].id, 77);
    await first.adapter.request("thread/resume", { threadId: id }); await delay(10);
    assert.equal(first.exits(), 0); assert.equal(first.events.filter(message => message.method === "item/commandExecution/requestApproval").length, 2);
    assert.equal(f.replies.length, 1);
    const second = await f.create(); await second.adapter.request("fixture/approval", { threadId: id });
    await second.adapter.request("fixture/inconsistent", { threadId: id }); await until(() => second.exits() === 1);
    assert.equal(second.events.some(message => message.method === "turn/completed"), false); await f.noSpawn();
  } finally { await f.clean(); }
});

test("configured native sharing fails closed for missing host, wrong scope, or absent capability", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    for (const owner of [undefined, { ...f.owner, nativeHome: join(f.directory, "wrong") }, { ...f.owner, capabilities: ["gateway"] }]) {
      if (owner) await writePrivateJson(join(f.home, "owner.json"), owner); else await rm(join(f.home, "owner.json"));
      await assert.rejects(f.create(), (error: Error & { code?: number }) => error.code === -32001);
      await f.noSpawn();
    }
    assert.equal(f.calls.length, 0);
    await writePrivateJson(join(f.home, "owner.json"), f.owner);
    const planPath = join(f.config.stateDirectory, "service-plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8")); await writePrivateJson(planPath, { ...plan, sharedExecutors: true });
    await assert.rejects(f.create(), (error: Error & { code?: number }) => error.code === -32001 && /gateway/.test(error.message));
    await f.noSpawn(); assert.equal(f.calls.length, 0);
  } finally { await f.clean(); }
});
