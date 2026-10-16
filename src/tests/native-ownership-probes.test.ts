import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ExecutionHostClient } from "../execution-host-client.js";
import { executionHostMarker, privateDirectory, setSdkSocketRootForTests, type HostIdentity } from "../execution-host-storage.js";
import { claimNativeHome, nativeHomeOwnerPath } from "../native-execution-host-storage.js";
import { setBootIdentityForTests, setProcessStartReaderForTests } from "../boot-identity.js";
import { writePrivateJson } from "../config.js";

// Regression tests made from the reviewer's probes hr-probes/p1.mjs (D2) and p4.mjs (D3). Both are safety rules: one native
// home never gets a second writer, and a live owner is never displaced. This file keeps every folder it uses (home, SDK
// rendezvous) in one short private folder of its own, and imports nothing the release before these fixes lacked.
const current = { id: "11111111-1111-4111-8111-111111111111", bootedAtMs: 1_700_000_000_000 };
let folder = ""; let home: string | undefined;
before(async () => {
  folder = await mkdtemp(join(process.env.GATEWAY_TEST_TMPDIR ?? (process.platform === "win32" ? tmpdir() : "/tmp"), "gwp-"));
  home = process.env.HOME; process.env.HOME = join(folder, "home"); await mkdir(process.env.HOME, { mode: 0o700 });
  setSdkSocketRootForTests(join(folder, "r"));
});
after(async () => {
  setSdkSocketRootForTests(); setBootIdentityForTests(); setProcessStartReaderForTests();
  if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
  await rm(folder, { recursive: true, force: true });
});
async function live(): Promise<{ child: ChildProcess; stop(): Promise<void> }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise(done => setTimeout(done, 50));
  return { child, stop: async () => { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } };
}

test("a private native writer is refused while a live shared host owns the native home, even with its SDK idle", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(folder, "p1-")); const host = await live();
  try {
    const started = current.bootedAtMs + 5000;
    setBootIdentityForTests(current); setProcessStartReaderForTests(async pid => pid === host.child.pid ? started : undefined);
    const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
    const path = nativeHomeOwnerPath(nativeHome); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // The host is running and owns the home; its SDK is idle, so the receipt names no SDK pid and nothing answers at its socket yet.
    await writePrivateJson(path, { version: 1, managed: "subscription-gateway-native-execution-owner", configPath: join(directory, "other-gateway.json"), nativeHome,
      codex: join(directory, "codex"), sdkSha256: "a".repeat(64), hostPid: host.child.pid, pid: 0, socketPath: join(directory, "hosthome", "native.sock"),
      state: "running", sdkState: "idle", bootId: current.id, startedAtMs: started });
    for (const configPath of [undefined, join(directory, "this-adapter.json")]) {
      await assert.rejects(ExecutionHostClient.assertNativeUnowned(configPath, nativeHome), /still owns this native home/, `configPath ${configPath ? "of another config" : "undefined"}`);
    }
  } finally { await host.stop(); setBootIdentityForTests(); setProcessStartReaderForTests(); }
});

test("a live owner of another configuration is never reclaimed through a receipt this release cannot validate", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(folder, "p4-")); const host = await live(); const server = createServer();
  try {
    setBootIdentityForTests(current);
    const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
    const homeA = join(directory, "hostA"); const homeB = join(directory, "hostB"); await privateDirectory(homeA); await privateDirectory(homeB);
    server.listen(join(homeB, "native.sock")); await once(server, "listening"); await chmod(join(homeB, "native.sock"), 0o600);
    const path = nativeHomeOwnerPath(nativeHome); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Config B's live owner, written by a newer release with an SDK state this release does not know.
    await writePrivateJson(path, { version: 1, managed: "subscription-gateway-native-execution-owner", configPath: join(directory, "b.json"), nativeHome, codex: join(directory, "codex"),
      sdkSha256: "a".repeat(64), hostPid: host.child.pid, pid: host.child.pid, socketPath: join(homeB, "native.sock"), state: "running", sdkState: "paused" });
    const written = await readFile(path, "utf8");
    const identity: HostIdentity = { version: 1, managed: executionHostMarker, configPath: join(directory, "a.json"), nativeHome, codex: join(directory, "codex"),
      sdkSha256: "a".repeat(64), socketPath: join(homeA, "host.sock"), capabilities: ["native"] };
    await assert.rejects(claimNativeHome(identity, homeA), /receipt is invalid/);
    assert.equal(await readFile(path, "utf8"), written, "the receipt still names config B, unchanged");
    assert.ok(server.listening, "and config B's native writer still serves");
  } finally { await new Promise<void>(done => server.listening ? server.close(() => done()) : done()); await host.stop(); setBootIdentityForTests(); }
});
