import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { startExecutionHost, executionHostHome, hostFailureReason, type ExecutionDescriptor } from "../execution-host.js";
import { sdkSocketTarget, setSdkSocketRootForTests, socketIdentity } from "../execution-host-storage.js";
import { executionHostReady } from "../mac-shared-executors.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { errorClass } from "../turn-telemetry.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { ServicePlan } from "../service-plan.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

// No `hostRunsInThisProcess` here: these hosts are judged by the production rule, which reads a receipt naming this very
// process as the leftover of an attempt that never finished.
const roots = isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.

async function fixture(version = "codex-cli 0.162.0-alpha.17.2") {
  const directory = await mkdtemp(join(tmpdir(), "gateway-self-heal-")); const configPath = join(directory, "gateway.json");
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  const codex = join(directory, "codex");
  await writeFile(codex, `#!${process.execPath}\nimport {createServer} from 'node:http';
import {WebSocketServer} from ${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)};
if(process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
const args=process.argv.slice(2);const socket=args[args.indexOf('--listen')+1].slice(7);
const server=createServer();const ws=new WebSocketServer({server});
ws.on('connection',client=>client.on('message',bytes=>{const m=JSON.parse(bytes);if(m.id==null)return;client.send(JSON.stringify({id:m.id,result:m.method==='thread/loaded/list'?{data:[],nextCursor:null}:{}}));}));
server.listen(socket);
process.on('SIGTERM',()=>{for(const c of ws.clients)c.terminate();server.close(()=>process.exit(0));});
setInterval(()=>{if(process.ppid===1)process.exit(0);},1000);
`, { mode: 0o700 });
  const config: GatewayConfig = { version: 1, port: 3460, stateDirectory: join(directory, "state"), providers: [], clientOnly: true };
  configureTelemetry(config.stateDirectory, "test");
  const hostHome = executionHostHome(configPath, nativeHome);
  const descriptor: ExecutionDescriptor = { revision: "a".repeat(64), args: ["app-server", "--listen", "stdio://"], settings: { model: "fixture" }, catalog: { models: [{ slug: "fixture", tool_mode: "direct" }] }, aliases: ["fixture"] };
  const generation = join(config.stateDirectory, "desktop-generations", `shared-v1-${descriptor.revision}`);
  return { directory, config, configPath, nativeHome, codex, hostHome, descriptor, generation,
    clean: async () => { roots.restore(); await rm(directory, { recursive: true, force: true }); await rm(hostHome, { recursive: true, force: true }); } };
}
async function acquire(home: string, descriptor: ExecutionDescriptor): Promise<void> {
  const socket = new WebSocket(`ws+unix://${join(home, "host.sock")}:/`); await once(socket, "open");
  try {
    const reply = new Promise<{ error?: { message: string } }>(done => socket.once("message", bytes => done(JSON.parse(bytes.toString()))));
    socket.send(JSON.stringify({ id: 1, method: "execution/acquire", params: { descriptor } }));
    const message = await reply; if (message.error) throw new Error(message.error.message);
  } finally { socket.terminate(); }
}

test("host failures are reported from a fixed vocabulary, never from the error's own text", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const cases: Array<[unknown, string]> = [
    [new Error("An execution host already owns this configuration"), "live_owner"],
    [new Error("An execution generation is still running; its loaded chats were preserved"), "live_owner"],
    [Object.assign(new Error("Private preferences are busy; retry the selection"), { code: "ELOCKBUSY" }), "live_owner"],
    [new Error("Execution host identity changed; existing ownership was preserved"), "identity_changed"],
    [new Error("Native execution ownership changed; existing ownership was preserved"), "identity_changed"],
    [new Error("Execution control socket target is occupied; its listener was preserved"), "socket_occupied"],
    [new Error("Execution socket belongs to another listener; it was preserved"), "socket_occupied"],
    [Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }), "socket_occupied"],
    [new Error("Execution host requires the pinned Codex SDK version"), "sdk_invalid"],
    [new Error("Native execution SDK signature verification failed"), "sdk_invalid"],
    [new Error("Execution host ownership receipt is invalid"), "receipt_invalid"],
    [new Error("Native execution ownership receipt is invalid"), "receipt_invalid"],
    [Object.assign(new Error("EACCES: permission denied"), { code: "EACCES", path: "/private/state/owner.json" }), "io_error"],
    [Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }), "io_error"],
    [new Error("Execution host directory must be private and user-owned"), "io_error"],
    [new Error("something nobody planned for"), "other"], ["a string", "other"], [undefined, "other"],
  ];
  for (const [error, reason] of cases) assert.equal(hostFailureReason(error), reason, String((error as Error)?.message ?? error));
  // The 2026-10-16 incident: the SDK folder was gone after a reboot. The turn classifier read "501" in its path as a 5xx.
  const incident = Object.assign(new Error("ENOENT: no such file or directory, lstat '/private/tmp/codex-daemon-501'"), { code: "ENOENT", syscall: "lstat", path: "/private/tmp/codex-daemon-501" });
  assert.equal(errorClass(incident.message), "overloaded");
  assert.equal(hostFailureReason(incident), "sdk_dir_missing");
  assert.equal(hostFailureReason(Object.assign(new Error("ENOENT"), { code: "ENOENT", path: "/tmp/codex-daemon-501/0123abcd" })), "sdk_dir_missing");
  assert.equal(hostFailureReason(Object.assign(new Error("ENOENT"), { code: "ENOENT", path: "/private/state/owner.json" })), "io_error");
  // The same, raised for real: a socket link whose SDK folder was cleared while the link stayed.
  const f = await fixture();
  try {
    const root = join(f.directory, "r"); await mkdir(root, { mode: 0o700 }); setSdkSocketRootForTests(root);
    const link = join(f.directory, "e.sock"); await symlink(await sdkSocketTarget(link), link); await rm(root, { recursive: true });
    const missing = await socketIdentity(link).then(() => undefined, error => error);
    assert.equal(hostFailureReason(missing), "sdk_dir_missing");
  } finally { await f.clean(); }
});

test("a host whose engine is missing or the wrong version reports sdk_invalid, whatever the error's code", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture(); const wrong = await fixture("codex-cli 0.1.0");
  try {
    const missing = await startExecutionHost({ config: f.config, configPath: f.configPath, nativeHome: f.nativeHome, codex: join(f.directory, "no-such-codex"), gatewayRuntime: async () => undefined }).then(() => undefined, error => error);
    assert.equal(missing?.code, "ENOENT"); assert.equal(hostFailureReason(missing), "sdk_invalid");
    const version = await startExecutionHost({ config: wrong.config, configPath: wrong.configPath, nativeHome: wrong.nativeHome, codex: wrong.codex, gatewayRuntime: async () => undefined }).then(() => undefined, error => error);
    assert.ok(version instanceof Error); assert.equal(hostFailureReason(version), "sdk_invalid");
  } finally { await f.clean(); await wrong.clean(); }
});

// B3: the host runs inside the supervisor, so a receipt naming the supervisor's own pid (left by a start that could not finish,
// or by an earlier process this boot that had the same pid) must never block the next start.
test("a receipt naming this very process does not stop the host from starting", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture(); let host;
  try {
    host = await startExecutionHost({ config: f.config, configPath: f.configPath, nativeHome: f.nativeHome, codex: f.codex }); await host.close(); host = undefined;
    const receipt = JSON.parse(await readFile(join(f.hostHome, "owner.json"), "utf8"));
    await writePrivateJson(join(f.hostHome, "owner.json"), { ...receipt, state: "running", pid: process.pid, generations: [{ revision: "b".repeat(64), pid: process.pid, socketPath: join(f.hostHome, "e-bbbbbbbbbbbbbbbb.sock") }] });
    host = await startExecutionHost({ config: f.config, configPath: f.configPath, nativeHome: f.nativeHome, codex: f.codex });
    const now = JSON.parse(await readFile(join(f.hostHome, "owner.json"), "utf8"));
    assert.equal(now.state, "running"); assert.equal(now.pid, process.pid); assert.deepEqual(now.generations, []);
  } finally { await host?.close(); await f.clean(); }
});

test("a garbled generation record or catalog is kept aside and rewritten, while a changed identity still refuses", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fixture(); let host: Awaited<ReturnType<typeof startExecutionHost>> | undefined;
  const start = async () => { host = await startExecutionHost({ config: f.config, configPath: f.configPath, nativeHome: f.nativeHome, codex: f.codex }); };
  const stop = async () => { await host?.close(); host = undefined; };
  try {
    await start(); await acquire(f.hostHome, f.descriptor); await stop();
    const metadata = join(f.generation, "execution-generation.json"); const catalog = join(f.generation, "catalog.json");
    const original = await readFile(metadata, "utf8");
    await writeFile(metadata, '{"managed":"subscription-gateway-execution-gen', { mode: 0o600 }); // Cut off mid-write.
    await writeFile(catalog, "\u0000\u0000", { mode: 0o600 });
    await start(); await acquire(f.hostHome, f.descriptor); await stop();
    assert.equal(await readFile(metadata, "utf8"), original);
    assert.deepEqual(JSON.parse(await readFile(catalog, "utf8")), f.descriptor.catalog);
    const kept = (await readdir(join(f.generation, "stale"))).sort();
    assert.equal(kept.length, 2); assert.ok(kept.some(name => name.startsWith("catalog-"))); assert.ok(kept.some(name => name.startsWith("execution-generation-")));
    await flushTelemetry();
    const events = (await readTelemetry(f.config.stateDirectory, 0)).filter(event => event.event === "execution_owner_reclaimed");
    assert.deepEqual(events.map(event => [event.scope, event.reason]), [["generation", "invalid_receipt"], ["generation", "invalid_receipt"]]);
    // A record this code wrote for another identity still protects that generation's files.
    await writePrivateJson(metadata, { ...JSON.parse(original), fingerprint: "f".repeat(64) });
    await start();
    await assert.rejects(acquire(f.hostHome, f.descriptor), /Execution operation failed/);
    assert.equal(JSON.parse(await readFile(metadata, "utf8")).fingerprint, "f".repeat(64));
  } finally { await stop(); await f.clean(); }
});

test("a failed private write leaves no temporary file behind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-private-write-"));
  try {
    const target = join(directory, "owner.json"); await mkdir(target); await writeFile(join(target, "occupied"), "x"); // Rename onto a folder fails.
    await assert.rejects(writePrivateJson(target, { value: 1 }));
    assert.deepEqual((await readdir(directory)).sort(), ["owner.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// B6: readiness compared the app's codex with a gateway-only host's receipt, so an app update that moved or removed that codex made
// a healthy host look not ready. Only a host that shares native execution runs the app's engine.
test("a gateway-only host is ready whatever happened to the app's codex", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture(); let host;
  try {
    host = await startExecutionHost({ config: f.config, configPath: f.configPath, nativeHome: f.nativeHome, codex: f.codex });
    const plan: ServicePlan = { version: 1, config: f.configPath, sharedExecutors: true, components: [{ id: "native", kind: "native", command: process.execPath,
      args: ["--codex", join(f.directory, "app-updated-away", "codex"), "--native-home", f.nativeHome], log: join(f.directory, "native.log") }] };
    assert.equal(await executionHostReady(plan, process.pid), true);
  } finally { await host?.close(); await f.clean(); }
});
