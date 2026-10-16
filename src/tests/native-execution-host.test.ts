import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startExecutionHost, executionHostHome } from "../execution-host.js";
import { sdkIdentity, readOwner, livePid } from "../execution-host-storage.js";
import { nativeHomeOwnerPath, readNativeHomeOwner } from "../native-execution-host-storage.js";
import type { NativeExecutionRecord } from "../native-execution-host-engine.js";
import { SocketAppServerConnection } from "../socket-app-server-connection.js";
import type { Message } from "../app-server-connection.js";
import type { GatewayConfig } from "../config.js";
import { verifyNativeSdk } from "../native-execution-host-sdk.js";
import { writePrivateJson } from "../config.js";
import { hostRunsInThisProcess } from "./in-process-host.js";

hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let index = 0; index < 200; index++) { if (await check()) return; await delay(10); }
  assert.fail("Native ownership fixture condition did not arrive");
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gw-native-owner-")); const nativeHome = join(root, "native"); await mkdir(nativeHome, { mode: 0o700 });
  const original = { config: 'model = "native-original"\n', auth: '{"fixture":"native-only-auth-source"}' };
  await writeFile(join(nativeHome, "config.toml"), original.config, { mode: 0o600 }); await writeFile(join(nativeHome, "auth.json"), original.auth, { mode: 0o600 });
  const codex = join(root, "codex");
  await writeFile(codex, `#!${process.execPath}
import {createServer} from 'node:http';import {existsSync} from 'node:fs';
import {WebSocketServer} from ${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)};
if(process.argv.includes('--version')){console.log('codex-cli 0.162.0-alpha.17.2');process.exit(0);}
const args=process.argv.slice(2),socket=args[args.indexOf('--listen')+1].slice(7),loaded=new Map(),names=[];
const server=createServer(),ws=new WebSocketServer({server});
ws.on('connection',c=>c.on('message',bytes=>{const m=JSON.parse(bytes);if(m.id==null)return;let result={};
if(m.method==='initialize')names.push(m.params.clientInfo?.name);
if(m.method==='fixture/info')result={pid:process.pid,cwd:process.cwd(),home:process.env.CODEX_HOME,args,remoteTransportDisabled:process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED==='1',authPresent:existsSync(process.env.CODEX_HOME+'/auth.json'),clients:ws.clients.size,names};
if(m.method==='thread/loaded/list')result={data:[...loaded.keys()],nextCursor:null};
if(m.method==='thread/start'||m.method==='thread/resume'){const id=m.params.threadId||'native-thread';loaded.set(id,loaded.get(id)||{id,modelProvider:'openai',model:'native-original',status:{type:'idle'}});result={thread:loaded.get(id)};}
if(m.method==='fixture/active'){loaded.get(m.params.threadId).status={type:'active',activeFlags:[]};result={};}
if(m.method==='thread/read')result={thread:loaded.get(m.params.threadId)};
if(m.method==='thread/unsubscribe')loaded.delete(m.params.threadId);
c.send(JSON.stringify({id:m.id,result}));}));
server.listen(socket);process.on('SIGTERM',()=>{for(const c of ws.clients)c.terminate();server.close(()=>process.exit(0));});
`, { mode: 0o700 });
  const configPath = join(root, "gateway.json"); const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: join(root, "state"), clientOnly: true, providers: [] };
  const nativeSdkVerifier = async (path: string) => { const identity = await sdkIdentity(path); return { nativeSdkExecutable: identity.codex, nativeSdkSha256: identity.sdkSha256 }; };
  const options = { config, configPath, nativeHome, codex, capabilities: ["native"] as ["native"], nativeSdkVerifier };
  const home = executionHostHome(configPath, nativeHome); const args = ["app-server", "--listen", "stdio://", "-c", 'model="native-original"']; const cwd = dirname(nativeHome);
  const connection = async (socket: string) => { const result = new SocketAppServerConnection(socket, async () => {}); await result.ready; return result; };
  const initialize = async (socket: string, name: string) => { const client = await connection(socket); await client.request("initialize", { clientInfo: { name, version: "1" } }); client.send({ method: "initialized", params: {} }); return client; };
  const unchanged = async () => { assert.equal(await readFile(join(nativeHome, "config.toml"), "utf8"), original.config); assert.equal(await readFile(join(nativeHome, "auth.json"), "utf8"), original.auth); };
  return { root, options, home, args, cwd, config, configPath, nativeHome, codex, connection, initialize, unchanged,
    async clean() { await unchanged(); await rm(dirname(nativeHomeOwnerPath(nativeHome)), { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); } };
}

test("native capability is separate, original native home is shared once, and admin probes never persist", { timeout: 15000 }, async () => {
  const f = await fixture(); const host = await startExecutionHost(f.options); const control = await f.connection(join(f.home, "host.sock")); let first; let second;
  try {
    assert.deepEqual((await control.request("execution/status", {})).capabilities, ["native"]);
    await assert.rejects(control.request("execution/acquire", {}), /does not offer gateway/);
    const record = await control.request("native/acquire", { args: f.args, cwd: f.cwd }) as unknown as NativeExecutionRecord;
    const repeated = await control.request("native/acquire", { args: ["app-server", "--listen=unix:///old.sock", "-c", 'model="native-original"'], cwd: f.cwd });
    assert.deepEqual(repeated, record); assert.ok(record.pid > 0);
    first = await f.initialize(record.socketPath, "native-client-one"); second = await f.initialize(record.socketPath, "native-client-two");
    const info = await first.request("fixture/info", {});
    assert.equal(info.home, f.nativeHome); assert.equal(info.cwd, await realpath(f.cwd)); assert.equal(info.authPresent, true); assert.equal(info.clients, 2);
    assert.deepEqual(info.names, ["codex_app_server_daemon", "native-client-one", "native-client-two"]);
    const owner = await readOwner(join(f.home, "owner.json")); assert.equal(owner?.native?.pid, record.pid); assert.deepEqual(owner?.generations, []);
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.pid, record.pid);
    await first.request("thread/start", { threadId: "shared-native-chat" }); await first.request("fixture/active", { threadId: "shared-native-chat" });
    assert.equal(((await second.request("thread/read", { threadId: "shared-native-chat" })).thread as Message).modelProvider, "openai");
    assert.deepEqual(((await second.request("thread/read", { threadId: "shared-native-chat" })).thread as Message).status, { type: "active", activeFlags: [] });
    first.stop(); await first.exited; first = undefined;
    assert.equal(livePid(record.pid), true); assert.deepEqual(((await second.request("thread/read", { threadId: "shared-native-chat" })).thread as Message).status, { type: "active", activeFlags: [] });
    await assert.rejects(control.request("native/acquire", { args: [...f.args, "--profile", "different"], cwd: f.cwd }), /startup settings differ/);
    await assert.rejects(control.request("native/acquire", { args: f.args, cwd: f.nativeHome }), /startup settings differ/);
  } finally { first?.stop(); second?.stop(); control.stop(); await host.close(); await f.clean(); }
});

for (const firstClient of ["desktop", "relay"] as const) {
  test(`${firstClient}-first native ownership accepts the other client's analytics default while preserving the original launch`, { timeout: 15000 }, async () => {
    const f = await fixture(); const host = await startExecutionHost(f.options); const control = await f.connection(join(f.home, "host.sock")); let client;
    try {
      const relayArgs = [...f.args, "-c", "analytics.enabled=false"];
      const desktopArgs = [...relayArgs, "--analytics-default-enabled"];
      const firstArgs = firstClient === "desktop" ? desktopArgs : relayArgs;
      const nextArgs = firstClient === "desktop" ? relayArgs : desktopArgs;
      const record = await control.request("native/acquire", { args: firstArgs, cwd: f.cwd }) as unknown as NativeExecutionRecord;
      assert.deepEqual(await control.request("native/acquire", { args: nextArgs, cwd: f.cwd }), record);
      client = await f.initialize(record.socketPath, "frontend"); const info = await client.request("fixture/info", {});
      assert.equal((info.args as string[]).includes("--analytics-default-enabled"), firstClient === "desktop");
      assert.ok((info.args as string[]).includes("analytics.enabled=false"));
      await assert.rejects(control.request("native/acquire", { args: [...nextArgs, "-c", "analytics.enabled=true"], cwd: f.cwd }), /startup settings differ/);
      await assert.rejects(control.request("native/acquire", { args: [...nextArgs, "--profile", "other"], cwd: f.cwd }), /startup settings differ/);
      assert.equal((await control.request("native/acquire", { args: firstArgs, cwd: f.cwd })).pid, record.pid);
    } finally { client?.stop(); control.stop(); await host.close(); await f.clean(); }
  });
}

test("native leases and loaded chats prevent quiescence; transient inspection does not pin an idle owner", { timeout: 15000 }, async () => {
  const f = await fixture(); const host = await startExecutionHost(f.options); const control = await f.connection(join(f.home, "host.sock")); let client;
  try {
    const record = await control.request("native/acquire", { args: f.args, cwd: f.cwd }) as unknown as NativeExecutionRecord;
    assert.equal(await host.prepareStop(), false);
    client = await f.initialize(record.socketPath, "frontend"); await client.request("thread/start", { threadId: "loaded" });
    await control.request("native/release", { revision: record.revision }); assert.equal(await host.prepareStop(), false);
    // Local WS close can precede the SDK peer's close bookkeeping. Prove that
    // the transient inspection leaves only the actual frontend connected.
    await until(async () => (await client!.request("fixture/info", {})).clients === 1);
    assert.equal((await client.request("fixture/info", {})).clients, 1);
    await client.request("thread/unsubscribe", { threadId: "loaded" }); assert.equal(await host.prepareStop(), true);
    await assert.rejects(control.request("native/acquire", { args: f.args, cwd: f.cwd }), /quiescing/); host.resume();
    assert.equal((await control.request("native/acquire", { args: f.args, cwd: f.cwd })).pid, record.pid);
  } finally { client?.stop(); control.stop(); await host.close(); await f.clean(); }
});

test("managed relay disables only its native process transport; native defaults and unrelated startup args remain intact", { timeout: 15000 }, async () => {
  const f = await fixture(); const host = await startExecutionHost({ ...f.options, nativeRelayOwnsRegistration: true }); const control = await f.connection(join(f.home, "host.sock")); let client;
  try {
    const record = await control.request("native/acquire", { args: f.args, cwd: f.cwd }) as unknown as NativeExecutionRecord;
    client = await f.initialize(record.socketPath, "frontend"); const info = await client.request("fixture/info", {});
    assert.equal(info.remoteTransportDisabled, true); assert.equal((info.args as string[]).includes("--disable"), false);
    assert.ok((info.args as string[]).includes('model="native-original"'));
  } finally { client?.stop(); control.stop(); await host.close(); await f.clean(); }
});

test("a second host/config cannot claim the same original native home while its owner lives", { timeout: 15000 }, async () => {
  const f = await fixture(); const host = await startExecutionHost(f.options); const otherConfig = join(f.root, "other.json"); const otherHome = executionHostHome(otherConfig, f.nativeHome);
  try {
    await assert.rejects(startExecutionHost({ ...f.options, configPath: otherConfig }), /already owns this native home/);
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.hostPid, process.pid);
    assert.equal((await readOwner(join(otherHome, "owner.json")))?.state, "stopped");
  } finally { await host.close(); await rm(otherHome, { recursive: true, force: true }); await f.clean(); }
});

test("an alias of the same native home cannot create another managed native owner", { timeout: 15000 }, async () => {
  const f = await fixture(); const host = await startExecutionHost(f.options); const alias = join(f.root, "native-alias");
  const otherConfig = join(f.root, "alias.json"); const otherHome = executionHostHome(otherConfig, alias);
  try {
    await symlink(f.nativeHome, alias, "dir"); assert.equal(nativeHomeOwnerPath(alias), nativeHomeOwnerPath(f.nativeHome));
    await assert.rejects(startExecutionHost({ ...f.options, configPath: otherConfig, nativeHome: alias }), /already owns this native home/);
  } finally { await host.close(); await rm(otherHome, { recursive: true, force: true }); await f.clean(); }
});

test("an interrupted launch intent never proves an unrecorded SDK child was not started", { timeout: 15000 }, async () => {
  const f = await fixture(); const host = await startExecutionHost(f.options); await host.close();
  try {
    const receipt = (await readNativeHomeOwner(f.nativeHome))!;
    await writePrivateJson(nativeHomeOwnerPath(f.nativeHome), { ...receipt, hostPid: 0, pid: 0, state: "running", sdkState: "starting", revision: "a".repeat(64) });
    await assert.rejects(startExecutionHost(f.options), /launch is unconfirmed/);
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.sdkState, "starting");
  } finally { await f.clean(); }
});

test("an effective SDK binary changed after host verification is refused before native spawn", { timeout: 15000 }, async () => {
  const f = await fixture(); const effective = join(f.root, "effective-sdk"); await writeFile(effective, await readFile(f.codex), { mode: 0o700 });
  const nativeSdkVerifier = async () => { const identity = await sdkIdentity(effective); return { nativeSdkExecutable: effective, nativeSdkSha256: identity.sdkSha256 }; };
  const host = await startExecutionHost({ ...f.options, nativeSdkVerifier }); const control = await f.connection(join(f.home, "host.sock"));
  try {
    await writeFile(effective, (await readFile(effective, "utf8")) + "\n// changed after verification\n", { mode: 0o700 });
    await assert.rejects(control.request("native/acquire", { args: f.args, cwd: f.cwd }), /managed chat ownership was preserved/);
    assert.equal(((await control.request("execution/status", {})).native as Message).pid, 0);
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.pid, 0);
  } finally { control.stop(); await host.close(); await f.clean(); }
});

test("default native verification rejects an unsigned script with a spoofed pinned version", async () => {
  const f = await fixture();
  try { await assert.rejects(startExecutionHost({ ...f.options, nativeSdkVerifier: undefined }), /original signed Codex SDK/); await assert.rejects(verifyNativeSdk(f.codex), /original signed Codex SDK/); }
  finally { await f.clean(); }
});

test("confirmed native SDK death is recorded without treating a client disconnect as process death", { timeout: 15000 }, async () => {
  const f = await fixture(); const host = await startExecutionHost(f.options); const control = await f.connection(join(f.home, "host.sock")); let client;
  try {
    const record = await control.request("native/acquire", { args: f.args, cwd: f.cwd }) as unknown as NativeExecutionRecord;
    client = await f.initialize(record.socketPath, "frontend"); client.stop(); await client.exited;
    assert.equal(livePid(record.pid), true);
    process.kill(record.pid, "SIGTERM");
    await until(async () => ((await control.request("execution/status", {})).native as Message).state === "exited");
    assert.equal(((await control.request("execution/status", {})).native as Message).pid, 0);
    await until(async () => (await readNativeHomeOwner(f.nativeHome))?.sdkState === "exited");
    const recovered = await control.request("native/acquire", { args: f.args, cwd: f.cwd }) as unknown as NativeExecutionRecord;
    assert.notEqual(recovered.pid, record.pid); assert.notEqual(recovered.instanceId, record.instanceId); assert.equal(recovered.revision, record.revision);
    assert.equal(livePid(record.pid), false); assert.equal(livePid(recovered.pid), true);
    assert.equal((await control.request("native/death", { pid: record.pid, revision: record.revision, instanceId: record.instanceId })).confirmed, true);
    assert.equal((await control.request("native/death", { pid: recovered.pid, revision: recovered.revision, instanceId: recovered.instanceId })).confirmed, false);
  } finally { client?.stop(); control.stop(); await host.close(); await f.clean(); }
});

test("a relay-started writer yields to the desktop's added settings only when its chats are idle", { timeout: 15000 }, async () => {
  const f = await fixture(); const host = await startExecutionHost(f.options); const control = await f.connection(join(f.home, "host.sock")); let client;
  // Mirrors the installed desktop: Code Mode plus bundled plugin MCP toggles the relay does not pass.
  const desktopArgs = [...f.args, "-c", "features.code_mode_host=true", "-c", "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true",
    "-c", "plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true", "--analytics-default-enabled"];
  const sshArgs = [...f.args, "-c", "features.code_mode_host=true"];
  try {
    const relay = await control.request("native/acquire", { args: f.args, cwd: f.cwd }) as unknown as NativeExecutionRecord;
    client = await f.initialize(relay.socketPath, "relay-frontend");
    await client.request("thread/start", { threadId: "remote-chat" }); await client.request("fixture/active", { threadId: "remote-chat" });
    await assert.rejects(control.request("native/acquire", { args: desktopArgs, cwd: f.cwd }), /while a chat is running/);
    assert.equal(livePid(relay.pid), true);
    await client.request("thread/unsubscribe", { threadId: "remote-chat" }); client.stop(); await client.exited; client = undefined;
    const desktop = await control.request("native/acquire", { args: desktopArgs, cwd: f.cwd }) as unknown as NativeExecutionRecord;
    assert.notEqual(desktop.pid, relay.pid); assert.equal(livePid(relay.pid), false);
    assert.equal((await control.request("native/death", { pid: relay.pid, revision: relay.revision, instanceId: relay.instanceId })).intentional, true);
    for (const args of [f.args, sshArgs, desktopArgs]) assert.equal((await control.request("native/acquire", { args, cwd: f.cwd })).pid, desktop.pid);
    client = await f.initialize(desktop.socketPath, "desktop"); assert.ok(((await client.request("fixture/info", {})).args as string[]).includes("features.code_mode_host=true"));
    client.stop(); await client.exited; client = undefined;
    // A relay that restarts the writer reuses the desktop launch, so the desktop attaches without a replacement.
    process.kill(desktop.pid, "SIGTERM");
    await until(async () => ((await control.request("execution/status", {})).native as Message).state === "exited");
    const relaunched = await control.request("native/acquire", { args: f.args, cwd: f.cwd }) as unknown as NativeExecutionRecord;
    assert.equal((await control.request("native/acquire", { args: desktopArgs, cwd: f.cwd })).pid, relaunched.pid);
  } finally { client?.stop(); control.stop(); await host.close(); await f.clean(); }
});

test("native launches never replace a writer for changed values, profiles, or another directory", { timeout: 15000 }, async () => {
  const f = await fixture(); const host = await startExecutionHost(f.options); const control = await f.connection(join(f.home, "host.sock"));
  try {
    const record = await control.request("native/acquire", { args: [...f.args, "-c", "features.code_mode_host=true"], cwd: f.cwd }) as unknown as NativeExecutionRecord;
    for (const args of [[...f.args, "-c", "features.code_mode_host=false"], [...f.args, "-c", 'model="other"'], [...f.args, "-c", "features.code_mode_host=true", "--profile", "work"],
      ["app-server", "-c", 'model="native-original"', "-c", "model_providers.subscription_gateway.base_url=\"http://127.0.0.1:1/v1\""]]) {
      await assert.rejects(control.request("native/acquire", { args, cwd: f.cwd }), /startup settings differ; existing ownership/);
    }
    await assert.rejects(control.request("native/acquire", { args: f.args, cwd: f.nativeHome }), /startup settings differ/);
    assert.equal(livePid(record.pid), true);
  } finally { control.stop(); await host.close(); await f.clean(); }
});
