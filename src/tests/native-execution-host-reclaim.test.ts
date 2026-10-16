import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { claimNativeHome, nativeHomeOwnerPath, readNativeHomeOwner, setNativeStartupGraceForTests, type NativeHomeOwner } from "../native-execution-host-storage.js";
import { executionHostMarker, privateDirectory, sdkSocketTarget, setSdkSocketRootForTests, type HostIdentity } from "../execution-host-storage.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { setBootIdentityForTests } from "../boot-identity.js";
import { writePrivateJson } from "../config.js";

const current = { id: "11111111-1111-4111-8111-111111111111", bootedAtMs: 1_700_000_000_000 };
const earlier = "22222222-2222-4222-8222-222222222222";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gwt-native-")); const root = join(directory, "r");
  await mkdir(root, { mode: 0o700 }); setSdkSocketRootForTests(root);
  const previousHome = process.env.HOME; process.env.HOME = join(directory, "home");
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  const hostHome = join(directory, "host"); await privateDirectory(hostHome);
  const identity: HostIdentity = { version: 1, managed: executionHostMarker, configPath: join(directory, "gateway.json"), nativeHome,
    codex: join(directory, "codex"), sdkSha256: "a".repeat(64), socketPath: resolve(hostHome, "host.sock"), capabilities: ["native", "gateway"],
    nativeSdkExecutable: join(directory, "codex"), nativeSdkSha256: "a".repeat(64) };
  const path = nativeHomeOwnerPath(nativeHome);
  configureTelemetry(join(directory, "state"), "test");
  const receipt = async (fields: Partial<NativeHomeOwner>) => writePrivateJson(path, {
    version: 1, managed: "subscription-gateway-native-execution-owner", configPath: identity.configPath, nativeHome, codex: identity.codex, sdkSha256: identity.sdkSha256,
    hostPid: 4242, pid: 0, socketPath: resolve(hostHome, "native.sock"), state: "running", sdkState: "idle", bootId: current.id, startedAtMs: current.bootedAtMs + 2000,
    nativeSdkExecutable: identity.nativeSdkExecutable, nativeSdkSha256: identity.nativeSdkSha256, ...fields });
  const reclaims = async () => { await flushTelemetry(); return (await readTelemetry(join(directory, "state"), current.bootedAtMs - 1000)).filter(event => event.event === "execution_owner_reclaimed"); };
  // A process that ran and is gone: its pid is a real one that this boot could reuse.
  const exitedPid = async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 5000)"], { stdio: "ignore" });
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; return child.pid!;
  };
  return { directory, path, hostHome, nativeHome, identity, receipt, reclaims, exitedPid,
    clean: async () => { setSdkSocketRootForTests(); setBootIdentityForTests(); process.env.HOME = previousHome; await rm(directory, { recursive: true, force: true }); } };
}

test("an app update cannot block a native home whose owner is gone", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    const dead = await f.exitedPid();
    await f.receipt({ hostPid: dead, pid: dead, codex: join(f.directory, "Older.app", "codex"), sdkSha256: "b".repeat(64), nativeSdkExecutable: join(f.directory, "Older.app", "engine"), nativeSdkSha256: "c".repeat(64), sdkBootId: current.id, sdkStartedAtMs: current.bootedAtMs + 2000 });
    const lease = await claimNativeHome(f.identity, f.hostHome);
    const owner = await readNativeHomeOwner(f.nativeHome);
    assert.equal(owner?.hostPid, process.pid); assert.equal(owner?.codex, f.identity.codex); assert.equal(owner?.sdkSha256, f.identity.sdkSha256);
    assert.deepEqual((await f.reclaims()).map(event => [event.scope, event.reason]), [["native_home", "dead_pids"]]);
    assert.ok(lease);
  } finally { await f.clean(); }
});

test("a launch a dead host left unconfirmed is reclaimed once the startup grace passed and nothing answers", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    const dead = await f.exitedPid();
    await f.receipt({ hostPid: dead, pid: dead, sdkState: "starting" });
    const old = new Date(Date.now() - 120_000); await utimes(f.path, old, old);
    await claimNativeHome(f.identity, f.hostHome);
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.sdkState, "idle");
    assert.deepEqual((await f.reclaims()).map(event => event.reason), ["dead_pids"]);
  } finally { await f.clean(); }
});

test("a launch a dead host left unconfirmed keeps waiting inside the startup grace", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    const dead = await f.exitedPid();
    await f.receipt({ hostPid: dead, pid: dead, sdkState: "starting" });
    await assert.rejects(claimNativeHome(f.identity, f.hostHome), /launch is unconfirmed/);
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.sdkState, "starting");
    await assert.rejects(readdir(join(dirname(f.path), "stale")), { code: "ENOENT" });
    setNativeStartupGraceForTests(0); // The same receipt, once the grace is over and nothing answers it.
    await claimNativeHome(f.identity, f.hostHome);
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.sdkState, "idle");
  } finally { setNativeStartupGraceForTests(); await f.clean(); }
});

test("a launch past the startup grace is still unconfirmed while its socket answers", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture(); const server = createServer();
  try {
    setBootIdentityForTests(current);
    const dead = await f.exitedPid();
    await f.receipt({ hostPid: dead, pid: dead, sdkState: "starting" });
    const old = new Date(Date.now() - 120_000); await utimes(f.path, old, old);
    server.listen(join(f.hostHome, "native.sock")); await once(server, "listening"); await chmod(join(f.hostHome, "native.sock"), 0o600);
    await assert.rejects(claimNativeHome(f.identity, f.hostHome), /launch is unconfirmed/);
    assert.ok(server.listening); assert.equal((await readNativeHomeOwner(f.nativeHome))?.sdkState, "starting");
  } finally { await new Promise<void>(done => server.listening ? server.close(() => done()) : done()); await f.clean(); }
});

test("an unconfirmed launch from a previous boot is reclaimed at once", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    await f.receipt({ bootId: earlier, hostPid: 0, pid: 0, sdkState: "starting" });
    await claimNativeHome(f.identity, f.hostHome);
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.sdkState, "idle");
    assert.deepEqual((await f.reclaims()).map(event => event.reason), ["previous_boot"]);
  } finally { await f.clean(); }
});

test("a native home from a previous boot is reclaimed and its receipt is kept", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    await f.receipt({ bootId: earlier, hostPid: 99_999, pid: 99_998, sdkState: "running" });
    await claimNativeHome(f.identity, f.hostHome);
    const stale = await readdir(join(dirname(f.path), "stale"));
    assert.equal(stale.length, 1); assert.equal(JSON.parse(await readFile(join(dirname(f.path), "stale", stale[0]), "utf8")).bootId, earlier);
    assert.deepEqual((await f.reclaims()).map(event => event.reason), ["previous_boot"]);
  } finally { await f.clean(); }
});

test("a garbled native receipt is reclaimed only when its socket answers nothing", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    await mkdir(dirname(f.path), { recursive: true, mode: 0o700 });
    await writeFile(f.path, "{ not json at all", { mode: 0o600 });
    await claimNativeHome(f.identity, f.hostHome);
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.hostPid, process.pid);
    assert.equal((await readdir(join(dirname(f.path), "stale"))).length, 1);
    assert.deepEqual((await f.reclaims()).map(event => event.reason), ["invalid_receipt"]);
  } finally { await f.clean(); }
});

test("a live native owner is never displaced and an unconfirmed launch still waits", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture(); const server = createServer();
  try {
    setBootIdentityForTests(current);
    await f.receipt({ hostPid: process.pid, pid: 0 });
    const written = await readFile(f.path, "utf8");
    server.listen(join(f.hostHome, "native.sock")); await once(server, "listening"); await chmod(join(f.hostHome, "native.sock"), 0o600);
    await assert.rejects(claimNativeHome(f.identity, f.hostHome), /already owns this native home/);
    assert.ok(server.listening);
    // Refused means untouched: the receipt is byte-for-byte what it was, and nothing was archived.
    assert.equal(await readFile(f.path, "utf8"), written);
    await assert.rejects(readdir(join(dirname(f.path), "stale")), { code: "ENOENT" });
    await new Promise<void>(done => server.close(() => done()));
    // The same receipt, now that nothing answers it, names a process this machine no longer has.
    await claimNativeHome(f.identity, f.hostHome);
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.hostPid, process.pid);
    await f.receipt({ pid: 0, sdkState: "starting" });
    server.listen(join(f.hostHome, "native.sock")); await once(server, "listening"); await chmod(join(f.hostHome, "native.sock"), 0o600);
    await assert.rejects(claimNativeHome(f.identity, f.hostHome), /launch is unconfirmed/);
  } finally { await new Promise<void>(done => server.listening ? server.close(() => done()) : done()); await f.clean(); }
});

test("a stopped native handover changes nothing it does not have to", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    await f.receipt({ state: "stopped", sdkState: "stopped", hostPid: 0, pid: 0 });
    await claimNativeHome(f.identity, f.hostHome);
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.state, "running");
    assert.deepEqual(await f.reclaims(), []);
    await assert.rejects(readdir(join(dirname(f.path), "stale")), { code: "ENOENT" });
    const target = await sdkSocketTarget(join(f.hostHome, "native.sock"));
    void target;
  } finally { await f.clean(); }
});
