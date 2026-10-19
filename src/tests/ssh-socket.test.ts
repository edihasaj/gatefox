import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { reuseSshSocket, sshControlHome } from "../ssh-socket.js";
import { serveUnix } from "../unix-transport.js";
import { writePrivateJson } from "../config.js";
import { shimFiles } from "./shim-fixture.js";
import { shortFolder } from "./short-folder.js";

/** A live listener bound in a short private folder, recording `release` in its lease (none for `null`). */
async function ownedListener(release: string | null, folder?: { directory: string; remove: () => Promise<void> }) {
  folder ??= await shortFolder("gw-ssh-rel-");
  const directory = folder.directory;
  const path = join(directory, "app-server-control/app-server-control.sock");
  const controller = new AbortController();
  const serving = serveUnix(path, controller.signal,
    async (input, emit) => { for await (const chunk of input) await emit(JSON.parse(chunk.toString())); }, release);
  serving.catch(() => {});
  for (let i = 0; i < 200; i++) { if (await lstat(path).then(() => true, () => false)) break; await delay(10); }
  if (!await lstat(path).then(() => true, () => false)) { controller.abort(); await serving.finally(() => {}); await folder.remove(); throw new Error("Listener socket never appeared"); }
  const socketDirectory = join(directory, "app-server-control");
  return { folder, directory, socketDirectory, path, done: serving, stop: async () => { controller.abort(); await serving; } };
}

test("SSH control scope separates configs and native homes", () => {
  assert.equal(sshControlHome("/a/config", "/a/native"), sshControlHome("/a/config", "/a/native"));
  assert.notEqual(sshControlHome("/a/config", "/a/native"), sshControlHome("/b/config", "/a/native"));
  assert.notEqual(sshControlHome("/a/config", "/a/native"), sshControlHome("/a/config", "/b/native"));
});

test("SSH listeners reuse live sockets and recover their own crashed sockets without native IPC changes", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const f = await shimFiles(); const folder = await shortFolder("gw-ssh-test-"); const control = folder.directory;
  const nativeDirectory = join(f.nativeHome, "app-server-control"); await mkdir(nativeDirectory);
  const nativeSocket = join(nativeDirectory, "app-server-control.sock"); await writeFile(nativeSocket, "native-ipc-must-stay");
  const path = join(control, "app-server-control/app-server-control.sock");
  const args = [f.cli, "codex-shim", "--ssh", "--ssh-home", control, "--config", f.config, "--codex", f.backend, "--", "app-server", "--listen", "unix://"];
  const child = spawn(process.execPath, args, { env: f.env, stdio: "ignore" }); const exited = once(child, "close");
  try {
    for (let i = 0; i < 100; i++) { if (await lstat(path).then(() => true, () => false)) break; await delay(20); }
    assert.equal((await reuseSshSocket(path)).reused, true);
    await promisify(execFile)(process.execPath, args, { env: f.env, timeout: 5000 });
    assert.equal(child.exitCode, null);
    child.kill("SIGKILL"); await exited;
    assert.equal((await reuseSshSocket(path)).reused, false);
    await assert.rejects(lstat(path));
    assert.equal(await readFile(nativeSocket, "utf8"), "native-ipc-must-stay");
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model = "native"\n');
  } finally { child.kill("SIGTERM"); await exited; f.close(); await folder.remove(); }
});

test("SSH proxy redirects only its child control home and never needs gateway credentials", { skip: process.platform === "win32" }, async () => {
  const f = await shimFiles(); const reporter = join(f.directory, "proxy");
  await writeFile(reporter, '#!/usr/bin/env node\nconsole.log(process.env.CODEX_HOME)\n', { mode: 0o700 });
  try {
    const result = await promisify(execFile)(process.execPath, [f.cli, "codex-shim", "--ssh", "--ssh-home", "/tmp/gateway-proxy-home", "--config", "/absent.json", "--codex", reporter, "--", "app-server", "proxy"], { env: f.env });
    assert.equal(result.stdout.trim(), "/tmp/gateway-proxy-home");
    assert.equal(f.env.CODEX_HOME, f.nativeHome);
  } finally { f.close(); }
});

test("simultaneous SSH bootstraps retain one listener and a matching ownership record", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const f = await shimFiles(); const folder = await shortFolder("gw-ssh-race-"); const control = folder.directory;
  const path = join(control, "app-server-control/app-server-control.sock");
  const args = [f.cli, "codex-shim", "--ssh", "--ssh-home", control, "--config", f.config, "--codex", f.backend, "--", "app-server", "--listen", "unix://"];
  const children = [0, 1].map(() => spawn(process.execPath, args, { env: f.env, stdio: "ignore" }));
  const exited = children.map(child => once(child, "close"));
  try {
    for (let i = 0; i < 200 && children.every(child => child.exitCode === null); i++) await delay(20);
    assert.deepEqual(children.map(child => child.exitCode).sort(), [0, null]);
    assert.equal((await reuseSshSocket(path)).reused, true);
    const info = await lstat(path, { bigint: true });
    const lease = JSON.parse(await readFile(path + ".gateway-lease", "utf8"));
    assert.equal(lease.inode, String(info.ino)); assert.equal(lease.device, String(info.dev));
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model = "native"\n');
  } finally { for (const child of children) child.kill("SIGTERM"); await Promise.all(exited); f.close(); await folder.remove(); }
});

test("a bootstrap on the installed release decides to replace a listener whose lease records no release", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const listener = await ownedListener(null);
  const client = new WebSocket(`ws+unix://${listener.path}:/rpc`);
  try {
    await once(client, "open");
    const before = await lstat(listener.path, { bigint: true });
    const reuse = await reuseSshSocket(listener.path, { running: "0.4.2", installed: "0.4.2" });
    assert.equal(reuse.reused, false);
    assert.deepEqual(reuse.replace, { from: "unknown", to: "0.4.2", inode: String(before.ino), device: String(before.dev) }, "the bootstrap is told both releases and the alias to re-check before unlinking it");
    assert.deepEqual(Object.keys(reuse.replace ?? {}).sort(), ["device", "from", "inode", "to"], "no paths in the replacement decision");
    const kept = await lstat(listener.path, { bigint: true });
    assert.equal(kept.isSocket(), true); assert.equal(String(kept.ino), String(before.ino), "the decision unlinks nothing; the public alias stays put");
    assert.equal((await readdir(listener.socketDirectory)).filter(name => name.startsWith(".gw-")).length, 1, "the old bound socket was left alone");
    const latecomer = new WebSocket(`ws+unix://${listener.path}:/rpc`);
    await once(latecomer, "open"); latecomer.close(); await once(latecomer, "close");
    // The bootstrap carries the decision out only now, inside the publish lock right after its own bind.
    const fresh = new AbortController(); let replaced: boolean | undefined;
    const replacement = serveUnix(listener.path, fresh.signal,
      async (input, emit) => { for await (const chunk of input) await emit(JSON.parse(chunk.toString())); },
      "0.4.2", (_listener, swapped) => { replaced = swapped; }, reuse.replace!);
    replacement.catch(() => {});
    const oldInode = String(before.ino);
    const aliasInode = async () => String((await lstat(listener.path, { bigint: true }).catch(() => undefined))?.ino ?? "");
    try {
      // The alias exists from the first instant, so readiness here is the swap: wait for its inode to move.
      for (let i = 0; i < 200; i++) { if (replaced !== undefined && (await aliasInode()) !== oldInode) break; await delay(10); }
      assert.equal(replaced, true, "the replacement reports that it dropped the recorded alias");
      const swapped = await lstat(listener.path, { bigint: true });
      assert.equal(swapped.isSocket(), true); assert.notEqual(String(swapped.ino), oldInode, "the public alias now belongs to the replacement");
      assert.equal((await readdir(listener.socketDirectory)).filter(name => name.startsWith(".gw-")).length, 2, "both bound sockets are live while the old listener still has its session");
      await delay(1100);
      const reply = once(client, "message"); client.send('{"id":"old-session-still-works"}');
      assert.equal(JSON.parse((await reply)[0].toString()).id, "old-session-still-works", "the existing session keeps working");
      client.close(); await once(client, "close");
      const outcome = await Promise.race([listener.done.then(() => "ended" as const), delay(5000).then(() => "pending" as const)]);
      assert.equal(outcome, "ended", "the old listener ends once its last session closes");
      assert.equal((await readdir(listener.socketDirectory)).filter(name => name.startsWith(".gw-")).length, 1, "only the replacement's bound socket remains");
      assert.equal(String((await lstat(listener.path, { bigint: true })).ino), String(swapped.ino), "the old listener's shutdown left the replacement's alias alone");
    } finally { fresh.abort(); await replacement.catch(() => {}); }
  } finally { client.terminate(); await listener.stop(); await listener.folder.remove(); }
});

test("the bind-time swap leaves an alias that already moved on", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const listener = await ownedListener("0.4.0");
  try {
    const reuse = await reuseSshSocket(listener.path, { running: "0.4.2", installed: "0.4.2" });
    assert.ok(reuse.replace, "the older listener is to be replaced");
    await listener.stop();
    const raced = await ownedListener("0.4.2", listener.folder);
    try {
      const racedInode = await lstat(listener.path, { bigint: true });
      const late = new AbortController(); let replaced = false;
      try {
        await assert.rejects(serveUnix(listener.path, late.signal, async () => {}, "0.4.2", (_control, swapped) => { replaced = swapped; }, reuse.replace), /occupied/,
          "the stale decision no longer matches the alias, so the late bootstrap replaces nothing");
      } finally { late.abort(); }
      assert.equal(replaced, false, "the late bootstrap reports no replacement");
      const kept = await lstat(listener.path, { bigint: true });
      assert.equal(String(kept.ino), String(racedInode.ino)); assert.equal(String(kept.dev), String(racedInode.dev), "the raced listener's alias is unchanged");
      assert.equal((await reuseSshSocket(listener.path, { running: "0.4.2", installed: "0.4.2" })).reused, true, "the bootstrap keeps the current listener it raced");
    } finally { await raced.stop(); }
  } finally { await listener.folder.remove(); }
});

test("a bootstrap on the same release keeps the live listener and its alias", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const listener = await ownedListener("0.4.2");
  const client = new WebSocket(`ws+unix://${listener.path}:/rpc`);
  try {
    await once(client, "open");
    assert.equal(JSON.parse(await readFile(listener.path + ".gateway-lease", "utf8")).release, "0.4.2");
    const before = await lstat(listener.path, { bigint: true });
    assert.equal((await reuseSshSocket(listener.path, { running: "0.4.2", installed: "0.4.2" })).reused, true);
    const after = await lstat(listener.path, { bigint: true });
    assert.equal(after.isSocket(), true); assert.equal(String(after.ino), String(before.ino)); assert.equal(String(after.dev), String(before.dev));
  } finally { client.terminate(); await listener.stop(); await listener.folder.remove(); }
});

test("a bootstrap that is not the installed release leaves a newer listener alone", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const listener = await ownedListener("0.4.2");
  try {
    const before = await lstat(listener.path, { bigint: true });
    assert.equal((await reuseSshSocket(listener.path, { running: "0.4.1", installed: "0.4.2" })).reused, true);
    const after = await lstat(listener.path, { bigint: true });
    assert.equal(after.isSocket(), true); assert.equal(String(after.ino), String(before.ino));
    assert.equal((await readdir(listener.socketDirectory)).filter(name => name.startsWith(".gw-")).length, 1, "nothing was unlinked");
  } finally { await listener.stop(); await listener.folder.remove(); }
});

test("a checkout bootstrap reuses a live listener without comparing releases", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const listener = await ownedListener("0.4.2");
  try {
    const before = await lstat(listener.path, { bigint: true });
    assert.equal((await reuseSshSocket(listener.path, undefined)).reused, true);
    const after = await lstat(listener.path, { bigint: true });
    assert.equal(after.isSocket(), true); assert.equal(String(after.ino), String(before.ino));
  } finally { await listener.stop(); await listener.folder.remove(); }
});

test("an ownership record with a malformed release is rejected and its listener untouched", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  for (const bad of ["../x", "a".repeat(200), 7, false]) {
    const listener = await ownedListener("0.4.2");
    try {
      const lease = JSON.parse(await readFile(listener.path + ".gateway-lease", "utf8"));
      await writePrivateJson(listener.path + ".gateway-lease", { ...lease, release: bad });
      await assert.rejects(reuseSshSocket(listener.path, { running: "0.4.2", installed: "0.4.2" }), /SSH socket ownership record is invalid/);
      assert.equal((await lstat(listener.path, { bigint: true })).isSocket(), true);
    } finally { await listener.stop(); await listener.folder.remove(); }
  }
});

test("SSH recovery refuses an unrecorded socket path", { skip: process.platform === "win32" }, async () => {
  const folder = await shortFolder("gw-ssh-foreign-"); const path = join(folder.directory, "rpc.sock");
  try {
    await writeFile(path, "keep-this");
    await assert.rejects(reuseSshSocket(path)); assert.equal(await readFile(path, "utf8"), "keep-this");
  } finally { await folder.remove(); }
});
