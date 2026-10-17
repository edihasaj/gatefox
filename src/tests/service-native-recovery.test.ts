import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { executionHostHome, executionHostMarker, type HostOwner } from "../execution-host-storage.js";
import { nativeHomeOwnerPath, type NativeHomeOwner } from "../native-execution-host-storage.js";
import { archiveStoppedExecutionReceipt } from "../service-execution-recovery.js";
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
