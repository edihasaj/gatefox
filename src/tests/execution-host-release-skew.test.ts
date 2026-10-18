import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { startExecutionHost, executionHostHome, type ExecutionDescriptor, type ExecutionRecord } from "../execution-host.js";
import { releaseSkewMessage } from "../execution-host-engine.js";
import { sdkIdentity } from "../execution-host-storage.js";
import { gatewaySdkCapability, gatewaySdkPatchSha256, gatewaySdkRevision, type GatewaySdkRuntime } from "../gateway-sdk-runtime.js";
import { pendingGatewaySdkReader } from "../self-update.js";
import { nativeHomeOwnerPath } from "../native-execution-host-storage.js";
import type { GatewayConfig } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.

const pinned = "codex-cli 0.162.0-alpha.17.2";
const otherSha = "b".repeat(64); const thirdSha = "c".repeat(64);
/** A host on the fixture SDK (the "installed" release's runtime) and descriptors an adapter of this or another release would send. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gw-skew-")); const configPath = join(directory, "gateway.json");
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  const runtimeExecutable = join(directory, "gateway-codex");
  await writeFile(runtimeExecutable, `#!${process.execPath}\nimport {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {WebSocketServer} from ${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)};
if(process.argv.includes('--version')) { console.log(${JSON.stringify(pinned)}); process.exit(0); }
const args=process.argv.slice(2);const socket=args[args.indexOf('--listen')+1].slice(7);
const server=createServer();const ws=new WebSocketServer({server});
ws.on('connection',client=>client.on('message',bytes=>{const m=JSON.parse(bytes);if(m.id==null)return;
client.send(JSON.stringify({id:m.id,result:m.method==='thread/loaded/list'?{data:[],nextCursor:null}:{}}));}));
server.listen(socket,()=>writeFileSync(args[args.indexOf('--fixture-state')+1],'runtime'));
process.on('SIGTERM',()=>{for(const c of ws.clients)c.terminate();server.close(()=>process.exit(0));});
`, { mode: 0o700 });
  const appCodex = join(directory, "app-codex");
  await writeFile(appCodex, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log(${JSON.stringify(pinned)});process.exit(0);}\n`, { mode: 0o700 });
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: join(directory, "state"), providers: [], clientOnly: true };
  configureTelemetry(config.stateDirectory, "test");
  const binarySha256 = (await sdkIdentity(runtimeExecutable)).sdkSha256;
  const runtime: GatewaySdkRuntime = { executable: runtimeExecutable, binarySha256, selectedModelCompaction: true, executorIdentity: true };
  const hostHome = executionHostHome(configPath, nativeHome);
  const options = { config, configPath, nativeHome, codex: appCodex, gatewayRuntime: async () => runtime };
  const descriptor = (sha: string | undefined = binarySha256, digit = "a"): ExecutionDescriptor => ({ revision: digit.repeat(64), args: ["app-server", "--listen", "stdio://", "--fixture-state", join(directory, `engine-${digit}.state`)],
    settings: { model: "fixture" }, catalog: { models: [{ slug: "fixture" }] }, aliases: ["fixture"], ...(sha ? { gatewaySdkSha256: sha } : {}) });
  const events = async () => { await flushTelemetry(); return (await readTelemetry(config.stateDirectory, Date.now() - 600_000)).filter(event => event.event === "release_skew_refused"); };
  const clean = async () => { await flushTelemetry(); await rm(directory, { recursive: true, force: true }); await rm(hostHome, { recursive: true, force: true }); await rm(dirname(nativeHomeOwnerPath(nativeHome)), { recursive: true, force: true }); };
  return { directory, options, hostHome, binarySha256, descriptor, events, clean };
}
async function control(path: string) {
  const socket = new WebSocket(`ws+unix://${path}:/`); await once(socket, "open"); let sequence = 0;
  const request = <T>(method: string, params = {}): Promise<T> => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture timed out")), 10000);
      const listener = (bytes: WebSocket.RawData) => { const message = JSON.parse(bytes.toString()); if (message.id !== id) return; clearTimeout(timer); socket.off("message", listener); message.error ? reject(new Error(message.error.message)) : resolve(message.result); };
      socket.on("message", listener); socket.send(JSON.stringify({ id, method, params }));
    });
  };
  return { request, close: async () => { socket.terminate(); await once(socket, "close"); } };
}

test("an adapter of another gateway SDK is told the service is moving, not given the masked failure, and the host records the direction", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client;
  try {
    host = await startExecutionHost(f.options); client = await control(join(f.hostHome, "host.sock"));
    await assert.rejects(client.request("execution/acquire", { descriptor: f.descriptor(otherSha) }), error => (error as Error).message === releaseSkewMessage);
    assert.equal(releaseSkewMessage, "This Mac's gateway service is still moving to a newer release; retry in a moment");
    await assert.rejects(readFile(join(f.directory, "engine-a.state"), "utf8"), { code: "ENOENT" }, "no generation was started for it");
    const [event] = await f.events();
    assert.deepEqual({ direction: event.direction, count: event.count }, { direction: "adapter_older", count: 1 }, "no newer release is installed: the adapter is the older one");
    assert.deepEqual(Object.keys(event).sort(), ["at", "component", "count", "direction", "event", "host", "pid"], "only the fixed fields");
    assert.equal(host.skewRefused?.("0.4.7"), false, "an older adapter never makes a move urgent");
    // An adapter of this host's own SDK is still served.
    assert.equal((await client.request<ExecutionRecord>("execution/acquire", { descriptor: f.descriptor() })).revision, "a".repeat(64));
  } finally { await client?.close(); await host?.close(); await f.clean(); }
});

test("an adapter whose gateway SDK is the installed release's is a newer adapter and makes that release urgent", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client;
  try {
    host = await startExecutionHost({ ...f.options, pendingRelease: async () => ({ release: "0.4.7", gatewaySdkSha256: otherSha }) });
    client = await control(join(f.hostHome, "host.sock"));
    assert.equal(host.skewRefused?.("0.4.7"), false, "nothing was refused yet");
    await assert.rejects(client.request("execution/acquire", { descriptor: f.descriptor(otherSha) }), error => (error as Error).message === releaseSkewMessage);
    const [event] = await f.events();
    assert.deepEqual({ direction: event.direction, count: event.count }, { direction: "adapter_newer", count: 1 });
    assert.equal(host.skewRefused?.("0.4.7"), true);
    assert.equal(host.skewRefused?.("0.4.8"), false, "only for the release whose SDK was refused");
  } finally { await client?.close(); await host?.close(); await f.clean(); }
});

test("an SDK that is not the installed release's does not make the move urgent", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client;
  try {
    host = await startExecutionHost({ ...f.options, pendingRelease: async () => ({ release: "0.4.7", gatewaySdkSha256: otherSha }) });
    client = await control(join(f.hostHome, "host.sock"));
    await assert.rejects(client.request("execution/acquire", { descriptor: f.descriptor(thirdSha) }), error => (error as Error).message === releaseSkewMessage);
    assert.equal((await f.events())[0].direction, "adapter_older");
    assert.equal(host.skewRefused?.("0.4.7"), false);
  } finally { await client?.close(); await host?.close(); await f.clean(); }
});

test("a pending release that cannot be read leaves the refusal recorded as an older adapter and never fails the request", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client;
  try {
    host = await startExecutionHost({ ...f.options, pendingRelease: async () => { throw new Error("unreadable"); } });
    client = await control(join(f.hostHome, "host.sock"));
    await assert.rejects(client.request("execution/acquire", { descriptor: f.descriptor(otherSha) }), error => (error as Error).message === releaseSkewMessage);
    assert.equal((await f.events())[0].direction, "adapter_older"); assert.equal(host.skewRefused?.("0.4.7"), false);
  } finally { await client?.close(); await host?.close(); await f.clean(); }
});

test("release_skew_refused is recorded once per interval per direction, with the refusals since the last record", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client; const previous = process.env.GATEWAY_RELEASE_SKEW_EVENT_MS; process.env.GATEWAY_RELEASE_SKEW_EVENT_MS = "400";
  try {
    host = await startExecutionHost({ ...f.options, pendingRelease: async () => ({ release: "0.4.7", gatewaySdkSha256: otherSha }) });
    client = await control(join(f.hostHome, "host.sock"));
    const refuse = (sha: string) => assert.rejects(client!.request("execution/acquire", { descriptor: f.descriptor(sha) }), error => (error as Error).message === releaseSkewMessage);
    await refuse(otherSha); await refuse(otherSha); await refuse(otherSha); await refuse(thirdSha);
    assert.deepEqual((await f.events()).map(event => [event.direction, event.count]), [["adapter_newer", 1], ["adapter_older", 1]], "the repeats inside the interval are held back");
    await delay(450); await refuse(otherSha);
    assert.deepEqual((await f.events()).map(event => [event.direction, event.count]), [["adapter_newer", 1], ["adapter_older", 1], ["adapter_newer", 3]], "the next record counts the held-back refusals too");
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_RELEASE_SKEW_EVENT_MS; else process.env.GATEWAY_RELEASE_SKEW_EVENT_MS = previous;
    await client?.close(); await host?.close(); await f.clean();
  }
});

test("the installed release's gateway SDK checksum comes from that release's own verified receipt, and only while it is newer", { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "gw-skew-releases-")); t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = "installed release gateway SDK"; const binarySha256 = createHash("sha256").update(bytes).digest("hex");
  const release = async (version: string) => { await mkdir(join(root, "releases", version, "package", "dist"), { recursive: true }); await writeFile(join(root, "releases", version, "package", "dist", "self-update.js"), ""); };
  await release("0.4.6"); await release("0.4.7");
  const sdk = join(root, "releases", "0.4.7", "package", "gateway-sdk"); await mkdir(sdk, { mode: 0o700 });
  await writeFile(join(root, "releases", "0.4.7", "package", "package.json"), JSON.stringify({ version: "0.4.7" }));
  await writeFile(join(sdk, "gateway-codex"), bytes, { mode: 0o700 });
  await writeFile(join(sdk, "build.json"), JSON.stringify({ schemaVersion: 1, version: "0.4.7", codexVersion: "0.162.0-alpha.17.2", revision: gatewaySdkRevision,
    archiveSha256: "25747823ea4ec852a146cbbe75d805b8df19190ca5b3fb21052d8e1cb75f2f83", patchSha256: gatewaySdkPatchSha256,
    lockfileSha256: "49575eeb44a747925fd1acef51bff88316f728b77d7f63d989835c8623c344cb", lockfileRepairSha256: "a810a345d59038b785e4be8cb3fc979ce3e49e28f3888aaebb8b689dce3ca2b8",
    sourceSha256: "a".repeat(64), binarySha256, profile: "release", platform: process.platform, arch: process.arch, capabilities: [gatewaySdkCapability] }), { mode: 0o600 });
  const module = pathToFileURL(join(root, "releases", "0.4.6", "package", "dist", "self-update.js")).href;
  await symlink("releases/0.4.7", join(root, "current"));
  const moduleOfInstalled = pathToFileURL(join(root, "releases", "0.4.7", "package", "dist", "self-update.js")).href;
  assert.equal(await pendingGatewaySdkReader(moduleOfInstalled)(), undefined, "the installed release is the running one, SDK or not: nothing is pending");
  const read = pendingGatewaySdkReader(module);
  assert.deepEqual(await read(), { release: "0.4.7", gatewaySdkSha256: binarySha256 });
  await writeFile(join(sdk, "gateway-codex"), "changed after install");
  assert.deepEqual(await read(), { release: "0.4.7", gatewaySdkSha256: binarySha256 }, "a release's answer is kept: its files are not hashed again");
  assert.equal(await pendingGatewaySdkReader(module)(), undefined, "a binary that does not match its receipt is no checksum to trust");
  await release("0.4.8"); await rm(join(root, "current")); await symlink("releases/0.4.8", join(root, "current"));
  assert.equal(await pendingGatewaySdkReader(module)(), undefined, "an installed release without a gateway SDK has none to compare");
});
