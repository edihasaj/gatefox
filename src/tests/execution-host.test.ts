import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { startExecutionHost, executionHostHome, type ExecutionDescriptor, type ExecutionRecord } from "../execution-host.js";
import { SocketAppServerConnection } from "../socket-app-server-connection.js";
import { ExecutionEngine, executionArgs, executionDescriptor } from "../execution-host-engine.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { connectOnce, readOwner, sdkIdentity, sdkSocketTarget, setSocketProbeForTests, socketIdentity, type ProbeResult } from "../execution-host-storage.js";
import { ExecutionHostClient } from "../execution-host-client.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-execution-")); const configPath = join(directory, "gateway.json");
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  await writeFile(join(nativeHome, "config.toml"), 'model = "native-original"\n', { mode: 0o600 });
  await writeFile(join(nativeHome, "auth.json"), '{"fixture":"must-not-be-copied"}', { mode: 0o600 });
  const sdk = join(directory, "codex");
  await writeFile(sdk, `#!${process.execPath}\nimport {createServer} from 'node:http';
import {existsSync, writeFileSync} from 'node:fs';
import {WebSocketServer} from ${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)};
if(process.argv.includes('--version')) { console.log('codex-cli 0.162.0-alpha.17.2'); process.exit(0); }
const args=process.argv.slice(2);const socket=args[args.indexOf('--listen')+1].slice(7);
const gate=args.includes('--fixture-gate')?args[args.indexOf('--fixture-gate')+1]:undefined;
const server=createServer();const ws=new WebSocketServer({server});const loaded=new Set();let hangLoaded=false;
ws.on('connection',client=>client.on('message',bytes=>{const m=JSON.parse(bytes);if(m.id==null)return;let result={};
if(m.method==='thread/loaded/list'){if(hangLoaded)return;result={data:[...loaded],nextCursor:null};}
if(m.method==='thread/start'||m.method==='thread/resume'){const id=m.params.threadId||'fixture-thread';loaded.add(id);result={thread:{id}};}
if(m.method==='thread/unsubscribe')loaded.delete(m.params.threadId);
if(m.method==='fixture/hangLoaded')hangLoaded=m.params.hang===true;
client.send(JSON.stringify({id:m.id,result}));}));
const listen=()=>server.listen(socket,()=>writeFileSync(args[args.indexOf('--fixture-state')+1],JSON.stringify({pid:process.pid,socket,home:process.env.CODEX_HOME,args})));
if(gate){const wait=setInterval(()=>{if(existsSync(gate)){clearInterval(wait);listen();}},20);}else listen();
process.on('SIGTERM',()=>{for(const c of ws.clients)c.terminate();server.close(()=>process.exit(0));});
`, { mode: 0o700 });
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: join(directory, "state"), providers: [], clientOnly: true };
  const hostHome = executionHostHome(configPath, nativeHome);
  const descriptor = (digit = "a"): ExecutionDescriptor => ({ revision: digit.repeat(64), args: ["app-server", "--listen", "stdio://", "--fixture-state", join(directory, `engine-${digit}.json`)], settings: { model: "fixture", agents: { max_concurrent_threads_per_session: 30 } }, catalog: { models: [{ slug: "fixture", tool_mode: "direct" }] }, aliases: ["fixture"] });
  const clean = async () => { await rm(directory, { recursive: true, force: true }); await rm(hostHome, { recursive: true, force: true }); };
  return { directory, config, configPath, nativeHome, codex: sdk, hostHome, descriptor, clean };
}
async function control(path: string) {
  const socket = new WebSocket(`ws+unix://${path}:/`, { maxPayload: 4 * 1024 * 1024 }); await once(socket, "open"); let sequence = 0;
  const request = <T>(method: string, params = {}): Promise<T> => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture timed out")), 10000);
      const listener = (bytes: WebSocket.RawData) => { const message = JSON.parse(bytes.toString()); if (message.id !== id) return; clearTimeout(timer); socket.off("message", listener); message.error ? reject(new Error(message.error.message)) : resolve(message.result); };
      socket.on("message", listener); socket.send(JSON.stringify({ id, method, params }));
    });
  };
  return { socket, request, close: async () => { socket.terminate(); await once(socket, "close"); } };
}
async function eventually(check: () => Promise<boolean>, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  assert.fail(message);
}

test("execution descriptors bound metadata and replace only host-owned socket/catalog arguments", () => {
  assert.throws(() => executionDescriptor({ revision: "a".repeat(64), args: ["app-server"], settings: {}, catalog: { models: [] }, aliases: [] }), /Invalid execution/);
  assert.deepEqual(executionArgs(["app-server", "--listen", "stdio://", "-c", 'model_catalog_json="old"', "-c", "features.step_model_switching=true"], "/private.sock", "/private.json"), ["app-server", "-c", "features.step_model_switching=true", "--listen", "unix:///private.sock", "-c", 'model_catalog_json="/private.json"']);
  const descriptor = { revision: "a".repeat(64), args: ["app-server"], settings: { agents: { default_subagent_model: "client-choice" } }, catalog: { models: [{ slug: "fixture" }] }, aliases: ["fixture"] };
  assert.deepEqual(executionDescriptor({ ...descriptor, agentsDirectory: "/obsolete/gateway-profiles" }), descriptor);
});

test("a shared host cleans flags from an older adapter before its SDK starts", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client;
  try {
    host = await startExecutionHost({ config: f.config, configPath: f.configPath, nativeHome: f.nativeHome, codex: f.codex });
    client = await control(join(f.hostHome, "host.sock"));
    const descriptor = f.descriptor();
    descriptor.args.push("-c", "features.code_mode_tool_description_first=true", "-c", "features.guardianv2.thread_context=false", "--disable", "codex_hooks", "-c", "features.code_mode.enabled=true");
    descriptor.settings.features = { hooks: true, code_mode: { enabled: true }, guardianv2: { enabled: false } };
    const original = JSON.stringify(descriptor);
    await client.request("execution/acquire", { descriptor });
    const observed = JSON.parse(await readFile(join(f.directory, "engine-a.json"), "utf8")) as { args: string[]; home: string };
    assert.ok(!observed.args.some(arg => /code_mode_tool_description_first|codex_hooks|guardianv2\.thread_context/.test(arg)));
    assert.ok(observed.args.includes("features.code_mode.enabled=true"));
    const settings = await readFile(join(observed.home, "config.toml"), "utf8");
    assert.match(settings, /"hooks"\s*=\s*true/);
    assert.equal(JSON.stringify(descriptor), original);
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model = "native-original"\n');
  } finally { await client?.close(); await host?.close(); await f.clean(); }
});

test("a host without Code Mode normalizes old catalogs before persistent generation ownership", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let raw; let adapter: ExecutionHostClient | undefined;
  try {
    host = await startExecutionHost(f); raw = await control(join(f.hostHome, "host.sock"));
    const legacy = f.descriptor();
    legacy.catalog = { models: [
      { slug: "missing", instructions: "preserve", model_provider: "gateway", permissions: { allow: ["exec"] } },
      { slug: "unknown", tool_mode: "something_future", review: { required: true }, args: ["kept"] },
      { slug: "direct", tool_mode: "direct", model: "kept" },
    ] };
    legacy.aliases = legacy.catalog.models.map(row => String(row.slug));
    const original = structuredClone(legacy);
    const first = await raw.request<ExecutionRecord>("execution/acquire", legacy);
    assert.notEqual(first.revision, legacy.revision, "the incompatible catalog gets its own immutable generation directory");
    assert.deepEqual(legacy, original, "the old adapter descriptor is never mutated");
    const state = JSON.parse(await readFile(join(f.directory, "engine-a.json"), "utf8")) as { args: string[] };
    const inline = state.args.find(arg => arg.startsWith("model_catalog_json="));
    assert.ok(inline);
    const catalogPath = JSON.parse(inline!.slice("model_catalog_json=".length)) as string;
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as { models: Array<Record<string, unknown>> };
    assert.deepEqual(catalog.models, [
      { slug: "missing", instructions: "preserve", model_provider: "gateway", permissions: { allow: ["exec"] }, tool_mode: "direct" },
      { slug: "unknown", tool_mode: "direct", review: { required: true }, args: ["kept"] },
      { slug: "direct", tool_mode: "direct", model: "kept" },
    ]);
    assert.equal((await raw.request<ExecutionRecord>("execution/acquire", legacy)).revision, first.revision, "the same old descriptor reattaches to the normalized generation");
    adapter = await ExecutionHostClient.discover(f.configPath, f.nativeHome, f.codex, "gateway", true);
    assert.ok(adapter);
    assert.equal((await adapter.acquire(legacy)).revision, first.revision, "a client accepts the host's normalized revision");
    await assert.rejects(raw.request("execution/acquire", { ...legacy, settings: { model: "changed" } }), /cannot change/, "a caller cannot take over normalized ownership by reusing its old revision");
    const direct = f.descriptor("b");
    assert.equal((await raw.request<ExecutionRecord>("execution/acquire", direct)).revision, direct.revision, "already direct rows keep their adapter revision");
  } finally { adapter?.close(); await raw?.close(); await host?.close(); await f.clean(); }
});

test("a legacy app SDK with its Code Mode companion preserves an unset tool mode", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client;
  try {
    await writeFile(join(dirname(f.codex), "codex-code-mode-host"), "#!/bin/sh\n", { mode: 0o700 });
    host = await startExecutionHost(f); client = await control(join(f.hostHome, "host.sock"));
    const descriptor = f.descriptor();
    descriptor.catalog = { models: [{ slug: "fixture" }] };
    assert.equal((await client.request<ExecutionRecord>("execution/acquire", descriptor)).revision, descriptor.revision);
  } finally { await client?.close(); await host?.close(); await f.clean(); }
});

test("a gateway SDK enables Code Mode only when its verified receipt pinned the host", { timeout: 30000 }, async () => {
  const f = await fixture(); const binarySha256 = (await sdkIdentity(f.codex)).sdkSha256;
  try {
    for (const codeModeHost of [true, false]) {
      // The companion sits beside the executable in both runs: an adjacent file the receipt never
      // recorded must not manufacture the capability, and a recorded one must not need it.
      await writeFile(join(dirname(f.codex), "codex-code-mode-host"), "#!/bin/sh\n", { mode: 0o700 });
      const host = await startExecutionHost({ ...f, gatewayRuntime: async () => ({ executable: f.codex, binarySha256, selectedModelCompaction: true as const, executorIdentity: true as const, codeModeHost }) });
      const client = await control(join(f.hostHome, "host.sock"));
      const descriptor = f.descriptor(codeModeHost ? "c" : "d");
      descriptor.catalog = { models: [{ slug: "fixture" }] }; descriptor.gatewaySdkSha256 = binarySha256;
      const record = await client.request<ExecutionRecord>("execution/acquire", descriptor);
      if (codeModeHost) assert.equal(record.revision, descriptor.revision, "a verified host keeps the adapter's row byte-for-byte");
      else assert.notEqual(record.revision, descriptor.revision, "a host the receipt did not pin gives the row direct tools");
      await client.close(); await host.close();
    }
  } finally { await f.clean(); }
});

test("shared execution survives adapter disconnect, finds loaded owners, and preserves native files", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let first; let second; let admin1; let admin2;
  try {
    host = await startExecutionHost(f); first = await control(join(f.hostHome, "host.sock")); second = await control(join(f.hostHome, "host.sock"));
    assert.deepEqual(await first.request("execution/find", { threadId: "not-loaded" }), { found: false });
    const a = await first.request<ExecutionRecord>("execution/acquire", f.descriptor()); const b = await second.request<ExecutionRecord>("execution/acquire", f.descriptor()); assert.deepEqual(a, b);
    const info = JSON.parse(await readFile(join(f.directory, "engine-a.json"), "utf8")); assert.equal((await lstat(a.socketPath)).mode & 0o777, 0o600);
    admin1 = new SocketAppServerConnection(a.socketPath, async () => {}); await admin1.ready; await admin1.request("initialize", {}); admin1.send({ method: "initialized" });
    await admin1.request("thread/start", { threadId: "persisted-thread" }); admin1.stop(); await admin1.exited; await first.close();
    assert.deepEqual(await second.request("execution/find", { threadId: "persisted-thread" }), a);
    admin2 = new SocketAppServerConnection(a.socketPath, async () => {}); await admin2.ready; await admin2.request("initialize", {}); admin2.send({ method: "initialized" });
    assert.deepEqual((await admin2.request("thread/resume", { threadId: "persisted-thread" })).thread, { id: "persisted-thread" });
    assert.equal(info.pid, JSON.parse(await readFile(join(f.directory, "engine-a.json"), "utf8")).pid);
    await assert.rejects(second.request("execution/acquire", { ...f.descriptor(), settings: { model: "changed" } }), /cannot change/);
    await assert.rejects(startExecutionHost(f), /already owns/);
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model = "native-original"\n');
    await assert.rejects(lstat(join(info.home, "auth.json")), { code: "ENOENT" });
    assert.equal(await readFile(join(f.nativeHome, "auth.json"), "utf8"), '{"fixture":"must-not-be-copied"}');
    admin2.stop(); await admin2.exited; await second.close(); await host.close(); host = undefined;
    const receipt = JSON.parse(await readFile(join(f.hostHome, "owner.json"), "utf8")); assert.equal(receipt.state, "stopped"); assert.equal(receipt.pid, 0);
    host = await startExecutionHost(f);
  } finally { admin1?.stop(); admin2?.stop(); first?.socket.terminate(); second?.socket.terminate(); await host?.close(); await f.clean(); }
});

test("more than four execution generations preserve loaded/leased owners and reclaim unused engines", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client!: Awaited<ReturnType<typeof control>>; let engineClient;
  try {
    host = await startExecutionHost(f); client = await control(join(f.hostHome, "host.sock"));
    const first = await client.request<ExecutionRecord>("execution/acquire", f.descriptor("a"));
    engineClient = new SocketAppServerConnection(first.socketPath, async () => {}); await engineClient.ready;
    await engineClient.request("initialize", {}); engineClient.send({ method: "initialized" });
    await engineClient.request("thread/start", { threadId: "loaded-without-a-client-lease" });
    engineClient.stop(); await engineClient.exited;
    for (const digit of ["b", "c", "d"]) await client.request("execution/acquire", f.descriptor(digit));
    await client.request("execution/acquire", f.descriptor("e"));
    await client.request("execution/release", { revision: "a".repeat(64) });
    await client.request("execution/acquire", f.descriptor("f"));
    const observer = await ExecutionHostClient.discover(f.configPath, f.nativeHome, f.codex, "gateway", true);
    try { assert.equal((await observer!.generations()).length, 6); } finally { observer?.close(); }
    assert.equal((await readOwner(join(f.hostHome, "owner.json")))?.generations.length, 6);
    await client.request("execution/release", { revision: "b".repeat(64) });
    const next = await client.request<ExecutionRecord>("execution/acquire", f.descriptor("1")); assert.equal(next.revision, "1".repeat(64));
    await eventually(async () => {
      const state = await client.request<{ generations: ExecutionRecord[] }>("execution/status");
      return state.generations.length === 6 && state.generations.some(g => g.revision === "a".repeat(64)) && !state.generations.some(g => g.revision === "b".repeat(64));
    }, "the released empty generation was retired in the background");
    assert.deepEqual(await client.request("execution/find", { threadId: "loaded-without-a-client-lease" }), first);
  } finally { engineClient?.stop(); client?.socket.terminate(); await host?.close(); await f.clean(); }
});

test("generation maintenance is asynchronous, retries unloaded chats, and does not block a new catalog", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client!: Awaited<ReturnType<typeof control>>; let engine: SocketAppServerConnection | undefined;
  try {
    host = await startExecutionHost({ ...f, maintenance: { intervalMs: 25 } }); client = await control(join(f.hostHome, "host.sock"));
    const first = await client.request<ExecutionRecord>("execution/acquire", f.descriptor("a"));
    engine = new SocketAppServerConnection(first.socketPath, async () => {}); await engine.ready; await engine.request("initialize", {}); engine.send({ method: "initialized", params: {} });
    await engine.request("thread/start", { threadId: "later-unloaded" }); await client.request("execution/release", { revision: "a".repeat(64) });
    await delay(100);
    assert.ok((await client.request<{ generations: ExecutionRecord[] }>("execution/status")).generations.some(row => row.revision === "a".repeat(64)), "a loaded chat preserves its writer");
    await engine.request("thread/unsubscribe", { threadId: "later-unloaded" });
    await eventually(async () => !(await client.request<{ generations: ExecutionRecord[] }>("execution/status")).generations.some(row => row.revision === "a".repeat(64)), "periodic maintenance retires a chat after it unloads");

    const stalled = await client.request<ExecutionRecord>("execution/acquire", f.descriptor("b"));
    engine.stop(); await engine.exited; engine = new SocketAppServerConnection(stalled.socketPath, async () => {}); await engine.ready; await engine.request("initialize", {}); engine.send({ method: "initialized", params: {} });
    await engine.request("fixture/hangLoaded", { hang: true }); await client.request("execution/release", { revision: "b".repeat(64) }); await delay(50);
    const started = performance.now(); const next = await client.request<ExecutionRecord>("execution/acquire", f.descriptor("c"));
    assert.equal(next.revision, "c".repeat(64)); assert.ok(performance.now() - started < 2_000, "a hung old probe does not delay a new catalog");
    await delay(100); assert.ok((await client.request<{ generations: ExecutionRecord[] }>("execution/status")).generations.some(row => row.revision === "c".repeat(64)), "a lease acquired during maintenance preserves its writer");
    await engine.request("fixture/hangLoaded", { hang: false });
  } finally { engine?.stop(); client?.socket.terminate(); await host?.close(); await f.clean(); }
});

test("maintenance never retires a writer from an empty probe made stale by a new lease", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client!: Awaited<ReturnType<typeof control>>; let direct: SocketAppServerConnection | undefined;
  const original = ExecutionEngine.prototype.loadedThreads; let releaseProbe!: () => void; let probeSeen!: () => void;
  const heldProbe = new Promise<void>(resolve => { releaseProbe = resolve; }); const probeObserved = new Promise<void>(resolve => { probeSeen = resolve; });
  let hold = false; let observed = false;
  ExecutionEngine.prototype.loadedThreads = async function(this: ExecutionEngine) {
    const threads = await original.call(this);
    if (hold && this.record.revision === "a".repeat(64) && !observed) { observed = true; probeSeen(); await heldProbe; }
    return threads;
  };
  try {
    host = await startExecutionHost({ ...f, maintenance: { intervalMs: 60_000 } }); client = await control(join(f.hostHome, "host.sock"));
    const first = await client.request<ExecutionRecord>("execution/acquire", f.descriptor("a"));
    hold = true; await client.request("execution/release", { revision: "a".repeat(64) }); await probeObserved;
    const attached = await client.request<ExecutionRecord>("execution/acquire", f.descriptor("a")); assert.deepEqual(attached, first);
    direct = new SocketAppServerConnection(first.socketPath, async () => {}); await direct.ready; await direct.request("initialize", {}); direct.send({ method: "initialized", params: {} });
    await direct.request("thread/start", { threadId: "stale-empty-chat" }); await client.request("execution/release", { revision: "a".repeat(64) }); releaseProbe();
    await delay(100);
    assert.ok((await client.request<{ generations: ExecutionRecord[] }>("execution/status")).generations.some(row => row.revision === first.revision), "the original writer remains owned");
    assert.deepEqual(await client.request("execution/find", { threadId: "stale-empty-chat" }), first);
    assert.deepEqual((await direct.request("thread/resume", { threadId: "stale-empty-chat" })).thread, { id: "stale-empty-chat" });
  } finally { releaseProbe?.(); ExecutionEngine.prototype.loadedThreads = original; direct?.stop(); client?.socket.terminate(); await host?.close(); await f.clean(); }
});

test("disconnecting the final lease retires an empty generation without another acquire", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let holder!: Awaited<ReturnType<typeof control>>; let observer!: Awaited<ReturnType<typeof control>>;
  try {
    host = await startExecutionHost({ ...f, maintenance: { intervalMs: 60_000 } }); holder = await control(join(f.hostHome, "host.sock")); observer = await control(join(f.hostHome, "host.sock"));
    await holder.request("execution/acquire", f.descriptor("a")); await holder.close();
    await eventually(async () => (await observer.request<{ generations: ExecutionRecord[] }>("execution/status")).generations.length === 0, "disconnect cleanup retires the empty writer");
  } finally { holder?.socket.terminate(); observer?.socket.terminate(); await host?.close(); await f.clean(); }
});

test("execution/status answers at once while an acquire holds the control queue, so a busy host never looks hung", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client;
  try {
    host = await startExecutionHost(f); client = await control(join(f.hostHome, "host.sock"));
    // The engine this acquire starts listens only once the gate file exists, so the acquire holds the queue until then.
    const gate = join(f.directory, "listen"); const descriptor = f.descriptor("a"); descriptor.args.push("--fixture-gate", gate);
    let acquired = false;
    const acquiring = client.request<ExecutionRecord>("execution/acquire", descriptor).then(record => { acquired = true; return record; });
    await delay(300);
    const asked = performance.now();
    const status = await client.request<{ version: number; pid: number }>("execution/status");
    assert.equal(acquired, false, "the acquire was still waiting for its engine");
    assert.ok(performance.now() - asked < 2000, "the answer did not wait behind it");
    assert.equal(status.version, 1); assert.equal(status.pid, process.pid);
    await writeFile(gate, "");
    assert.equal((await acquiring).revision, "a".repeat(64), "the acquire then finished as usual");
  } finally { await client?.close(); await host?.close(); await f.clean(); }
});

test("execution host refuses unrecorded occupied sockets", { timeout: 10000 }, async () => {
  const f = await fixture(); const server = createServer();
  try {
    await mkdir(f.hostHome, { recursive: true, mode: 0o700 }); server.listen(join(f.hostHome, "host.sock")); await once(server, "listening"); await chmod(join(f.hostHome, "host.sock"), 0o600);
    await assert.rejects(startExecutionHost(f), /belongs to another listener/); assert.ok(server.listening);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.clean(); }
});

test("execution host refuses arbitrary files even with a stopped managed receipt", { timeout: 10000 }, async () => {
  const f = await fixture(); let host;
  try {
    host = await startExecutionHost(f); await host.close(); host = undefined;
    const owner = JSON.parse(await readFile(join(f.hostHome, "owner.json"), "utf8"));
    // A stopped managed receipt alone never authorizes deleting an arbitrary file.
    await writeFile(join(f.hostHome, "host.sock"), "unexpected", { mode: 0o600 });
    await writePrivateJson(join(f.hostHome, "owner.json"), owner);
    await assert.rejects(startExecutionHost(f), /Execution socket must/);
    assert.equal(await readFile(join(f.hostHome, "host.sock"), "utf8"), "unexpected");
  } finally { await host?.close(); await f.clean(); }
});

test("execution host recovers a dead inode-matched socket and preserves live generation owners", { timeout: 15000 }, async () => {
  const f = await fixture(); let host; let orphan;
  try {
    host = await startExecutionHost(f); await host.close(); host = undefined;
    const receiptPath = join(f.hostHome, "owner.json"); const owner = JSON.parse(await readFile(receiptPath, "utf8"));
    const path = join(f.hostHome, "host.sock");
    orphan = spawn(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1],()=>console.log('ready'))", path], { stdio: ["ignore", "pipe", "ignore"] });
    await once(orphan.stdout!, "data"); await chmod(path, 0o600);
    const socket = await lstat(path); owner.socket = { inode: String(socket.ino), device: String(socket.dev) }; owner.pid = orphan.pid; owner.state = "running";
    const exited = once(orphan, "close"); orphan.kill("SIGKILL"); await exited;
    assert.ok((await lstat(path)).isSocket()); await writePrivateJson(receiptPath, owner);
    host = await startExecutionHost(f); await host.close(); host = undefined;
    const stopped = JSON.parse(await readFile(receiptPath, "utf8"));
    stopped.generations = [{ revision: "a".repeat(64), pid: process.pid, socketPath: join(f.hostHome, "e-aaaaaaaaaaaaaaaa.sock") }];
    await writePrivateJson(receiptPath, stopped);
    await assert.rejects(startExecutionHost(f), /generation is still running/);
  } finally { orphan?.kill("SIGKILL"); await host?.close(); await f.clean(); }
});

test("execution control bounds queued frames and closes raw sockets during owned shutdown", { timeout: 15000 }, async () => {
  const f = await fixture(); let host; let client; let raw;
  try {
    host = await startExecutionHost(f); const path = join(f.hostHome, "host.sock");
    client = new WebSocket(`ws+unix://${path}:/`); client.on("error", () => {}); await once(client, "open");
    const closed = once(client, "close");
    client.send(JSON.stringify({ id: 1, method: "execution/acquire", params: f.descriptor() }));
    for (let id = 2; id <= 65; id++) client.send(JSON.stringify({ id, method: "execution/status", params: {} }));
    assert.equal((await closed)[0], 1013);
    raw = connect(path); await once(raw, "connect"); const rawClosed = once(raw, "close");
    await host.close(); host = undefined; await rawClosed;
  } finally { client?.terminate(); raw?.destroy(); await host?.close(); await f.clean(); }
});

test("execution control uses the SDK sandbox-hidden socket boundary and cleans its alias", { timeout: 10000 }, async () => {
  const f = await fixture(); let host;
  try {
    host = await startExecutionHost(f); const path = join(f.hostHome, "host.sock"); const target = await sdkSocketTarget(path);
    assert.ok((await lstat(path)).isSymbolicLink()); assert.equal(await readlink(path), target);
    const identity = (await socketIdentity(path))!; assert.equal(identity.targetPath, target); assert.ok(identity.targetInode);
    assert.equal((await lstat(dirname(target))).mode & 0o777, 0o700); assert.equal((await lstat(target)).mode & 0o777, 0o600);
    await host.close(); host = undefined;
    await assert.rejects(lstat(path), { code: "ENOENT" }); await assert.rejects(lstat(target), { code: "ENOENT" });
  } finally { await host?.close(); await f.clean(); }
});

test("execution control preserves an unrecorded occupied protected target", { timeout: 10000 }, async () => {
  const f = await fixture(); const server = createServer();
  try {
    await mkdir(f.hostHome, { recursive: true, mode: 0o700 }); const path = await sdkSocketTarget(join(f.hostHome, "host.sock"));
    await mkdir(dirname(path), { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    server.listen(path); await once(server, "listening"); await chmod(path, 0o600);
    const before = await socketIdentity(path);
    await assert.rejects(startExecutionHost(f), /occupied/);
    assert.deepEqual(await socketIdentity(path), before); assert.ok(server.listening);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.clean(); }
});

// A host that died between its listen and its link left the socket at its own hashed target, recorded nowhere. Nothing serves
// it, so it is removed and the next start succeeds instead of failing "occupied" until a reboot clears the folder.
test("execution control removes an orphan socket at its own target that nothing serves, and starts", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const f = await fixture(); let host; let orphan;
  try {
    await mkdir(f.hostHome, { recursive: true, mode: 0o700 }); const target = await sdkSocketTarget(join(f.hostHome, "host.sock"));
    await mkdir(dirname(target), { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    orphan = spawn(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1],()=>console.log('ready'))", target], { stdio: ["ignore", "pipe", "ignore"] });
    await once(orphan.stdout!, "data"); await chmod(target, 0o600);
    const exited = once(orphan, "close"); orphan.kill("SIGKILL"); await exited;
    assert.ok((await lstat(target)).isSocket(), "the orphan socket is left behind");
    host = await startExecutionHost(f);
    assert.equal(await readlink(join(f.hostHome, "host.sock")), target, "the host listens at its own target again");
    await host.close(); host = undefined;
  } finally { orphan?.kill("SIGKILL"); await host?.close(); await f.clean(); }
});

// A host killed after `listen` but before its chmod left the socket at the mode the process umask gave it. That orphan used to
// fail every later start as "occupied" until a reboot cleared the folder; whatever its mode, a socket of this user that
// refuses connects is reclaimed, and one that answers is never removed.
test("execution control reclaims a dead orphan socket at its own target whatever its mode, and starts", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  for (const mode of [0o755, 0o666]) {
    const f = await fixture(); let host; let orphan;
    try {
      await mkdir(f.hostHome, { recursive: true, mode: 0o700 }); const target = await sdkSocketTarget(join(f.hostHome, "host.sock"));
      await mkdir(dirname(target), { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      orphan = spawn(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1],()=>console.log('ready'))", target], { stdio: ["ignore", "pipe", "ignore"] });
      await once(orphan.stdout!, "data"); await chmod(target, mode);
      const exited = once(orphan, "close"); orphan.kill("SIGKILL"); await exited;
      assert.equal((await lstat(target)).mode & 0o777, mode, "the orphan is left open to others");
      host = await startExecutionHost(f);
      assert.equal(await readlink(join(f.hostHome, "host.sock")), target, `the host listens at its own target again (orphan mode ${mode.toString(8)})`);
      assert.equal((await lstat(target)).mode & 0o777, 0o600);
      await host.close(); host = undefined;
    } finally { orphan?.kill("SIGKILL"); await host?.close(); await f.clean(); }
  }
});

test("execution control never removes a live listener at its own target, whatever its mode", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  for (const mode of [0o755, 0o700, 0o666]) {
    const f = await fixture(); const server = createServer();
    try {
      await mkdir(f.hostHome, { recursive: true, mode: 0o700 }); const path = await sdkSocketTarget(join(f.hostHome, "host.sock"));
      await mkdir(dirname(path), { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      server.listen(path); await once(server, "listening"); await chmod(path, mode);
      const before = await lstat(path);
      await assert.rejects(startExecutionHost(f), /occupied/, `a live listener of mode ${mode.toString(8)} is refused`);
      const after = await lstat(path);
      assert.deepEqual([after.ino, after.dev, after.mode & 0o777], [before.ino, before.dev, mode]); assert.ok(server.listening);
      await new Promise<void>((resolve, reject) => { const client = connect(path); client.once("connect", () => { client.destroy(); resolve(); }); client.once("error", reject); });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.clean(); }
  }
});

// On macOS a live listener whose accept queue is full also answers ECONNREFUSED, so a single refusal must not unlink a socket.
test("execution control asks a refused socket twice: one that then answers is kept, one refused twice is removed", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  for (const [script, outcome] of [[["refused", "answered"], "kept"], [["refused", "refused"], "removed"]] as Array<[ProbeResult[], string]>) {
    const f = await fixture(); let host; let orphan; const asked: string[] = [];
    try {
      await mkdir(f.hostHome, { recursive: true, mode: 0o700 }); const target = await sdkSocketTarget(join(f.hostHome, "host.sock"));
      await mkdir(dirname(target), { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      orphan = spawn(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1],()=>console.log('ready'))", target], { stdio: ["ignore", "pipe", "ignore"] });
      await once(orphan.stdout!, "data"); await chmod(target, 0o600);
      const exited = once(orphan, "close"); orphan.kill("SIGKILL"); await exited;
      const before = await lstat(target); const answers = [...script];
      // Only the probes of the orphan's own path are scripted; every other path is asked for real.
      setSocketProbeForTests({ retryMs: 5, probe: async path => { if (path !== target || !answers.length) return connectOnce(path); asked.push(path); return answers.shift()!; } });
      if (outcome === "kept") {
        await assert.rejects(startExecutionHost(f), /occupied/);
        const after = await lstat(target); assert.deepEqual([after.ino, after.dev], [before.ino, before.dev], "the socket stayed");
      } else {
        host = await startExecutionHost(f); assert.equal(await readlink(join(f.hostHome, "host.sock")), target); await host.close(); host = undefined;
      }
      assert.equal(asked.length, 2, `the orphan was asked twice (${outcome})`);
    } finally { setSocketProbeForTests(); orphan?.kill("SIGKILL"); await host?.close(); await f.clean(); }
  }
});

test("a failed host start restores the process umask it narrowed for the listen", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture(); const server = createServer(); const before = process.umask(0o022);
  try {
    await mkdir(f.hostHome, { recursive: true, mode: 0o700 }); const path = await sdkSocketTarget(join(f.hostHome, "host.sock"));
    await mkdir(dirname(path), { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    server.listen(path); await once(server, "listening");
    await assert.rejects(startExecutionHost(f), /occupied/); assert.equal(process.umask(), 0o022);
    const host = await startExecutionHost({ ...f, configPath: join(f.directory, "other.json") }); assert.equal(process.umask(), 0o022); await host.close();
  } finally { process.umask(before); await new Promise<void>(resolve => server.close(() => resolve())); await f.clean(); }
});

test("idle restart preserves leased and loaded SDK writers and atomically quiesces new work", { timeout: 20000 }, async () => {
  const f = await fixture(); let host; let client; let engine;
  try {
    host = await startExecutionHost(f); client = await control(join(f.hostHome, "host.sock"));
    assert.equal(await host.prepareStop(), true);
    await assert.rejects(client.request("execution/acquire", f.descriptor()), /quiescing/);
    await assert.rejects(client.request("execution/find", { threadId: "anything" }), /quiescing/);
    assert.equal((await client.request<{ quiescing: boolean }>("execution/status")).quiescing, true);
    assert.deepEqual(await client.request("execution/release", { revision: "a".repeat(64) }), { released: false });
    host.resume();
    const record = await client.request<ExecutionRecord>("execution/acquire", f.descriptor());
    assert.equal(await host.prepareStop(), false);
    engine = new SocketAppServerConnection(record.socketPath, async () => {}); await engine.ready; await engine.request("initialize", {}); engine.send({ method: "initialized" });
    await engine.request("thread/start", { threadId: "tool-step-owner" });
    await client.request("execution/release", { revision: record.revision });
    // No inference HTTP request is needed for a loaded SDK/tool owner to block restart.
    assert.equal(await host.prepareStop(), false);
    await engine.request("thread/unsubscribe", { threadId: "tool-step-owner" });
    const prepared = host.prepareStop(); const arriving = client.request("execution/acquire", f.descriptor("b"));
    assert.equal(await prepared, true); await assert.rejects(arriving, /quiescing/);
    host.resume(); assert.equal((await client.request<ExecutionRecord>("execution/acquire", f.descriptor("b"))).revision, "b".repeat(64));
  } finally { engine?.stop(); client?.socket.terminate(); await host?.close(); await f.clean(); }
});
