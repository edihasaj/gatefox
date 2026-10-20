import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { startExecutionHost, executionHostHome, type ExecutionDescriptor, type ExecutionRecord } from "../execution-host.js";
import { readOwner, sdkIdentity } from "../execution-host-storage.js";
import { ExecutionHostClient } from "../execution-host-client.js";
import { readNativeHomeOwner, nativeHomeOwnerPath } from "../native-execution-host-storage.js";
import type { GatewayConfig } from "../config.js";
import type { GatewaySdkRuntime } from "../gateway-sdk-runtime.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.

// The app's native codex may be any version; the gateway runtime is the pinned fixture SDK that generations really run.
const pinned = "codex-cli 0.162.0-alpha.17.2";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gw-host-sdk-")); const configPath = join(directory, "gateway.json");
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
  // The app's codex only answers --version; if a generation spawned it, no listener would ever appear.
  const appCodex = join(directory, "app-codex");
  const writeApp = (version: string) => writeFile(appCodex, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log(${JSON.stringify(version)});process.exit(0);}\nrequire('node:fs').writeFileSync(process.argv[process.argv.indexOf('--fixture-state')+1],'app');\n`, { mode: 0o700 });
  await writeApp("codex-cli 0.163.0-alpha.10.2");
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: join(directory, "state"), providers: [], clientOnly: true };
  const binarySha256 = (await sdkIdentity(runtimeExecutable)).sdkSha256;
  const runtime: GatewaySdkRuntime = { executable: runtimeExecutable, binarySha256, selectedModelCompaction: true, executorIdentity: true };
  const gatewayRuntime = async () => runtime;
  const hostHome = executionHostHome(configPath, nativeHome);
  const options = { config, configPath, nativeHome, codex: appCodex, gatewayRuntime };
  const descriptor = (withRuntime = true, digit = "a"): ExecutionDescriptor => ({ revision: digit.repeat(64), args: ["app-server", "--listen", "stdio://", "--fixture-state", join(directory, `engine-${digit}.state`)],
    settings: { model: "fixture" }, catalog: { models: [{ slug: "fixture", tool_mode: "direct" }] }, aliases: ["fixture"], ...(withRuntime ? { gatewaySdkSha256: binarySha256 } : {}) });
  const clean = async () => { await rm(directory, { recursive: true, force: true }); await rm(hostHome, { recursive: true, force: true }); await rm(dirname(nativeHomeOwnerPath(nativeHome)), { recursive: true, force: true }); };
  return { directory, config, options, hostHome, nativeHome, appCodex, writeApp, runtime, descriptor, clean };
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
  return { socket, request, close: async () => { socket.terminate(); await once(socket, "close"); } };
}
const failing = (message: string) => async (): Promise<never> => { throw new Error(message); };
const sameNative = async (codex: string) => { const identity = await sdkIdentity(codex); return { nativeSdkExecutable: identity.codex, nativeSdkSha256: identity.sdkSha256 }; };

test("the host validates the gateway runtime it spawns, not a newer native codex from the app", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client;
  try {
    host = await startExecutionHost(f.options); client = await control(join(f.hostHome, "host.sock"));
    assert.deepEqual((await client.request<{ capabilities: string[] }>("execution/status")).capabilities, ["gateway"]);
    const record = await client.request<ExecutionRecord>("execution/acquire", { descriptor: f.descriptor() });
    assert.equal(record.selectedModelCompaction, true);
    assert.equal(await readFile(join(f.directory, "engine-a.state"), "utf8"), "runtime");
    assert.equal((await readOwner(join(f.hostHome, "owner.json")))?.capabilities?.join(), "gateway");
  } finally { await client?.close(); await host?.close(); await f.clean(); }
});

test("a verified gateway runtime does not gain Code Mode from an adjacent added helper", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client;
  try {
    await writeFile(join(dirname(f.runtime.executable), "codex-code-mode-host"), "#!/bin/sh\n", { mode: 0o700 });
    host = await startExecutionHost(f.options); client = await control(join(f.hostHome, "host.sock"));
    const descriptor = f.descriptor();
    descriptor.catalog = { models: [{ slug: "fixture" }] };
    const record = await client.request<ExecutionRecord>("execution/acquire", { descriptor });
    assert.notEqual(record.revision, descriptor.revision);
  } finally { await client?.close(); await host?.close(); await f.clean(); }
});

test("a gateway SDK repaired after host start cannot change that host's selected runtime", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client; let available = false;
  try {
    await f.writeApp(pinned); await writeFile(join(dirname(f.appCodex), "codex-code-mode-host"), "#!/bin/sh\n", { mode: 0o700 });
    host = await startExecutionHost({ ...f.options, gatewayRuntime: async () => available ? f.runtime : undefined });
    client = await control(join(f.hostHome, "host.sock")); available = true;
    const descriptor = f.descriptor();
    descriptor.catalog = { models: [{ slug: "fixture" }] };
    await assert.rejects(client.request("execution/acquire", { descriptor }), /Execution operation failed/);
    await assert.rejects(readFile(join(f.directory, "engine-a.state"), "utf8"), { code: "ENOENT" });
  } finally { await client?.close(); await host?.close(); await f.clean(); }
});

test("an app update while the host runs does not refuse generations that run the runtime", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client;
  try {
    await f.writeApp(pinned); host = await startExecutionHost(f.options); client = await control(join(f.hostHome, "host.sock"));
    await f.writeApp("codex-cli 0.163.0-alpha.10.2");
    const record = await client.request<ExecutionRecord>("execution/acquire", { descriptor: f.descriptor() });
    assert.equal(record.revision, "a".repeat(64)); assert.equal(await readFile(join(f.directory, "engine-a.state"), "utf8"), "runtime");
    // The generation directory survives the next host start with a different native codex checksum.
    await client.close(); client = undefined; await host.close(); host = undefined;
    await f.writeApp("codex-cli 0.164.0"); host = await startExecutionHost(f.options); client = await control(join(f.hostHome, "host.sock"));
    assert.equal((await client.request<ExecutionRecord>("execution/acquire", { descriptor: f.descriptor() })).revision, "a".repeat(64));
  } finally { await client?.close(); await host?.close(); await f.clean(); }
});

test("without a gateway runtime the native codex is still pinned and checked for changes", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client; const options = { ...f.options, gatewayRuntime: async () => undefined };
  try {
    await assert.rejects(startExecutionHost(options), /requires the pinned Codex SDK version/);
    await f.writeApp(pinned); host = await startExecutionHost(options); client = await control(join(f.hostHome, "host.sock"));
    await appendFile(f.appCodex, "// changed after the host started\n");
    await assert.rejects(client.request("execution/acquire", { descriptor: f.descriptor(false) }), /Execution operation failed/);
    await assert.rejects(readFile(join(f.directory, "engine-a.state"), "utf8"), { code: "ENOENT" });
  } finally { await client?.close(); await host?.close(); await f.clean(); }
});

test("a native SDK that fails verification leaves the host gateway-only and records only a fixed reason", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client; const started = Date.now() - 1000;
  configureTelemetry(f.config.stateDirectory, "test");
  try {
    const options = { ...f.options, capabilities: ["native" as const, "gateway" as const], nativeRelayOwnsRegistration: true, nativeSdkVerifier: failing("Execution host requires the pinned Codex SDK version") };
    host = await startExecutionHost(options); client = await control(join(f.hostHome, "host.sock"));
    assert.deepEqual((await client.request<{ capabilities: string[] }>("execution/status")).capabilities, ["gateway"]);
    const owner = await readOwner(join(f.hostHome, "owner.json"));
    assert.deepEqual(owner?.capabilities, ["gateway"]); assert.equal(owner?.nativeRelayOwnsRegistration, undefined); assert.equal(owner?.nativeSdkSha256, undefined);
    assert.equal(await readNativeHomeOwner(f.nativeHome), undefined);
    await assert.rejects(client.request("native/acquire", { args: ["app-server"], cwd: f.directory }), /does not offer native ownership/);
    assert.equal((await client.request<ExecutionRecord>("execution/acquire", { descriptor: f.descriptor() })).revision, "a".repeat(64));
    await flushTelemetry();
    const events = (await readTelemetry(f.config.stateDirectory, started)).filter(event => event.event === "native_sharing_unavailable");
    assert.equal(events.length, 1); assert.equal(events[0].reason, "sdk_version");
    assert.deepEqual(Object.keys(events[0]).sort(), ["at", "component", "event", "host", "pid", "reason"]);
  } finally { await client?.close(); await host?.close(); await f.clean(); }
});

test("native reasons are a fixed set and a native-only host still fails closed", { timeout: 30000 }, async () => {
  const f = await fixture(); const started = Date.now() - 1000;
  configureTelemetry(f.config.stateDirectory, "test");
  try {
    await f.writeApp(pinned);
    const both = { ...f.options, capabilities: ["native" as const, "gateway" as const] };
    for (const message of ["Native execution SDK signature verification failed", "Execution host SDK is unavailable"]) {
      const host = await startExecutionHost({ ...both, nativeSdkVerifier: failing(message) }); await host.close();
    }
    await assert.rejects(startExecutionHost({ ...f.options, capabilities: ["native"], nativeRelayOwnsRegistration: true, nativeSdkVerifier: failing("Native execution requires the original signed Codex SDK") }), /original signed/);
    await assert.rejects(startExecutionHost({ ...f.options, nativeRelayOwnsRegistration: true }), /native relay ownership is invalid/);
    await flushTelemetry();
    const reasons = (await readTelemetry(f.config.stateDirectory, started)).filter(event => event.event === "native_sharing_unavailable").map(event => event.reason);
    assert.deepEqual(reasons, ["sdk_signature", "other"]);
  } finally { await f.clean(); }
});

test("a gateway-only restart replaces a stopped native-capable receipt after the app changed", { timeout: 30000 }, async () => {
  const f = await fixture(); let host;
  try {
    await f.writeApp(pinned);
    host = await startExecutionHost({ ...f.options, capabilities: ["native", "gateway"], nativeSdkVerifier: sameNative }); await host.close(); host = undefined;
    assert.ok((await readOwner(join(f.hostHome, "owner.json")))?.nativeSdkSha256);
    await f.writeApp("codex-cli 0.163.0-alpha.10.2");
    host = await startExecutionHost({ ...f.options, capabilities: ["native", "gateway"], nativeSdkVerifier: failing("Execution host requires the pinned Codex SDK version") });
    const owner = await readOwner(join(f.hostHome, "owner.json"));
    assert.deepEqual(owner?.capabilities, ["gateway"]); assert.equal(owner?.state, "running");
  } finally { await host?.close(); await f.clean(); }
});

test("a host that pinned its runtime never spawns the unchecked app codex for a descriptor without a runtime", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client;
  try {
    // The app's codex here is a newer engine the host never checked: it pinned the runtime instead.
    host = await startExecutionHost(f.options); client = await control(join(f.hostHome, "host.sock"));
    await assert.rejects(client.request<ExecutionRecord>("execution/acquire", { descriptor: f.descriptor(false, "b") }));
    // Neither binary was started for that generation: no fixture state was written.
    await assert.rejects(readFile(join(f.directory, "engine-b.state"), "utf8"), { code: "ENOENT" });
    // A descriptor naming the runtime still works on the same host.
    await client.request<ExecutionRecord>("execution/acquire", { descriptor: f.descriptor(true, "c") });
    assert.equal(await readFile(join(f.directory, "engine-c.state"), "utf8"), "runtime");
  } finally { await client?.close(); await host?.close(); await f.clean(); }
});

test("a runtime that cannot be resolved fails closed instead of substituting the app codex", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(startExecutionHost({ ...f.options, gatewayRuntime: failing("damaged runtime") }), /damaged runtime/);
  } finally { await f.clean(); }
});

// D5 and A4: a gateway-only host runs its pinned runtime, so an app update that removes, moves or relinks the app's codex must
// neither stop the host from starting nor make adapters reject it as foreign (they used to compare the app's codex path and
// fail with "ownership does not match" for as long as that host ran).
test("a gateway-only host and its adapters do not depend on the app's codex being present, in place or unchanged", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; const clients: ExecutionHostClient[] = [];
  const discover = async (codex: string) => { const client = await ExecutionHostClient.discover(f.options.configPath, f.nativeHome, codex, "gateway", true); assert.ok(client); clients.push(client!); return client!; };
  try {
    await rm(f.appCodex); // Mid-update: the app's codex is gone.
    host = await startExecutionHost(f.options);
    const owner = await readOwner(join(f.hostHome, "owner.json"));
    assert.equal(owner?.codex, f.runtime.executable); assert.equal(owner?.sdkSha256, f.runtime.binarySha256);
    assert.deepEqual((await discover(f.appCodex)).capabilities, ["gateway"]);
    await f.writeApp("codex-cli 0.164.0"); // The update finished: a different binary at the same path.
    await discover(f.appCodex);
    const moved = join(f.directory, "Moved.app-codex"); await rename(f.appCodex, moved); // Moved elsewhere.
    await discover(moved);
    await symlink(moved, f.appCodex); // Relinked: the configured path is now a link to the new place.
    await discover(f.appCodex);
    // Generations still run the runtime the host pinned.
    const client = await control(join(f.hostHome, "host.sock"));
    try { assert.equal((await client.request<ExecutionRecord>("execution/acquire", { descriptor: f.descriptor() })).revision, "a".repeat(64)); }
    finally { await client.close(); }
    assert.equal(await readFile(join(f.directory, "engine-a.state"), "utf8"), "runtime");
  } finally { for (const client of clients) client.close(); await host?.close(); await f.clean(); }
});

test("a host that shares native execution still has to match the app's codex", { timeout: 30000 }, async () => {
  const f = await fixture(); let host;
  try {
    await f.writeApp(pinned);
    host = await startExecutionHost({ ...f.options, capabilities: ["native", "gateway"], nativeSdkVerifier: sameNative });
    const other = join(f.directory, "other-codex"); await writeFile(other, "#!/bin/sh\n", { mode: 0o700 });
    await assert.rejects(ExecutionHostClient.discover(f.options.configPath, f.nativeHome, other, "gateway", true), /ownership does not match/);
  } finally { await host?.close(); await f.clean(); }
});
