import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, writeFile, readFile, rename, mkdtemp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { unixSocketPath, serveUnix } from "../unix-transport.js";
import { shimFiles } from "./shim-fixture.js";
import { shortFolder } from "./short-folder.js";
import { withPrivateFileLock } from "../private-file-lock.js";
import { reuseSshSocket } from "../ssh-socket.js";
import { releaseState, watchForUpgrade } from "../self-update.js";

test("Unix addresses exclude network listeners, relative paths, and oversized socket names", () => {
  assert.throws(() => unixSocketPath("ws://0.0.0.0:80"));
  assert.throws(() => unixSocketPath("unix://relative.sock"));
  assert.throws(() => unixSocketPath("unix:///" + "a".repeat(104)));
  assert.equal(unixSocketPath("unix:///tmp/socket"), "/tmp/socket");
});

test("Unix readiness never exposes a socket before its ownership record", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const folder = await shortFolder("gw-publication-"); const dir = folder.directory; const path = join(dir, "rpc.sock");
  const controller = new AbortController(); let running: Promise<void> | undefined;
  try {
    await withPrivateFileLock(path + ".gateway-lease", async () => {
      running = serveUnix(path, controller.signal, async () => {});
      for (let i = 0; i < 100; i++) {
        if ((await readdir(dir)).some(name => name.startsWith(".gw-"))) break;
        await delay(10);
      }
      assert.ok((await readdir(dir)).some(name => name.startsWith(".gw-")));
      await assert.rejects(lstat(path), { code: "ENOENT" });
    });
    for (let i = 0; i < 100 && !await lstat(path).then(() => true, () => false); i++) await delay(10);
    const info = await lstat(path, { bigint: true });
    const lease = JSON.parse(await readFile(path + ".gateway-lease", "utf8"));
    assert.equal(lease.inode, String(info.ino)); assert.equal(lease.device, String(info.dev));
    assert.equal((await reuseSshSocket(path)).reused, true);
  } finally { controller.abort(); await running; await folder.remove(); }
});

test("serveUnix records the release it runs, or none when told to", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const leaseFor = async (release: string | null | undefined) => {
    const dir = await mkdtemp("/tmp/gw-lease-release-"); const path = join(dir, "rpc.sock");
    const controller = new AbortController(); const serving = serveUnix(path, controller.signal, async () => {}, release);
    try {
      for (let i = 0; i < 200 && !await lstat(path).then(() => true, () => false); i++) await delay(10);
      return JSON.parse(await readFile(path + ".gateway-lease", "utf8"));
    } finally { controller.abort(); await serving; }
  };
  const given = await leaseFor("0.4.2");
  assert.equal(given.release, "0.4.2");
  assert.deepEqual(Object.keys(given).sort(), ["boundPath", "device", "inode", "release"]);
  assert.ok(Buffer.byteLength(JSON.stringify(given, null, 2) + "\n") <= 4096, "the ownership record stays within the size readers allow");
  assert.equal("release" in await leaseFor(null), false, "a checkout run records no release");
  assert.equal((await leaseFor(undefined)).release, releaseState()?.running, "omitting it derives the running release");
});

/**
 * A listener running 0.4.1 with 0.4.2 installed, checked every 10ms, exactly as `codex-shim`
 * wires it. `busy` needs a client to open a session that lives as long as the connection.
 */
async function selfRetiringListener(busy: boolean) {
  const dir = await mkdtemp("/tmp/gw-retire-"); const path = join(dir, "rpc.sock");
  const controller = new AbortController(); let stopWatching = () => {};
  const session = async (_input: import("node:stream").Readable, _emit: (message: Record<string, unknown>) => Promise<void>, signal: AbortSignal) =>
    busy ? new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })) : Promise.resolve();
  const serving = serveUnix(path, controller.signal, session, null, listener => {
    stopWatching = watchForUpgrade("ssh_listener", () => listener.sessions() === 0, () => listener.retire(),
      { intervalMs: 10, state: () => ({ running: "0.4.1", installed: "0.4.2" }) });
  });
  for (let i = 0; i < 200 && !await lstat(path).then(() => true, () => false); i++) await delay(10);
  if (!await lstat(path).then(() => true, () => false)) { controller.abort(); await serving; throw new Error("Listener socket never appeared"); }
  return { directory: dir, path, done: serving, stop: async () => { stopWatching(); controller.abort(); await serving; } };
}

test("an idle listener retires itself after an install and a busy one does not", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const ended = async (serving: Promise<void>, within = 8000) => await Promise.race([serving.then(() => "ended" as const, () => "failed" as const), delay(within).then(() => "pending" as const)]);
  const idle = await selfRetiringListener(false);
  try {
    assert.equal(await ended(idle.done), "ended", "an idle listener finishes after retiring");
    await assert.rejects(lstat(idle.path), { code: "ENOENT" }, "the retired listener dropped its public alias");
    assert.deepEqual((await readdir(idle.directory)).filter(name => name.startsWith(".gw-")), [], "its bound socket is gone");
  } finally { await idle.stop(); }

  const busy = await selfRetiringListener(true); const client = new WebSocket(`ws+unix://${busy.path}:/rpc`);
  try {
    await once(client, "open");
    await delay(200);
    assert.equal((await lstat(busy.path)).isSocket(), true, "a listener with a running session keeps its alias");
    assert.equal(await ended(busy.done, 500), "pending", "a listener with a session keeps running");
    client.close(); await once(client, "close");
    assert.equal(await ended(busy.done), "ended", "it finishes once its session has");
    await assert.rejects(lstat(busy.path), { code: "ENOENT" }, "it retires once that session has finished");
  } finally { client.terminate(); await busy.stop(); }
});

test("Unix clients get combined models, isolated approvals, and disconnect recovery", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const fixture = await shimFiles(); const path = join(fixture.directory, "rpc.sock");
  const child = spawn(process.execPath, [fixture.cli, "codex-shim", "--config", fixture.config, "--codex", fixture.backend, "--", "app-server", "--listen", "unix://" + path], { env: fixture.env, stdio: ["ignore", "ignore", "ignore"] });
  const clients: WebSocket[] = [];
  try {
    for (let i = 0; i < 100; i++) { if (await lstat(path).then(() => true, () => false)) break; await delay(20); }
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    const open = async () => {
      const ws = new WebSocket(`ws+unix://${path}:/rpc`); clients.push(ws); await once(ws, "open");
      let id = 0; const pending = new Map<number, (value: Record<string, any>) => void>(); const events: Record<string, any>[] = [];
      ws.on("message", data => { const m = JSON.parse(data.toString()); if (typeof m.id === "number") pending.get(m.id)?.(m); else events.push(m); });
      const rpc = async (method: string, params = {}) => {
        const key = ++id; const reply = new Promise<Record<string, any>>(resolve => pending.set(key, resolve));
        ws.send(JSON.stringify({ id: key, method, params })); const m = await reply; pending.delete(key); assert.equal(m.error, undefined); return m.result;
      };
      await rpc("initialize", { clientInfo: { name: "unix-test", version: "1" } });
      return { ws, rpc, events };
    };
    const first = await open(); const second = await open();
    assert.deepEqual((await first.rpc("model/list")).data.map((m: { model: string }) => m.model), ["native", "claude/model"]);
    const a = await first.rpc("thread/start", { model: "claude/model" });
    const b = await second.rpc("thread/start", { model: "claude/model" }); assert.notEqual(a.thread.id, b.thread.id);
    const turn = first.rpc("turn/start", { threadId: a.thread.id, model: "claude/model", input: [] });
    for (let i = 0; i < 100 && !first.events.length; i++) await delay(10);
    const approval = first.events.find(e => e.method === "item/commandExecution/requestApproval");
    assert.ok(approval); assert.equal(second.events.some(e => e.method === approval.method), false);
    first.ws.send(JSON.stringify({ id: approval.id, result: { decision: "accept" } })); await turn;
    first.ws.close(); await once(first.ws, "close");
    assert.equal((await second.rpc("account/read")).account.email, "primary-test-account");
    const third = await open(); assert.equal((await third.rpc("model/list")).data.length, 2);
    assert.equal(await readFile(join(fixture.nativeHome, "config.toml"), "utf8"), 'model = "native"\n');
  } finally { for (const ws of clients) ws.terminate(); const exited = once(child, "close"); child.kill("SIGTERM"); await exited; fixture.close(); }
});

test("Unix startup refuses an occupied path without deleting its contents", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const fixture = await shimFiles(); const path = join(fixture.directory, "occupied.sock"); await writeFile(path, "keep-this");
  const child = spawn(process.execPath, [fixture.cli, "codex-shim", "--config", fixture.config, "--codex", fixture.backend, "--", "app-server", "--listen=unix://" + path], { env: fixture.env, stdio: "ignore" });
  try { await once(child, "close"); assert.equal(child.exitCode, 2); assert.equal(await readFile(path, "utf8"), "keep-this"); }
  finally { child.kill("SIGTERM"); fixture.close(); }
});

test("a replacement socket keeps old clients alive and survives old-listener shutdown", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-unix-lease-")); const path = join(dir, "rpc.sock");
  const first = new AbortController(); const second = new AbortController(); const clients: WebSocket[] = [];
  const echo = async (input: import("node:stream").Readable, emit: (message: Record<string, unknown>) => Promise<void>) => {
    for await (const chunk of input) await emit(JSON.parse(chunk.toString()));
  };
  const a = serveUnix(path, first.signal, echo);
  const ready = async () => { for (let i = 0; i < 100; i++) { if (await lstat(path).then(() => true, () => false)) return; await delay(10); } throw new Error("Socket not ready"); };
  const open = async () => { const ws = new WebSocket(`ws+unix://${path}:/rpc`); clients.push(ws); await once(ws, "open"); return ws; };
  let b: Promise<void> | undefined;
  try {
    await ready(); const old = await open(); await rename(path, join(dir, "old.sock"));
    b = serveUnix(path, second.signal, echo); await ready(); const fresh = await open();
    await delay(1100); const reply = once(old, "message"); old.send('{"id":"old-still-working"}'); assert.equal(JSON.parse((await reply)[0].toString()).id, "old-still-working");
    first.abort(); await a;
    assert.ok((await lstat(path)).isSocket()); const result = once(fresh, "message"); fresh.send('{"id":"new-still-working"}'); assert.equal(JSON.parse((await result)[0].toString()).id, "new-still-working");
  } finally { for (const ws of clients) ws.terminate(); first.abort(); second.abort(); await a; await b; }
});
