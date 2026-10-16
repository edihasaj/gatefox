import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { reuseSshSocket, sshControlHome } from "../ssh-socket.js";
import { shimFiles } from "./shim-fixture.js";
import { shortFolder } from "./short-folder.js";

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
    assert.equal(await reuseSshSocket(path), true);
    await promisify(execFile)(process.execPath, args, { env: f.env, timeout: 5000 });
    assert.equal(child.exitCode, null);
    child.kill("SIGKILL"); await exited;
    assert.equal(await reuseSshSocket(path), false);
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
    assert.equal(await reuseSshSocket(path), true);
    const info = await lstat(path, { bigint: true });
    const lease = JSON.parse(await readFile(path + ".gateway-lease", "utf8"));
    assert.equal(lease.inode, String(info.ino)); assert.equal(lease.device, String(info.dev));
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model = "native"\n');
  } finally { for (const child of children) child.kill("SIGTERM"); await Promise.all(exited); f.close(); await folder.remove(); }
});

test("SSH recovery refuses an unrecorded socket path", { skip: process.platform === "win32" }, async () => {
  const folder = await shortFolder("gw-ssh-foreign-"); const path = join(folder.directory, "rpc.sock");
  try {
    await writeFile(path, "keep-this");
    await assert.rejects(reuseSshSocket(path)); assert.equal(await readFile(path, "utf8"), "keep-this");
  } finally { await folder.remove(); }
});
