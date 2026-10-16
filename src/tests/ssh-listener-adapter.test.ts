import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { serveUnix } from "../unix-transport.js";
import { reuseSshSocket } from "../ssh-socket.js";
import { shimFiles } from "./shim-fixture.js";
import { shortFolder } from "./short-folder.js";

/** This checkout's dist laid out as installed release `version`, so a bootstrap run from it is the installed release. */
async function installedRelease(directory: string, version: string) {
  const pkg = join(directory, "releases", version, "package");
  await mkdir(pkg, { recursive: true });
  // A real copy: releaseState() resolves symlinks, so a linked dist could never report a release directory.
  await cp(fileURLToPath(new URL("../", import.meta.url)), join(pkg, "dist"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@edihasaj/harness-gateway", version, type: "module" }));
  await symlink(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(pkg, "node_modules"));
  const pending = join(directory, "current.pending");
  await symlink(join(directory, "releases", version), pending); await rename(pending, join(directory, "current"));
  return join(pkg, "dist", "cli.js");
}

/** Every event the state directory's telemetry recorded under `name` so far. */
async function recorded(stateDirectory: string, name: string) {
  const dir = join(stateDirectory, "telemetry");
  const files = await Promise.all((await readdir(dir).catch(() => [] as string[])).map(file => readFile(join(dir, file), "utf8").catch(() => "")));
  return files.join("").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } })
    .filter(event => event.event === name);
}

test("an SSH bootstrap that cannot bind leaves the old listener published, serving, and unreplaced", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await shimFiles(); const control = await shortFolder("gw-ssh-unsafe-");
  const path = join(control.directory, "app-server-control/app-server-control.sock"); const socketFolder = dirname(path);
  const stale = new AbortController();
  const serving = serveUnix(path, stale.signal, async (input, emit) => { for await (const chunk of input) await emit(JSON.parse(chunk.toString())); }, "0.4.0");
  serving.catch(() => {});
  try {
    for (let i = 0; i < 200 && !await lstat(path).then(() => true, () => false); i++) await delay(10);
    const cli = await installedRelease(control.directory, "0.4.2");
    const before = await lstat(path, { bigint: true });
    // The folder turns unsafe only after the old listener is up, so the 0.4.2 bootstrap decides to replace it and then fails its own bind.
    await chmod(socketFolder, 0o777);
    const reuse = await reuseSshSocket(path, { running: "0.4.2", installed: "0.4.2" });
    assert.equal(reuse.replace?.from, "0.4.0", "the bootstrap would replace the old listener");
    const child = spawn(process.execPath, [cli, "codex-shim", "--ssh", "--ssh-home", control.directory, "--config", f.config, "--codex", f.backend, "--", "app-server", "--listen", "unix://"],
      { env: f.env, stdio: "ignore" });
    const [code] = await once(child, "close");
    assert.notEqual(code, 0, "the bootstrap fails instead of serving from an unsafe folder");
    const after = await lstat(path, { bigint: true });
    assert.equal(after.isSocket(), true); assert.equal(String(after.ino), String(before.ino)); assert.equal(String(after.dev), String(before.dev), "the public alias is the old listener's, unchanged");
    const client = new WebSocket(`ws+unix://${path}:/rpc`);
    try {
      await once(client, "open");
      const reply = once(client, "message"); client.send('{"id":"old-still-answers"}');
      assert.equal(JSON.parse((await reply)[0].toString()).id, "old-still-answers", "the old listener still answers new connections");
    } finally { client.terminate(); }
    assert.equal(JSON.parse(await readFile(path + ".gateway-lease", "utf8")).release, "0.4.0", "the ownership record still names the old listener");
    assert.deepEqual(await recorded(f.value.stateDirectory, "ssh_listener_replaced"), [], "a bootstrap that replaced nothing logs nothing");
  } finally {
    await chmod(socketFolder, 0o700).catch(() => {});
    stale.abort(); await serving.catch(() => {}); f.close(); await control.remove();
  }
});
