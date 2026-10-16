import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, writeFile, readFile, rename, readdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "node:net";
import { WebSocket } from "ws";
import { unixSocketPath, serveUnix } from "../unix-transport.js";
import { shimFiles } from "./shim-fixture.js";
import { shortFolder } from "./short-folder.js";
import { withPrivateFileLock } from "../private-file-lock.js";
import { reuseSshSocket } from "../ssh-socket.js";
import { configureTelemetry, flushTelemetry, readTelemetry, telemetry } from "../telemetry.js";
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
    const folder = await shortFolder("gw-lease-release-"); const path = join(folder.directory, "rpc.sock");
    const controller = new AbortController(); const serving = serveUnix(path, controller.signal, async () => {}, release);
    try {
      for (let i = 0; i < 200 && !await lstat(path).then(() => true, () => false); i++) await delay(10);
      return JSON.parse(await readFile(path + ".gateway-lease", "utf8"));
    } finally { controller.abort(); await serving; await folder.remove(); }
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
  const folder = await shortFolder("gw-retire-"); const dir = folder.directory; const path = join(dir, "rpc.sock");
  const controller = new AbortController(); let stopWatching = () => {};
  const session = async (_input: import("node:stream").Readable, _emit: (message: Record<string, unknown>) => Promise<void>, signal: AbortSignal) =>
    busy ? new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })) : Promise.resolve();
  const serving = serveUnix(path, controller.signal, session, null, listener => {
    stopWatching = watchForUpgrade("ssh_listener", () => listener.sessions() === 0, () => listener.retire(),
      { intervalMs: 10, state: () => ({ running: "0.4.1", installed: "0.4.2" }) });
  });
  for (let i = 0; i < 200 && !await lstat(path).then(() => true, () => false); i++) await delay(10);
  if (!await lstat(path).then(() => true, () => false)) { controller.abort(); await serving; await folder.remove(); throw new Error("Listener socket never appeared"); }
  return { directory: dir, path, done: serving, stop: async () => { stopWatching(); controller.abort(); await serving; await folder.remove(); } };
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


/**
 * A bootstrap running 0.4.2 replaces the 0.4.1 listener, the way `codex-shim` does it: decide,
 * re-check that the decision still matches the live alias, bind a listener of its own, and drop
 * the old alias and log the replacement inside the publish lock. The old listener's upgrade
 * watcher then finds the alias gone. It must still retire, and quietly, so the move is logged
 * once by the bootstrap instead of twice.
 */
test("a listener replaced by a bootstrap retires without logging a self upgrade", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const folder = await shortFolder("gw-replaced-"); const dir = folder.directory; const path = join(dir, "rpc.sock");
  const state = join(dir, "state"); const started = Date.now(); configureTelemetry(state, "adapter");
  const stale = new AbortController(); const fresh = new AbortController();
  // What the watcher's retire attempts reported, and the release the watcher believes is
  // installed. Flipping it only when the bootstrap takes the alias keeps the watcher from
  // retiring the listener on an install of its own before the replacement ever happens.
  const attempts: boolean[] = []; let installed = "0.4.1"; let stopWatching = () => {};
  let replacement: Promise<void> | undefined;
  const serving = serveUnix(path, stale.signal, async () => {}, "0.4.1", listener => {
    stopWatching = watchForUpgrade("ssh_listener", () => listener.sessions() === 0, async () => {
      const retired = await listener.retire(); attempts.push(retired); return retired;
    }, { intervalMs: 10, state: () => ({ running: "0.4.1", installed }) });
  });
  const ready = async () => { for (let i = 0; i < 200; i++) { if (await lstat(path).then(() => true, () => false)) return; await delay(10); } throw new Error("Listener socket never appeared"); };
  try {
    await ready();
    const reuse = await reuseSshSocket(path, { running: "0.4.2", installed: "0.4.2" });
    assert.equal(reuse.reused, false, "a bootstrap on the installed release does not reuse another release's listener");
    assert.ok(reuse.replace); assert.deepEqual([reuse.replace.from, reuse.replace.to], ["0.4.1", "0.4.2"], "the decision names the releases on either side of the swap");
    const oldInode = String((await lstat(path, { bigint: true })).ino);
    replacement = serveUnix(path, fresh.signal, async () => {}, "0.4.2",
      (_listener, replaced) => { if (replaced) telemetry("ssh_listener_replaced", { from: reuse.replace!.from, to: reuse.replace!.to }); }, reuse.replace);
    // The alias exists from the first instant, so readiness here is the swap: wait for the alias inode to move.
    for (let i = 0; i < 200; i++) {
      const alias = await lstat(path, { bigint: true }).catch(() => undefined);
      if (alias && String(alias.ino) !== oldInode) break;
      await delay(10);
    }
    installed = "0.4.2";
    for (let i = 0; i < 100 && !attempts.length; i++) await delay(10);
    assert.ok(attempts.length, "the watcher retired the replaced listener through retire()");
    stopWatching();
    assert.ok(attempts.every(attempt => attempt === false), "retiring reports that another listener already owns the alias");
    assert.equal(await Promise.race([serving.then(() => "ended" as const, () => "failed" as const), delay(1500).then(() => "pending" as const)]), "ended",
      "a replaced listener stops on the watcher");
    assert.equal((await lstat(path)).isSocket(), true, "the retirement left the replacement's alias alone");
    assert.equal((await reuseSshSocket(path, { running: "0.4.2", installed: "0.4.2" })).reused, true, "the replacement owns it");
    await flushTelemetry(); const events = await readTelemetry(state, started);
    assert.deepEqual(events.filter(event => event.event === "ssh_listener_replaced").map(event => [event.from, event.to]), [["0.4.1", "0.4.2"]],
      "the replacement is logged exactly once, by the bootstrap that made it");
    assert.equal(events.some(event => event.event === "self_upgrade"), false, "the watcher logs no self upgrade for a move it did not make");
  } finally {
    stopWatching(); stale.abort(); fresh.abort();
    await Promise.allSettled([serving, replacement ?? Promise.resolve()]); await folder.remove();
  }
});


/** Echo every JSON frame back to the caller, so a test can tell which listener answered. */
const echoSession = async (input: import("node:stream").Readable, emit: (message: Record<string, unknown>) => Promise<void>) => {
  for await (const chunk of input) await emit(JSON.parse(chunk.toString()));
};

/** A live echo listener on a private socket in a short folder, recording `release` in its lease. */
async function ownedListener(release: string | null) {
  const folder = await shortFolder("gw-owned-"); const path = join(folder.directory, "rpc.sock");
  const controller = new AbortController();
  const serving = serveUnix(path, controller.signal, echoSession, release);
  serving.catch(() => {});
  for (let i = 0; i < 200 && !await lstat(path).then(() => true, () => false); i++) await delay(10);
  if (!await lstat(path).then(() => true, () => false)) { controller.abort(); await serving.catch(() => {}); await folder.remove(); throw new Error("Listener socket never appeared"); }
  return { folder, path, stop: async () => { controller.abort(); await serving.catch(() => {}); } };
}

/** One replacement serveUnix call settles with its error, ends with "ended", or is still "serving" after `within` ms. */
const swapOutcome = async (serving: Promise<void>, within = 4000): Promise<"serving" | "ended" | { error: unknown }> =>
  await Promise.race([serving.then(() => "ended" as const, (error: unknown) => ({ error }) as const), delay(within).then(() => "serving" as const)]);

test("two bootstraps racing to replace the same old listener produce one event and one live listener", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const listener = await ownedListener("0.4.1");
  const first = new AbortController(); const second = new AbortController();
  let firstReplaced = false; let secondReplaced = false; let swap1: Promise<void> | undefined; let swap2: Promise<void> | undefined;
  try {
    const reuse = await reuseSshSocket(listener.path, { running: "0.4.2", installed: "0.4.2" });
    assert.equal(reuse.reused, false); assert.ok(reuse.replace, "both bootstraps decide to replace the same old listener");
    swap1 = serveUnix(listener.path, first.signal, echoSession, "0.4.2", (_listener, replaced) => { if (replaced) firstReplaced = true; }, reuse.replace);
    swap2 = serveUnix(listener.path, second.signal, echoSession, "0.4.2", (_listener, replaced) => { if (replaced) secondReplaced = true; }, reuse.replace);
    // Both carry the same decision, but the publish lock only lets one find the old alias in place.
    const outcomes = await Promise.all([swapOutcome(swap1), swapOutcome(swap2)]);
    const errors = outcomes.filter(outcome => typeof outcome === "object");
    assert.equal(errors.length, 1, "exactly one bootstrap lost the swap");
    assert.match(String((errors[0] as { error: unknown }).error), /occupied/, "the loser reports it replaced nothing");
    assert.equal(outcomes.filter(outcome => outcome === "serving").length, 1, "the winner stays up and serves the alias");
    assert.equal([firstReplaced, secondReplaced].filter(Boolean).length, 1, "exactly one onListen reported the swap");
    const client = new WebSocket(`ws+unix://${listener.path}:/rpc`);
    try {
      await once(client, "open");
      const reply = once(client, "message"); client.send('{"id":"replacement-winner"}');
      assert.equal(JSON.parse((await reply)[0].toString()).id, "replacement-winner", "one live listener answers a connection on the alias");
    } finally { client.terminate(); }
    assert.equal(JSON.parse(await readFile(listener.path + ".gateway-lease", "utf8")).release, "0.4.2", "the winner owns the ownership record");
  } finally {
    first.abort(); second.abort();
    await Promise.allSettled([swap1, swap2, listener.stop()].filter(Boolean) as Promise<unknown>[]);
    await listener.folder.remove();
  }
});

test("replacing a listener never leaves the public alias missing for a client", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const listener = await ownedListener("0.4.0");
  const controllers: AbortController[] = []; const servings: Promise<void>[] = [];
  let polling = true; let missing = 0; let probes = 0;
  // A separate client that never stops looking for the alias, by path and by connecting to it.
  const poller = (async () => {
    while (polling) {
      if (await lstat(listener.path).then(() => false, error => error.code === "ENOENT")) missing++;
      await new Promise<void>(resolve => {
        const socket = connect(listener.path);
        socket.once("connect", () => { probes++; socket.destroy(); resolve(); });
        socket.once("error", error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") missing++; socket.destroy(); resolve(); });
      });
    }
  })();
  try {
    for (let i = 0; i < 15; i++) {
      const release = `0.5.${i}`;
      const before = await lstat(listener.path, { bigint: true });
      const reuse = await reuseSshSocket(listener.path, { running: release, installed: release });
      assert.ok(reuse.replace, `swap ${i} replaces the previous listener`);
      const controller = new AbortController(); controllers.push(controller);
      let replaced = false;
      const serving = serveUnix(listener.path, controller.signal, echoSession, release, (_control, swapped) => { replaced = swapped; }, reuse.replace);
      serving.catch(() => {}); servings.push(serving);
      for (let wait = 0; wait < 400 && !replaced; wait++) await delay(5);
      assert.equal(replaced, true, `swap ${i} completed`);
      const after = await lstat(listener.path, { bigint: true });
      assert.notEqual(String(after.ino), String(before.ino), `swap ${i} moved the alias to the new listener`);
    }
    polling = false; await poller;
    assert.equal(missing, 0, "no client ever found the alias missing during 15 swaps");
    assert.ok(probes > 15, "the poller kept connecting throughout");
    assert.equal(JSON.parse(await readFile(listener.path + ".gateway-lease", "utf8")).release, "0.5.14", "the last swap owns the ownership record");
    assert.deepEqual((await readdir(listener.folder.directory)).filter(name => name.endsWith(".alias")), [], "no staged link is left behind");
  } finally {
    polling = false; await poller;
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(servings); await listener.stop(); await listener.folder.remove();
  }
});

test("a failing directory check leaves the old alias untouched and the old listener serving", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const listener = await ownedListener("0.4.1");
  const bootstrap = new AbortController();
  try {
    const reuse = await reuseSshSocket(listener.path, { running: "0.4.2", installed: "0.4.2" });
    assert.ok(reuse.replace, "the bootstrap decided to replace the older listener");
    const before = await lstat(listener.path, { bigint: true });
    await chmod(listener.folder.directory, 0o777);
    await assert.rejects(serveUnix(listener.path, bootstrap.signal, async () => {}, "0.4.2", undefined, reuse.replace), /directory must be owned/);
    const after = await lstat(listener.path, { bigint: true });
    assert.equal(after.isSocket(), true); assert.equal(String(after.ino), String(before.ino), "the preparation failed before the publish lock, so the old alias was never touched");
    assert.equal((await readdir(listener.folder.directory)).filter(name => name.startsWith(".gw-")).length, 1, "the failed bootstrap left no bound socket behind");
    const client = new WebSocket(`ws+unix://${listener.path}:/rpc`);
    try {
      await once(client, "open");
      const reply = once(client, "message"); client.send('{"id":"old-still-serving"}');
      assert.equal(JSON.parse((await reply)[0].toString()).id, "old-still-serving", "the old listener still answers new connections");
      client.close(); await once(client, "close");
    } finally { client.terminate(); }
  } finally {
    await chmod(listener.folder.directory, 0o700);
    bootstrap.abort(); await listener.stop(); await listener.folder.remove();
  }
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
  const folder = await shortFolder("gateway-unix-lease-"); const dir = folder.directory; const path = join(dir, "rpc.sock");
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
  } finally { for (const ws of clients) ws.terminate(); first.abort(); second.abort(); await a; await b; await folder.remove(); }
});
