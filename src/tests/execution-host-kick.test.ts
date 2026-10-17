import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startExecutionHost, executionHostHome } from "../execution-host.js";
import { ExecutionHostClient, setHostWaitForTests } from "../execution-host-client.js";
import { requestHostKick, watchHostKick } from "../execution-host-kick.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-kick-")); const configPath = join(directory, "gateway.json");
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  const codex = join(directory, "codex");
  // A stand-in SDK that answers the version check and serves the control calls a generation needs.
  await writeFile(codex, `#!${process.execPath}\nimport {createServer} from 'node:http';
import {WebSocketServer} from ${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)};
if(process.argv.includes('--version')) { console.log('codex-cli 0.162.0-alpha.17.2'); process.exit(0); }
const args=process.argv.slice(2);const socket=args[args.indexOf('--listen')+1].slice(7);
const server=createServer();const ws=new WebSocketServer({server});
ws.on('connection',client=>client.on('message',bytes=>{const m=JSON.parse(bytes);if(m.id==null)return;client.send(JSON.stringify({id:m.id,result:m.method==='thread/loaded/list'?{data:[],nextCursor:null}:{}}));}));
server.listen(socket);
process.on('SIGTERM',()=>{for(const c of ws.clients)c.terminate();server.close(()=>process.exit(0));});
setInterval(()=>{if(process.ppid===1)process.exit(0);},1000);
`, { mode: 0o700 });
  const config: GatewayConfig = { version: 1, port: 3458, stateDirectory: join(directory, "state"), providers: [], clientOnly: true };
  const hostHome = executionHostHome(configPath, nativeHome);
  return { directory, config, configPath, nativeHome, codex, hostHome, clean: async () => { setHostWaitForTests(); await rm(directory, { recursive: true, force: true }); await rm(hostHome, { recursive: true, force: true }); } };
}
const exitedPid = async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 5000)"], { stdio: "ignore" });
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; return child.pid!;
};
const until = async (check: () => boolean, label: string, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() > deadline) throw new Error(label + " timed out"); await delay(10); }
};

test("a kick is one private file written atomically, and an adapter never creates the service's folders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-kick-file-"));
  try {
    const home = join(directory, "home"); await mkdir(home, { mode: 0o700 });
    const before = Date.now(); await requestHostKick(home);
    const info = await lstat(join(home, "kick"));
    assert.ok(info.isFile()); assert.equal(info.mode & 0o777, 0o600);
    const written = Number(JSON.parse(await readFile(join(home, "kick"), "utf8")));
    assert.ok(written >= before && written <= Date.now());
    // The replacement is atomic: no temporary file stays next to it.
    await requestHostKick(home);
    assert.deepEqual(await readdir(home), ["kick"]);
    // A missing home is not created, and a home that is not private is not written to. Neither throws.
    await requestHostKick(join(directory, "missing", "home"));
    await assert.rejects(lstat(join(directory, "missing")), { code: "ENOENT" });
    const open = join(directory, "open"); await mkdir(open, { mode: 0o755 }); await chmod(open, 0o755);
    await requestHostKick(open);
    await assert.rejects(lstat(join(open, "kick")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the service sees each new kick, at most once per gap, and none written before it began watching", { timeout: 20000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "gateway-kick-watch-"));
  const kicks: number[] = [];
  await requestHostKick(home); // Left by an adapter before the service started: not a new request.
  const stop = watchHostKick(home, () => kicks.push(Date.now()), { intervalMs: 20, minimumGapMs: 500 });
  try {
    await delay(200); assert.equal(kicks.length, 0);
    await requestHostKick(home); await until(() => kicks.length === 1, "first kick");
    // Two more inside the gap: held back, then delivered once when the gap ends, never dropped.
    await requestHostKick(home); await delay(60); await requestHostKick(home); await delay(150);
    assert.equal(kicks.length, 1);
    await until(() => kicks.length === 2, "deferred kick");
    assert.ok(kicks[1] - kicks[0] >= 450, `${kicks[1] - kicks[0]} ms apart`);
    await delay(700); assert.equal(kicks.length, 2); // Nothing new was written.
    stop(); await requestHostKick(home); await delay(700); assert.equal(kicks.length, 2);
  } finally { stop(); await rm(home, { recursive: true, force: true }); }
});

test("a required host that is restarting is waited for, and the adapter kicks the service once", { timeout: 30000 }, async () => {
  const f = await fixture(); let host; let client;
  try {
    setHostWaitForTests(15_000);
    host = await startExecutionHost(f); await host.close(); host = undefined;
    // What a SIGKILLed service leaves: a receipt that still says running and names a pid this machine no longer has.
    const receipt = JSON.parse(await readFile(join(f.hostHome, "owner.json"), "utf8"));
    await writePrivateJson(join(f.hostHome, "owner.json"), { ...receipt, state: "running", pid: await exitedPid() });
    const asked = Date.now();
    const pending = ExecutionHostClient.discover(f.configPath, f.nativeHome, f.codex, "gateway", true);
    await delay(400);
    const kick = await lstat(join(f.hostHome, "kick"));
    assert.equal(kick.mode & 0o777, 0o600); assert.ok(Number(await readFile(join(f.hostHome, "kick"), "utf8")) >= asked);
    host = await startExecutionHost(f); // What the service does on the kick.
    client = await pending; assert.ok(client);
    assert.equal(await client.find("nothing-loaded"), undefined);
  } finally { client?.close(); await host?.close(); await f.clean(); }
});

test("a required host that stays down fails with the same error after the wait, and an optional one is looked at once", { timeout: 30000 }, async () => {
  const f = await fixture(); let host;
  try {
    setHostWaitForTests(600);
    let began = Date.now();
    await assert.rejects(ExecutionHostClient.discover(f.configPath, f.nativeHome, f.codex, "gateway", true), (error: Error) => error.message === "Shared gateway executor host is unavailable; check gateway service status");
    assert.ok(Date.now() - began >= 550, "waited for the host");
    began = Date.now(); assert.equal(await ExecutionHostClient.discover(f.configPath, f.nativeHome, f.codex), undefined); assert.ok(Date.now() - began < 500);
    host = await startExecutionHost(f); await host.close(); host = undefined;
    const receipt = JSON.parse(await readFile(join(f.hostHome, "owner.json"), "utf8"));
    await writePrivateJson(join(f.hostHome, "owner.json"), { ...receipt, state: "running", pid: await exitedPid() });
    began = Date.now();
    await assert.rejects(ExecutionHostClient.discover(f.configPath, f.nativeHome, f.codex, "gateway", true), (error: Error) => error.message === "Shared executor host is unavailable; check gateway service status");
    assert.ok(Date.now() - began >= 550, "waited for the host");
    began = Date.now();
    await assert.rejects(ExecutionHostClient.discover(f.configPath, f.nativeHome, f.codex, "gateway", false), /Shared executor host is unavailable/);
    assert.ok(Date.now() - began < 500, "an optional host is not waited for");
    // The caller's signal ends the wait early with the same answer.
    setHostWaitForTests(15_000); const controller = new AbortController(); setTimeout(() => controller.abort(), 200);
    began = Date.now();
    await assert.rejects(ExecutionHostClient.discover(f.configPath, f.nativeHome, f.codex, "gateway", true, controller.signal), /Shared executor host is unavailable/);
    assert.ok(Date.now() - began < 3000, "the wait ended with the signal");
  } finally { await host?.close(); await f.clean(); }
});

test("a live host that cannot serve this request fails at once instead of waiting", { timeout: 30000 }, async () => {
  const f = await fixture(); let host;
  try {
    setHostWaitForTests(15_000);
    host = await startExecutionHost(f);
    const began = Date.now();
    await assert.rejects(ExecutionHostClient.discover(f.configPath, f.nativeHome, f.codex, "native", true), (error: Error & { capabilityAbsent?: string }) => error.capabilityAbsent === "native");
    assert.ok(Date.now() - began < 3000, "a live host's answer is final");
    await assert.rejects(lstat(join(f.hostHome, "kick")), { code: "ENOENT" }); // Nothing to retry, so no kick either.
  } finally { await host?.close(); await f.clean(); }
});
