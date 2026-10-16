import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { ServiceSupervisor } from "../service-supervisor.js";
import { serviceExecutionPaths, serviceStatusPath, validateServicePlan, type ServicePlan } from "../service-plan.js";
import { executionHostHome } from "../execution-host.js";
import { executionHostReady, enableSharedExecutors } from "../mac-shared-executors.js";
import { ExecutionHostClient } from "../execution-host-client.js";
import { writePrivateJson } from "../config.js";
import { archiveStoppedExecutionReceipt } from "../service-execution-recovery.js";
import { sdkIdentity } from "../execution-host-storage.js";
import { SocketAppServerConnection } from "../socket-app-server-connection.js";
import { setTimeout as delay } from "node:timers/promises";
import { externalLegacyWriters } from "../service-legacy-writers.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

const roots = isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-service-shared-")); const state = join(directory, "state"); const nativeHome = join(directory, "native");
  await mkdir(nativeHome, { mode: 0o700 }); await writeFile(join(nativeHome, "config.toml"), 'model="original"\n', { mode: 0o600 });
  const configPath = join(directory, "gateway.json"); await writePrivateJson(configPath, { version: 1, port: 3459, clientOnly: true, stateDirectory: state, providers: [] });
  const codex = join(directory, "codex");
  await writeFile(codex, `#!${process.execPath}\nimport {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {WebSocketServer} from ${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)};
if(process.argv.includes('--version')){console.log('codex-cli 0.162.0-alpha.17.2');process.exit(0);}
const args=process.argv.slice(2);const path=args[args.indexOf('--listen')+1].slice(7);const server=createServer();const sockets=new WebSocketServer({server});const loaded=new Set();
sockets.on('connection',client=>client.on('message',bytes=>{const m=JSON.parse(bytes);if(m.id==null)return;let result={};if(m.method==='thread/loaded/list')result={data:[...loaded],nextCursor:null};if(m.method==='thread/start'){loaded.add(m.params.threadId);result={thread:{id:m.params.threadId}};}if(m.method==='thread/unsubscribe')loaded.delete(m.params.threadId);client.send(JSON.stringify({id:m.id,result}));}));
server.listen(path,()=>writeFileSync(args[args.indexOf('--fixture-state')+1],String(process.pid)));
process.on('SIGTERM',()=>{for(const c of sockets.clients)c.terminate();server.close(()=>process.exit(0));});
`, { mode: 0o700 });
  const plan: ServicePlan = { version: 1, config: configPath, sharedExecutors: true, components: [{ id: "native", kind: "native", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)", "--", "--codex", codex, "--native-home", nativeHome], log: join(state, "native.log") }] };
  const home = executionHostHome(configPath, nativeHome);
  return { directory, state, configPath, nativeHome, codex, plan, home, cleanup: async () => { await rm(directory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); } };
}
const live = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("shared service plans stay opt-in and derive the existing SDK/home without storing credentials", () => {
  const base: ServicePlan = { version: 1, config: "/private/gateway.json", components: [{ id: "native", kind: "native", command: "/private/relay", args: ["--codex", "/signed/codex", "--native-home", "/private/native"], log: "/private/log" }] };
  assert.equal(validateServicePlan(base).sharedExecutors, undefined);
  assert.equal(validateServicePlan({ ...base, sharedExecutors: false }).sharedExecutors, false);
  assert.deepEqual(serviceExecutionPaths(validateServicePlan({ ...base, sharedExecutors: true })), { codex: "/signed/codex", nativeHome: "/private/native" });
  assert.throws(() => validateServicePlan({ ...base, sharedExecutors: "yes" }), /boolean/);
  assert.throws(() => validateServicePlan({ ...base, sharedExecutors: true, components: [{ ...base.components[0], args: ["--codex", "/signed/codex", "--codex", "/other/codex", "--native-home", "/private/native"] }] }), /one absolute/);
  assert.throws(() => validateServicePlan({ ...base, sharedExecutors: true, components: [{ ...base.components[0], kind: "inference" }] }), /register it/);
  const desktop = { ...base, components: [{ ...base.components[0], kind: "desktop" as const, args: ["--app", "/Applications/ChatGPT.app"] }] };
  assert.equal(serviceExecutionPaths(desktop).codex, "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
});

test("legacy writer inventory excludes managed descendants and unrelated native SDK processes", () => {
  const config = "/private/Gateway State/gateway.json"; const state = "/private/Gateway State/state";
  const snapshot = [
    "10 1 /private/gateway daemon --config " + config,
    "11 10 /private/relay --daemon",
    "12 11 /private/gateway codex-shim --config " + config + " -- app-server",
    "13 12 /signed/codex app-server -c model_catalog_json=\"" + state + "/old.json\"",
    "20 1 /private/gateway codex-shim --ssh --config " + config + " -- app-server --listen unix:///private/ssh.sock",
    "21 20 /signed/codex app-server -c model_catalog_json=\"" + state + "/old.json\"",
    "30 1 /signed/codex app-server -c model_catalog_json=\"/unrelated/native-cache.json\" -c PRIVATE_FIXTURE_SECRET=never-return-this",
  ].join("\n");
  assert.deepEqual(externalLegacyWriters(snapshot, config, state, 10), [{ pid: 20, kind: "adapter" }, { pid: 21, kind: "executor" }]);
  assert.ok(!JSON.stringify(externalLegacyWriters(snapshot, config, state, 10)).includes("never-return-this"));
});

test("unified service owns shared SDK writers and stops them with its other children", { timeout: 15000 }, async () => {
  const f = await setup(); const supervisor = new ServiceSupervisor(f.plan, f.state); let client;
  try {
    await supervisor.start();
    const status = JSON.parse(await readFile(serviceStatusPath(f.state), "utf8")); assert.equal(status.executionHost.state, "running"); assert.equal(status.executionHost.pid, process.pid);
    assert.equal(await executionHostReady(f.plan, process.pid), true);
    client = await ExecutionHostClient.discover(f.configPath, f.nativeHome, f.codex); assert.ok(client);
    await client.acquire({ revision: "a".repeat(64), args: ["app-server", "--listen", "stdio://", "--fixture-state", join(f.directory, "engine.pid")], settings: {}, catalog: { models: [{ slug: "fixture" }] }, aliases: ["fixture"] });
    const sdkPid = Number(await readFile(join(f.directory, "engine.pid"), "utf8")); assert.ok(live(sdkPid));
    await supervisor.stop(); assert.ok(!live(sdkPid));
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model="original"\n');
    const stopped = JSON.parse(await readFile(serviceStatusPath(f.state), "utf8")); assert.equal(stopped.executionHost.state, "stopped"); assert.ok(stopped.components.every((component: { state: string }) => component.state === "stopped"));
    assert.equal(JSON.parse(await readFile(join(f.home, "owner.json"), "utf8")).state, "stopped"); assert.equal(await executionHostReady(f.plan, process.pid), false);
  } finally { client?.close(); await supervisor.stop(); await f.cleanup(); }
});

test("legacy service plans never start an execution host implicitly", { timeout: 10000 }, async () => {
  const f = await setup(); const { sharedExecutors: _unused, ...legacy } = f.plan; const supervisor = new ServiceSupervisor(legacy, f.state);
  try {
    await supervisor.start();
    assert.equal(JSON.parse(await readFile(serviceStatusPath(f.state), "utf8")).executionHost, undefined);
    await assert.rejects(readFile(join(f.home, "owner.json")), { code: "ENOENT" });
  } finally { await supervisor.stop(); await f.cleanup(); }
});

test("an incompatible shared SDK marks the host failed but keeps the service's other children running", { timeout: 10000 }, async () => {
  const f = await setup(); const supervisor = new ServiceSupervisor(f.plan, f.state);
  try {
    await writeFile(f.codex, `#!${process.execPath}\nconsole.log('codex-cli unsupported');\n`, { mode: 0o700 });
    await supervisor.start();
    const status = JSON.parse(await readFile(serviceStatusPath(f.state), "utf8")); assert.equal(status.executionHost.state, "failed"); assert.ok(status.components[0].pid > 0);
    await readFile(join(f.state, "native.log"));
    await assert.rejects(readFile(join(f.home, "owner.json")), { code: "ENOENT" }, "no ownership is claimed for an unverified SDK");
    await supervisor.stop();
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model="original"\n');
  } finally { await supervisor.stop().catch(() => {}); await f.cleanup(); }
});

test("shared migration preview preserves the existing plan and foreground CLI requires explicit isolation", { skip: process.platform !== "darwin", timeout: 15000 }, async () => {
  const f = await setup();
  try {
    const { sharedExecutors: _unused, ...legacy } = f.plan; await writePrivateJson(join(f.state, "service-plan.json"), legacy);
    const before = await readFile(join(f.state, "service-plan.json"), "utf8");
    const preview = await enableSharedExecutors(f.configPath); assert.equal(preview.applied, false); assert.equal(preview.alreadyEnabled, false);
    assert.equal(await readFile(join(f.state, "service-plan.json"), "utf8"), before); await assert.rejects(readFile(join(f.home, "owner.json")), { code: "ENOENT" });
    await assert.rejects(promisify(execFile)(process.execPath, [resolve("dist/cli.js"), "executor-host", "--config", f.configPath]), /explicit --codex/);
    // The host runs in a child process of its own, which gets this file's roots too, never the real SDK folder or host homes.
    const isolated = roots.child();
    const child = spawn(process.execPath, [...isolated.args, resolve("dist/cli.js"), "executor-host", "--config", f.configPath, "--codex", f.codex, "--native-home", f.nativeHome], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...isolated.env } });
    try {
      const chunk = await once(child.stdout!, "data"); const receipt = JSON.parse(String(chunk[0])); assert.equal(receipt.pid, child.pid);
      assert.equal(await executionHostReady(f.plan, child.pid!), true);
      const exited = once(child, "close"); child.kill("SIGTERM"); await exited;
      assert.equal(JSON.parse(await readFile(join(f.home, "owner.json"), "utf8")).state, "stopped");
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  } finally { await f.cleanup(); }
});

test("rollback archives only a fully stopped owned receipt and restores legacy discovery", { timeout: 15000 }, async () => {
  const f = await setup(); const supervisor = new ServiceSupervisor(f.plan, f.state); let client;
  try {
    const identity = { configPath: f.configPath, nativeHome: f.nativeHome, ...await sdkIdentity(f.codex) }; const backup = join(f.directory, "rollback");
    await supervisor.start();
    await assert.rejects(archiveStoppedExecutionReceipt(identity, backup), /fully stopped/);
    client = await ExecutionHostClient.discover(f.configPath, f.nativeHome, f.codex); assert.ok(client);
    await client.acquire({ revision: "a".repeat(64), args: ["app-server", "--fixture-state", join(f.directory, "sdk.pid")], settings: {}, catalog: { models: [{ slug: "fixture" }] }, aliases: ["fixture"] });
    client.close(); await supervisor.stop();
    await assert.rejects(ExecutionHostClient.discover(f.configPath, f.nativeHome, f.codex), /unavailable/);
    const archive = await archiveStoppedExecutionReceipt(identity, backup); assert.equal(archive, join(backup, "execution-owner.json"));
    assert.equal(JSON.parse(await readFile(archive!, "utf8")).state, "stopped");
    assert.equal(await ExecutionHostClient.discover(f.configPath, f.nativeHome, f.codex), undefined);
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model="original"\n');
  } finally { client?.close(); await supervisor.stop(); await f.cleanup(); }
});

test("rollback keeps a live writer or unrelated stopped identity fail closed", { timeout: 15000 }, async () => {
  const f = await setup(); const supervisor = new ServiceSupervisor(f.plan, f.state);
  try {
    await supervisor.start(); await supervisor.stop(); const path = join(f.home, "owner.json"); const original = JSON.parse(await readFile(path, "utf8"));
    const identity = { configPath: f.configPath, nativeHome: f.nativeHome, ...await sdkIdentity(f.codex) }; const backup = join(f.directory, "rollback");
    await writePrivateJson(path, { ...original, generations: [{ revision: "a".repeat(64), pid: process.pid, socketPath: join(f.home, "e-aaaaaaaaaaaaaaaa.sock") }] });
    await assert.rejects(archiveStoppedExecutionReceipt(identity, backup), /writer is still live/); assert.ok(await readFile(path));
    await writePrivateJson(path, { ...original, nativeHome: join(f.directory, "unrelated") });
    await assert.rejects(archiveStoppedExecutionReceipt(identity, backup), /does not match/); assert.ok(await readFile(path));
  } finally { await supervisor.stop(); await f.cleanup(); }
});

test("shared idle restart preserves leases and loaded SDK work outside HTTP inference", { timeout: 15000 }, async () => {
  const f = await setup(); const supervisor = new ServiceSupervisor(f.plan, f.state); let control; let sdk;
  try {
    await supervisor.start();
    control = new SocketAppServerConnection(join(f.home, "host.sock"), async () => {}); await control.ready;
    const record = await control.request("execution/acquire", { revision: "a".repeat(64), args: ["app-server", "--fixture-state", join(f.directory, "sdk.pid")], settings: {}, catalog: { models: [{ slug: "fixture" }] }, aliases: ["fixture"] });
    assert.equal(await supervisor.restartWhenIdle(), false, "connected adapter lease refuses restart");
    sdk = new SocketAppServerConnection(String(record.socketPath), async () => {}); await sdk.ready; await sdk.request("initialize", {}); sdk.send({ method: "initialized" });
    await sdk.request("thread/start", { threadId: "tool-step-with-no-http-request" });
    control.stop(); await control.exited; await delay(20);
    assert.equal(await supervisor.restartWhenIdle(), false, "loaded SDK work refuses restart without HTTP inference");
    assert.ok(live(Number(await readFile(join(f.directory, "sdk.pid"), "utf8"))));
    await sdk.request("thread/unsubscribe", { threadId: "tool-step-with-no-http-request" }); sdk.stop(); await sdk.exited;
    assert.equal(await supervisor.restartWhenIdle(), true);
  } finally { control?.stop(); sdk?.stop(); await supervisor.stop(); await f.cleanup(); }
});
