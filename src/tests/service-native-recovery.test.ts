import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { executionHostHome, executionHostMarker, sdkSocketTarget, type HostOwner } from "../execution-host-storage.js";
import { nativeHomeOwnerPath, type NativeHomeOwner } from "../native-execution-host-storage.js";
import { archiveStoppedExecutionReceipt, archiveStoppedNativeHomeReceipt } from "../service-execution-recovery.js";
import { withPrivateFileLock } from "../private-file-lock.js";
import { setBootIdentityForTests, setProcessStartReaderForTests } from "../boot-identity.js";
import { writePrivateJson } from "../config.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-native-recovery-"));
  const identity = { configPath: join(directory, "gateway.json"), nativeHome: join(directory, "native"), codex: join(directory, "codex"), sdkSha256: "a".repeat(64),
    nativeSdkExecutable: join(directory, "signed-codex"), nativeSdkSha256: "b".repeat(64) };
  const home = executionHostHome(identity.configPath, identity.nativeHome); const path = join(home, "owner.json"); const nativePath = nativeHomeOwnerPath(identity.nativeHome);
  await mkdir(home, { recursive: true, mode: 0o700 }); await mkdir(dirname(nativePath), { recursive: true, mode: 0o700 });
  const native = { revision: "c".repeat(64), pid: 0, socketPath: join(home, "native.sock") };
  const owner: HostOwner = { version: 1, managed: executionHostMarker, ...identity, socketPath: join(home, "host.sock"), pid: 0, state: "stopped", generations: [], capabilities: ["native"], native };
  const lease: NativeHomeOwner = { version: 1, managed: "subscription-gateway-native-execution-owner", ...identity, hostPid: 0, pid: 0,
    socketPath: native.socketPath, state: "stopped", sdkState: "stopped", revision: native.revision };
  await writePrivateJson(path, owner); await writePrivateJson(nativePath, lease);
  return { directory, identity, home, path, nativePath, owner, lease, backup: join(directory, "backup"),
    cleanup: async () => { await rm(directory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); await rm(dirname(nativePath), { recursive: true, force: true }); } };
}

test("native rollback archives paired stopped receipts with exact original home and SDK identity", async () => {
  const f = await fixture();
  try {
    assert.equal(await archiveStoppedExecutionReceipt(f.identity, f.backup), join(f.backup, "execution-owner.json"));
    assert.deepEqual(JSON.parse(await readFile(join(f.backup, "native-execution-owner.json"), "utf8")), f.lease);
    await assert.rejects(readFile(f.path), { code: "ENOENT" }); await assert.rejects(readFile(f.nativePath), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("live or uncertain native ownership, changed identities, and changed socket paths block legacy fallback", async () => {
  const f = await fixture();
  try {
    for (const change of [
      { hostPid: process.pid, state: "running", sdkState: "idle" }, { pid: process.pid }, { sdkState: "starting" },
      { configPath: join(f.directory, "foreign.json") }, { nativeSdkSha256: "d".repeat(64) }, { socketPath: join(f.directory, "foreign.sock") },
    ]) {
      await writePrivateJson(f.nativePath, { ...f.lease, ...change });
      await assert.rejects(archiveStoppedExecutionReceipt(f.identity, f.backup));
      assert.ok(await readFile(f.path)); assert.ok(await readFile(f.nativePath));
    }
    await writePrivateJson(f.nativePath, f.lease);
    await writePrivateJson(f.path, { ...f.owner, native: { ...f.owner.native, pid: process.pid } });
    await assert.rejects(archiveStoppedExecutionReceipt(f.identity, f.backup), /native SDK writer/);
    assert.ok(await readFile(f.path)); assert.ok(await readFile(f.nativePath));
  } finally { await f.cleanup(); }
});

test("missing host proof cannot retire a surviving native-home receipt", async () => {
  const f = await fixture();
  try {
    await rm(f.path);
    await assert.rejects(archiveStoppedExecutionReceipt(f.identity, f.backup), /no matching host proof/);
    assert.ok(await readFile(f.nativePath));
  } finally { await f.cleanup(); }
});

const exitedPid = async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 5000)"], { stdio: "ignore" });
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; return child.pid!;
};

// B2: a host killed by SIGKILL, a crash or a reboot leaves its receipts marked running. Once its owner is proven gone (every pid it
// names is gone and nothing it advertised answers), those receipts must not block rollback for good.
test("rollback treats running receipts whose owners are proven gone as stopped", async () => {
  const f = await fixture();
  try {
    const dead = await exitedPid();
    await writePrivateJson(f.path, { ...f.owner, state: "running", pid: dead, native: { ...f.owner.native, pid: dead } });
    await writePrivateJson(f.nativePath, { ...f.lease, state: "running", sdkState: "running", hostPid: dead, pid: dead });
    assert.equal(await archiveStoppedExecutionReceipt(f.identity, f.backup), join(f.backup, "execution-owner.json"));
    assert.equal(JSON.parse(await readFile(join(f.backup, "execution-owner.json"), "utf8")).state, "running");
    assert.equal(JSON.parse(await readFile(join(f.backup, "native-execution-owner.json"), "utf8")).state, "running");
    await assert.rejects(readFile(f.path), { code: "ENOENT" }); await assert.rejects(readFile(f.nativePath), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("rollback still refuses a running receipt whose owner is alive, answers, or is still starting", async () => {
  const f = await fixture(); const server = createServer();
  try {
    const dead = await exitedPid();
    await writePrivateJson(f.path, { ...f.owner, state: "running", pid: process.pid }); // A live host.
    await assert.rejects(archiveStoppedExecutionReceipt(f.identity, f.backup), /fully stopped/);
    await writePrivateJson(f.path, { ...f.owner, state: "running", pid: dead }); // Its pid is gone, but its socket answers.
    server.listen(join(f.home, "host.sock")); await once(server, "listening"); await chmod(join(f.home, "host.sock"), 0o600);
    await assert.rejects(archiveStoppedExecutionReceipt(f.identity, f.backup), /fully stopped/);
    assert.ok(server.listening);
    await new Promise<void>(done => server.close(() => done()));
    await writePrivateJson(f.nativePath, { ...f.lease, state: "running", sdkState: "starting", hostPid: dead, pid: 0 }); // Inside its startup grace.
    await assert.rejects(archiveStoppedExecutionReceipt(f.identity, f.backup), /not fully stopped/);
    assert.ok(await readFile(f.path)); assert.ok(await readFile(f.nativePath));
  } finally { await new Promise<void>(done => server.listening ? server.close(() => done()) : done()); await f.cleanup(); }
});

const exists = (path: string) => lstat(path).then(() => true, () => false);
/** A rendezvous link at `path` as the SDK makes it: to its hashed target, which is left missing (a crashed listener's leftover) or served. */
async function sdkLink(path: string, serve = false): Promise<{ close(): Promise<void> }> {
  const target = await sdkSocketTarget(path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await chmod(dirname(target), 0o700);
  const server = createServer();
  if (serve) { server.listen(target); await once(server, "listening"); await chmod(target, 0o600); }
  await symlink(target, path);
  return { close: () => new Promise<void>(done => server.listening ? server.close(() => done()) : done()) };
}

// A crashed host is cleared the way its claim clears it: a generation it recorded without a socket identity is judged by what is
// found, and a link it never recorded goes too when nothing answers it. Before, rollback refused such a home for good.
test("rollback of a dead running host removes its unrecorded and identity-less links the way a claim does, and keeps an answering one", async () => {
  const f = await fixture(); const links: Array<{ close(): Promise<void> }> = [];
  try {
    const dead = await exitedPid(); const revision = "e".repeat(64);
    const recorded = join(f.home, `e-${revision.slice(0, 16)}.sock`); const unrecorded = join(f.home, `e-${"f".repeat(16)}.sock`);
    links.push(await sdkLink(recorded), await sdkLink(unrecorded));
    await writePrivateJson(f.path, { ...f.owner, state: "running", pid: dead, native: { ...f.owner.native, pid: dead }, generations: [{ revision, pid: dead, socketPath: recorded }] });
    await writePrivateJson(f.nativePath, { ...f.lease, state: "running", sdkState: "running", hostPid: dead, pid: dead });
    assert.equal(await archiveStoppedExecutionReceipt(f.identity, f.backup), join(f.backup, "execution-owner.json"));
    assert.equal(await exists(recorded), false, "the recorded generation link with no identity is gone");
    assert.equal(await exists(unrecorded), false, "and so is the link the dead host never recorded");
    await rm(f.backup, { recursive: true, force: true });
    // A link nobody recorded that still answers keeps its owner alive: the rollback refuses with both receipts in place.
    const answering = join(f.home, `e-${"a".repeat(16)}.sock`); links.push(await sdkLink(answering, true));
    await writePrivateJson(f.path, { ...f.owner, state: "running", pid: dead, native: { ...f.owner.native, pid: dead } });
    await writePrivateJson(f.nativePath, { ...f.lease, state: "running", sdkState: "running", hostPid: dead, pid: dead });
    await assert.rejects(archiveStoppedExecutionReceipt(f.identity, f.backup), /fully stopped/);
    assert.ok(await readFile(f.path)); assert.ok(await readFile(f.nativePath)); assert.equal(await exists(answering), true);
  } finally { for (const link of links) await link.close(); await f.cleanup(); }
});

test("rollback skips the native revision comparison only when both owners are proven dead", async () => {
  const f = await fixture();
  try {
    const dead = await exitedPid(); const other = "d".repeat(64);
    // The host died before it recorded the revision its SDK started: neither side can serve either one any more.
    await writePrivateJson(f.path, { ...f.owner, state: "running", pid: dead, native: { ...f.owner.native, pid: dead } });
    await writePrivateJson(f.nativePath, { ...f.lease, state: "running", sdkState: "running", hostPid: dead, pid: dead, revision: other });
    assert.equal(await archiveStoppedExecutionReceipt(f.identity, f.backup), join(f.backup, "execution-owner.json"));
    await rm(f.backup, { recursive: true, force: true });
    // A cleanly stopped native receipt still has to name the revision the dead host recorded.
    await writePrivateJson(f.path, { ...f.owner, state: "running", pid: dead, native: { ...f.owner.native, pid: dead } });
    await writePrivateJson(f.nativePath, { ...f.lease, revision: other });
    await assert.rejects(archiveStoppedExecutionReceipt(f.identity, f.backup), /still live or unconfirmed/);
    // And so does a dead native receipt behind a cleanly stopped host.
    await writePrivateJson(f.path, f.owner);
    await writePrivateJson(f.nativePath, { ...f.lease, state: "running", sdkState: "running", hostPid: dead, pid: dead, revision: other });
    await assert.rejects(archiveStoppedExecutionReceipt(f.identity, f.backup), /still live or unconfirmed/);
    assert.ok(await readFile(f.path)); assert.ok(await readFile(f.nativePath));
  } finally { await f.cleanup(); }
});

// X4: the native verdict is taken again under the native receipt's own lock. An owner that claimed the home after the first look
// (a desktop fallback, another configuration's host) must survive the rollback that looked first.
test("rollback judges the native receipt again under its lock, so an owner that took the home after the first look is kept", async () => {
  const f = await fixture(); const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await once(holder, "spawn"); const dead = await exitedPid();
    await writePrivateJson(f.path, { ...f.owner, state: "running", pid: dead, native: { ...f.owner.native, pid: dead } });
    await writePrivateJson(f.nativePath, { ...f.lease, state: "running", sdkState: "running", hostPid: dead, pid: dead });
    let rollback!: Promise<string>;
    await withPrivateFileLock(f.nativePath, async () => {
      rollback = archiveStoppedExecutionReceipt(f.identity, f.backup).then(() => "archived", (error: Error) => error.message);
      // The rollback holds the host receipt's lock only after its first look at the native receipt, which then said dead.
      while (!await exists(f.path + ".lock")) await new Promise(done => setTimeout(done, 5));
      await writePrivateJson(f.nativePath, { ...f.lease, state: "running", sdkState: "running", hostPid: holder.pid, pid: 0 });
    });
    assert.match(await rollback, /must be proven stopped/);
    assert.equal(JSON.parse(await readFile(f.nativePath, "utf8")).hostPid, holder.pid, "the new owner's receipt is in place");
    assert.ok(await readFile(f.path)); assert.equal(await exists(join(f.backup, "native-execution-owner.json")), false);
  } finally { holder.kill("SIGKILL"); await f.cleanup(); }
});

// B2 for a plan swap: a native-home receipt left running by a crash is released once its owner is proven gone, judged by boot
// and start like a claim, so a reused pid does not keep it, while a live or starting owner still does.
test("a plan swap releases a crashed native-home receipt, judged like a claim, and keeps a live or starting one", async () => {
  const f = await fixture(); const reused = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const boot = { id: "11111111-1111-4111-8111-111111111111", bootedAtMs: 1_700_000_000_000 };
  try {
    await once(reused, "spawn"); const dead = await exitedPid();
    setBootIdentityForTests(boot); setProcessStartReaderForTests(async pid => pid === reused.pid ? boot.bootedAtMs + 9000 : undefined);
    const release = () => archiveStoppedNativeHomeReceipt({ configPath: f.identity.configPath, nativeHome: f.identity.nativeHome }, f.backup);
    // Inside its startup grace, and with a live host: kept.
    await writePrivateJson(f.nativePath, { ...f.lease, state: "running", sdkState: "starting", hostPid: dead, pid: 0 });
    await assert.rejects(release(), /not fully stopped/);
    await writePrivateJson(f.nativePath, { ...f.lease, state: "running", sdkState: "idle", hostPid: reused.pid, pid: 0, bootId: boot.id, startedAtMs: boot.bootedAtMs + 9000 });
    await assert.rejects(release(), /not fully stopped/);
    // The same pid, now another process (another start): the owner is gone, so the receipt is released.
    await writePrivateJson(f.nativePath, { ...f.lease, state: "running", sdkState: "running", hostPid: reused.pid, pid: dead, bootId: boot.id, startedAtMs: boot.bootedAtMs + 1000 });
    assert.equal(await release(), join(f.backup, "native-execution-owner.json"));
    await assert.rejects(readFile(f.nativePath), { code: "ENOENT" });
  } finally { reused.kill("SIGKILL"); setBootIdentityForTests(); setProcessStartReaderForTests(); await f.cleanup(); }
});
