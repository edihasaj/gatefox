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
import { startExecutionHost, executionHostHome, type ExecutionDescriptor, type ExecutionRecord } from "../execution-host.js";
import { SocketAppServerConnection } from "../socket-app-server-connection.js";
import { executionArgs, executionDescriptor } from "../execution-host-engine.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { sdkSocketTarget, socketIdentity } from "../execution-host-storage.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-execution-")); const configPath = join(directory, "gateway.json");
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  await writeFile(join(nativeHome, "config.toml"), 'model = "native-original"\n', { mode: 0o600 });
  await writeFile(join(nativeHome, "auth.json"), '{"fixture":"must-not-be-copied"}', { mode: 0o600 });
  const sdk = join(directory, "codex");
  await writeFile(sdk, `#!${process.execPath}\nimport {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {WebSocketServer} from ${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)};
if(process.argv.includes('--version')) { console.log('codex-cli 0.162.0-alpha.17.2'); process.exit(0); }
const args=process.argv.slice(2);const socket=args[args.indexOf('--listen')+1].slice(7);
const server=createServer();const ws=new WebSocketServer({server});const loaded=new Set();
ws.on('connection',client=>client.on('message',bytes=>{const m=JSON.parse(bytes);if(m.id==null)return;let result={};
if(m.method==='thread/loaded/list')result={data:[...loaded],nextCursor:null};
if(m.method==='thread/start'||m.method==='thread/resume'){const id=m.params.threadId||'fixture-thread';loaded.add(id);result={thread:{id}};}
if(m.method==='thread/unsubscribe')loaded.delete(m.params.threadId);
client.send(JSON.stringify({id:m.id,result}));}));
server.listen(socket,()=>writeFileSync(args[args.indexOf('--fixture-state')+1],JSON.stringify({pid:process.pid,socket,home:process.env.CODEX_HOME,args})));
process.on('SIGTERM',()=>{for(const c of ws.clients)c.terminate();server.close(()=>process.exit(0));});
`, { mode: 0o700 });
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: join(directory, "state"), providers: [], clientOnly: true };
  const hostHome = executionHostHome(configPath, nativeHome);
  const descriptor = (digit = "a"): ExecutionDescriptor => ({ revision: digit.repeat(64), args: ["app-server", "--listen", "stdio://", "--fixture-state", join(directory, `engine-${digit}.json`)], settings: { model: "fixture", agents: { max_concurrent_threads_per_session: 30 } }, catalog: { models: [{ slug: "fixture" }] }, aliases: ["fixture"] });
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

test("execution generations preserve loaded/leased owners and retire only unowned empty engines", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client; let engineClient;
  try {
    host = await startExecutionHost(f); client = await control(join(f.hostHome, "host.sock"));
    const first = await client.request<ExecutionRecord>("execution/acquire", f.descriptor("a"));
    engineClient = new SocketAppServerConnection(first.socketPath, async () => {}); await engineClient.ready;
    await engineClient.request("initialize", {}); engineClient.send({ method: "initialized" });
    await engineClient.request("thread/start", { threadId: "loaded-without-a-client-lease" });
    engineClient.stop(); await engineClient.exited;
    for (const digit of ["b", "c", "d"]) await client.request("execution/acquire", f.descriptor(digit));
    await assert.rejects(client.request("execution/acquire", f.descriptor("e")), /Four gateway generations/);
    await client.request("execution/release", { revision: "a".repeat(64) });
    await assert.rejects(client.request("execution/acquire", f.descriptor("e")), /Four gateway generations/);
    await client.request("execution/release", { revision: "b".repeat(64) });
    const e = await client.request<ExecutionRecord>("execution/acquire", f.descriptor("e")); assert.equal(e.revision, "e".repeat(64));
    const state = await client.request<{ generations: ExecutionRecord[] }>("execution/status"); assert.equal(state.generations.length, 4); assert.ok(state.generations.some(g => g.revision === "a".repeat(64))); assert.ok(!state.generations.some(g => g.revision === "b".repeat(64)));
  } finally { engineClient?.stop(); client?.socket.terminate(); await host?.close(); await f.clean(); }
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
