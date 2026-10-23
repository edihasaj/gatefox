import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { writePrivateJson } from "../config.js";
import { executionHostHome, executionHostMarker, livePid, receiptPidAlive, sdkIdentity, type HostIdentity } from "../execution-host-storage.js";
import { claimNativeHome, claimPrivateNativeHome, nativeHomeOwnerPath, nativeHomeOwnership, nothingToJoin, privateNativeHolders, readNativeHomeOwner, setClaimMarkerWriteForTests, setPrivateMarkerRefreshForTests, type NativeHomeOwner } from "../native-execution-host-storage.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { until } from "./native-fallback-fixture.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

const roots = isolateExecutionRoots(); // Receipts and host homes stay in this file's folder, for this process and its children.
hostRunsInThisProcess(); // A receipt naming this process is a live owner here, as another process's receipt is in production.

const managed = "subscription-gateway-native-execution-owner";
const gone = { hostPid: 2 ** 22 + 7, pid: 2 ** 22 + 9 }; // Pids no process holds, from this boot.

/**
 * An adapter in a process of its own: it takes a private lease and records an engine, a `sleep` that stands in for the
 * native engine, as an adapter does right after its spawn. It can then be killed the way a crash kills it.
 */
const adapterScript = `const options = JSON.parse(process.argv[2]);
const { claimPrivateNativeHome, setPrivateMarkerRefreshForTests } = await import(options.storage);
if (options.refreshMs) setPrivateMarkerRefreshForTests(options.refreshMs);
const { spawn } = await import("node:child_process");
const lease = await claimPrivateNativeHome(options.identity, options.home);
const engine = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
await new Promise(done => engine.once("spawn", done));
await lease.engineStarted(engine.pid);
process.stdout.write(JSON.stringify({ engine: engine.pid, holders: lease.holders }) + "\\n");
setInterval(() => {}, 60000);
`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gw-private-shared-"));
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  const codex = join(directory, "codex"); await writeFile(codex, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const configPath = join(directory, "gateway.json"); const state = join(directory, "state"); configureTelemetry(state, "test");
  const home = executionHostHome(configPath, nativeHome); await mkdir(home, { recursive: true, mode: 0o700 });
  const identity = { configPath: resolve(configPath), nativeHome: resolve(nativeHome), codex };
  const host: HostIdentity = { version: 1, managed: executionHostMarker, ...identity, ...await sdkIdentity(codex), socketPath: join(home, "host.sock") };
  const receipt = nativeHomeOwnerPath(nativeHome); const script = join(directory, "adapter.mjs"); await writeFile(script, adapterScript);
  const children: ChildProcess[] = []; const engines: number[] = [];
  /** Starts an adapter process and waits for its lease and engine. */
  async function adapter(refreshMs?: number) {
    const isolated = roots.child(); const options = { storage: new URL("../native-execution-host-storage.js", import.meta.url).href, identity, home, refreshMs };
    const child = spawn(process.execPath, [...isolated.args, script, JSON.stringify(options)], { env: { ...process.env, ...isolated.env }, stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    // A child whose lease is refused exits with the error on stderr; that fails the test at once instead of at its timeout.
    const [line] = await Promise.race([once(createInterface({ input: child.stdout! }), "line") as Promise<[string]>,
      once(child, "exit").then(([code, signal]) => { throw new Error(`The adapter process exited before its lease (${code ?? signal})`); })]);
    const started = JSON.parse(line) as { engine: number; holders: number }; engines.push(started.engine);
    return { ...started, pid: child.pid!,
      /** A crash: the adapter and its engine are killed, and neither releases anything. */
      async kill() { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; process.kill(started.engine, "SIGKILL"); await until(() => !livePid(started.engine), "the engine exit"); } };
  }
  const holderFiles = async () => (await readdir(dirname(receipt))).filter(name => /^private-\d+-[a-f0-9-]{36}\.json$/.test(name)).sort();
  const reclaims = async () => { await flushTelemetry(); return (await readTelemetry(state, Date.now() - 600_000)).filter(event => event.event === "execution_owner_reclaimed").map(event => [event.scope, event.reason]); };
  return { directory, nativeHome, home, identity, host, receipt, adapter, holderFiles, reclaims,
    async clean() {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      for (const engine of engines) if (livePid(engine)) process.kill(engine, "SIGKILL");
      await rm(directory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); await rm(dirname(receipt), { recursive: true, force: true });
    } };
}

/**
 * What releases 0.4.5 and earlier make of `owner.json`, the only native-home receipt they read: the fields they require of
 * a receipt they accept, then whether a process it names is alive, by pid alone (0.4.3) or with its boot and start (0.4.4
 * and 0.4.5, whose native-home storage is the same).
 * Either release keeps its host's writer, and its own private engine, out while that holds.
 */
async function olderRelease(path: string): Promise<{ named: number[]; v043: boolean; v044: boolean }> {
  const owner = JSON.parse(await readFile(path, "utf8")); const mtimeMs = (await stat(path)).mtimeMs;
  assert.equal(owner.version, 1); assert.equal(owner.managed, managed); assert.equal(nativeHomeOwnerPath(owner.nativeHome), path);
  assert.ok(["running", "stopped"].includes(owner.state)); assert.ok(["idle", "starting", "running", "exited", "stopped"].includes(owner.sdkState));
  for (const key of ["configPath", "codex", "socketPath"]) assert.ok(typeof owner[key] === "string" && owner[key].startsWith("/"), key);
  for (const key of ["hostPid", "pid"]) assert.ok(Number.isSafeInteger(owner[key]) && owner[key] >= 0, key);
  assert.match(owner.sdkSha256, /^[a-f0-9]{64}$/); assert.match(owner.privateOwner.instanceId, /^[a-f0-9-]{36}$/);
  return { named: [owner.hostPid, owner.pid].filter(pid => pid > 0).sort((x, y) => x - y), v043: livePid(owner.hostPid) || livePid(owner.pid),
    v044: await receiptPidAlive({ pid: owner.hostPid, bootId: owner.bootId, startedAtMs: owner.startedAtMs }, mtimeMs)
      || await receiptPidAlive({ pid: owner.pid, bootId: owner.sdkBootId, startedAtMs: owner.sdkStartedAtMs }, mtimeMs) };
}

test("two adapters in two processes both hold private leases, the host's writer waits for both, and an older release still sees a live holder", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.adapter(); const b = await f.adapter();
    assert.deepEqual([a.holders, b.holders], [1, 2]); assert.equal(await privateNativeHolders(f.nativeHome, f.home), 2);
    const files = await f.holderFiles(); assert.equal(files.length, 2);
    const ids = new Map(files.map(name => [Number(name.split("-")[1]), name.slice(-41, -5)]));
    // owner.json names both engines, in the form older releases read.
    let older = await olderRelease(f.receipt);
    assert.deepEqual(older.named, [a.engine, b.engine].sort((x, y) => x - y)); assert.deepEqual([older.v043, older.v044], [true, true]);
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.privateOwner?.shared, true);
    // Private engines keep no other private engine out, so the shared marker reads as no exclusive owner.
    assert.equal(await nativeHomeOwnership(f.nativeHome, f.home), "absent");
    await assert.rejects(claimNativeHome(f.host, f.home), /already owns this native home/);
    // A third lease, in this process, joins them and leaves cleanly; owner.json still names the other two.
    const third = await claimPrivateNativeHome(f.identity, f.home); assert.equal(third.holders, 3); await third.release();
    assert.deepEqual((await olderRelease(f.receipt)).named, older.named); assert.equal((await f.holderFiles()).length, 2);
    // Adapter A crashes with its engine. owner.json still names B's engine, so an older release still keeps out.
    await a.kill();
    older = await olderRelease(f.receipt); assert.deepEqual([older.v043, older.v044], [true, true]);
    assert.equal(await privateNativeHolders(f.nativeHome, f.home), 1);
    await assert.rejects(claimNativeHome(f.host, f.home), /already owns this native home/);
    // B crashes too: nothing runs any more, so the host's writer takes the home and both dead receipts go to stale/.
    await b.kill();
    older = await olderRelease(f.receipt); assert.deepEqual([older.v043, older.v044], [false, false]);
    assert.equal(await privateNativeHolders(f.nativeHome, f.home), 0); assert.equal(await nativeHomeOwnership(f.nativeHome, f.home), "dead_pids");
    await claimNativeHome(f.host, f.home);
    const owner = await readNativeHomeOwner(f.nativeHome); assert.equal(owner?.hostPid, process.pid); assert.equal(owner?.privateOwner, undefined);
    assert.deepEqual(await f.holderFiles(), []);
    const stale = join(dirname(f.receipt), "stale"); const archived = await readdir(stale);
    assert.deepEqual(archived.map(name => name.replace(/-\d+\.json$/, "")), ["private", "private"]);
    const archivedIds = await Promise.all(archived.map(async name => JSON.parse(await readFile(join(stale, name), "utf8")).privateOwner.instanceId as string));
    assert.deepEqual(archivedIds.sort(), [ids.get(a.pid), ids.get(b.pid)].sort());
    assert.deepEqual(await f.reclaims(), [["native_home", "dead_pids"], ["native_home", "dead_pids"]]);
  } finally { await f.clean(); }
});

test("a private lease is refused while the host's native writer holds the home, and keeps the receipt a stopped host left", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const host = await claimNativeHome(f.host, f.home); const before = await readFile(f.receipt, "utf8");
    await assert.rejects(claimPrivateNativeHome(f.identity, f.home), /already owns this native home/);
    assert.equal(await readFile(f.receipt, "utf8"), before); assert.deepEqual(await f.holderFiles(), []);
    // The host stops: its receipt names nothing that runs, so a private lease may take the home and puts that receipt back.
    await host.publish(undefined, true); const stopped = await readFile(f.receipt, "utf8");
    const lease = await claimPrivateNativeHome(f.identity, f.home);
    assert.deepEqual((await readNativeHomeOwner(f.nativeHome))?.privateOwner?.previous, JSON.parse(stopped));
    await lease.release(); assert.equal(await readFile(f.receipt, "utf8"), stopped); assert.deepEqual(await f.holderFiles(), []);
    // A live private engine of another configuration is not one this lease can share the home with.
    const other = randomUUID();
    await writePrivateJson(join(dirname(f.receipt), `private-${process.pid}-${other}.json`), { version: 1, managed, ...f.identity, configPath: join(f.directory, "other.json"),
      sdkSha256: f.host.sdkSha256, socketPath: join(f.home, "native.sock"), hostPid: process.pid, pid: 0, state: "running", sdkState: "running", privateOwner: { instanceId: other } });
    await assert.rejects(claimPrivateNativeHome(f.identity, f.home), /already owns this native home/);
    assert.equal(await readFile(f.receipt, "utf8"), stopped);
  } finally { await f.clean(); }
});

test("dead private receipts are archived as owner.json is, keeping the newest five", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 7; index++) {
      const id = randomUUID();
      await writePrivateJson(join(dirname(f.receipt), `private-${gone.hostPid}-${id}.json`), { version: 1, managed, ...f.identity, sdkSha256: f.host.sdkSha256,
        socketPath: join(f.home, "native.sock"), ...gone, state: "running", sdkState: "running", privateOwner: { instanceId: id } });
    }
    assert.equal(await privateNativeHolders(f.nativeHome, f.home), 0);
    const lease = await claimPrivateNativeHome(f.identity, f.home); assert.equal(lease.holders, 1);
    assert.equal((await f.holderFiles()).length, 1);
    const archived = await readdir(join(dirname(f.receipt), "stale"));
    assert.equal(archived.length, 5); assert.ok(archived.every(name => /^private-\d+\.json$/.test(name)));
    assert.deepEqual(await f.reclaims(), Array.from({ length: 7 }, () => ["native_home", "dead_pids"]));
    await lease.release(); assert.equal(await readNativeHomeOwner(f.nativeHome), undefined); assert.deepEqual(await f.holderFiles(), []);
  } finally { await f.clean(); }
});

/** A private lease's receipt as the lease writes it, for one this test arranges by hand. */
const holderReceipt = (f: Awaited<ReturnType<typeof fixture>>, instanceId: string, fields: Record<string, unknown>) => ({ version: 1, managed, ...f.identity,
  sdkSha256: f.host.sdkSha256, socketPath: join(f.home, "native.sock"), pid: 0, state: "running", sdkState: "running", privateOwner: { instanceId }, ...fields });

test("a private receipt this release cannot read keeps the home while anything it may name could still run", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fixture(); const engine = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    await once(engine, "spawn");
    // A newer release's receipt: it fails validation, but still names a live process.
    const newer = join(dirname(f.receipt), `private-${engine.pid}-${randomUUID()}.json`); await mkdir(dirname(f.receipt), { recursive: true, mode: 0o700 });
    await writePrivateJson(newer, { version: 2, hostPid: engine.pid, pid: 0 });
    await assert.rejects(claimNativeHome(f.host, f.home), /already owns this native home/);
    await assert.rejects(claimPrivateNativeHome(f.identity, f.home), /already owns this native home/);
    assert.equal(await privateNativeHolders(f.nativeHome, f.home), 1);
    // An unparseable one names nothing: inside its ten-minute grace it is still an unconfirmed owner.
    await rm(newer); const garbled = join(dirname(f.receipt), `private-${engine.pid}-${randomUUID()}.json`); await writeFile(garbled, "{", { mode: 0o600 });
    await assert.rejects(claimNativeHome(f.host, f.home), /launch is unconfirmed/);
    await assert.rejects(claimPrivateNativeHome(f.identity, f.home), /already owns this native home/);
    assert.deepEqual((await f.holderFiles()).length, 1); assert.equal(await readNativeHomeOwner(f.nativeHome), undefined);
  } finally { engine.kill("SIGKILL"); await f.clean(); }
});

test("the host's claim judges a shared marker as older releases do, even with no private receipt beside it", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await claimPrivateNativeHome(f.identity, f.home); const marker = await readFile(f.receipt, "utf8");
    // The lease's own receipt is gone (removed by hand, say), but the marker still names this live process.
    for (const name of await f.holderFiles()) await rm(join(dirname(f.receipt), name));
    await assert.rejects(claimNativeHome(f.host, f.home), /already owns this native home/);
    assert.equal(await readFile(f.receipt, "utf8"), marker);
  } finally { await f.clean(); }
});

test("a shared marker another configuration keeps is not joined", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const other = join(f.directory, "other.json"); const instanceId = randomUUID();
    const marker = (fields: Record<string, unknown>) => writePrivateJson(f.receipt, { ...holderReceipt(f, instanceId, fields), configPath: other, privateOwner: { instanceId, shared: true } });
    await mkdir(dirname(f.receipt), { recursive: true, mode: 0o700 });
    // Its private engines still run (the marker names this live process) though none of their receipts is here.
    await marker({ hostPid: process.pid }); const live = await readFile(f.receipt, "utf8");
    await assert.rejects(claimPrivateNativeHome(f.identity, f.home), /already owns this native home/);
    assert.equal(await readFile(f.receipt, "utf8"), live);
    // Once they are gone it is still another configuration's home, not this one's to take.
    await marker(gone); const dead = await readFile(f.receipt, "utf8");
    await assert.rejects(claimPrivateNativeHome(f.identity, f.home), /ownership changed/);
    assert.equal(await readFile(f.receipt, "utf8"), dead); assert.deepEqual(await f.holderFiles(), []);
  } finally { await f.clean(); }
});

test("a release that fails can be retried, and its lease is not left behind", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fixture(); const holder = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    await once(holder, "spawn");
    const lease = await claimPrivateNativeHome(f.identity, f.home);
    // Another process holds the receipt's lock past the five seconds a release waits.
    const lock = `${f.receipt}.lock`; await writeFile(lock, String(holder.pid), { mode: 0o600 });
    await assert.rejects(lease.release(), /busy/);
    assert.equal((await f.holderFiles()).length, 1); assert.equal((await readNativeHomeOwner(f.nativeHome))?.privateOwner?.shared, true);
    await rm(lock); await lease.release();
    assert.deepEqual(await f.holderFiles(), []); assert.equal(await readNativeHomeOwner(f.nativeHome), undefined);
  } finally { holder.kill("SIGKILL"); await f.clean(); }
});

test("a lease looks again at the marker, so an older release sees a live holder after the named ones crash", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const holders = [await f.adapter(250), await f.adapter(250), await f.adapter(250)]; assert.equal(holders[2].holders, 3);
    // Both holders the marker names crash; the third, which it does not name, still runs.
    const named = (await olderRelease(f.receipt)).named; const crashed = holders.filter(holder => named.includes(holder.engine));
    const [left] = holders.filter(holder => !named.includes(holder.engine)); assert.equal(crashed.length, 2); assert.ok(left);
    for (const holder of crashed) await holder.kill();
    // The lease left archives the dead receipts and names itself alone: its adapter and its engine.
    const alone = [left.pid, left.engine].sort((x, y) => x - y);
    // A deadline of its own: each look runs `ps` for every process the receipts name, which a loaded machine slows down.
    for (const deadline = Date.now() + 20_000; JSON.stringify((await olderRelease(f.receipt)).named) !== JSON.stringify(alone);) {
      assert.ok(Date.now() < deadline, "the marker never named the live holder alone"); await new Promise(done => setTimeout(done, 50));
    }
    const older = await olderRelease(f.receipt); assert.deepEqual([older.v043, older.v044], [true, true]);
    assert.equal((await readNativeHomeOwner(f.nativeHome) as NativeHomeOwner).privateOwner?.shared, true); assert.equal((await f.holderFiles()).length, 1);
  } finally { await f.clean(); }
});

test("a lease that may only join private engines is refused, writing nothing, once none holds the home", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(claimPrivateNativeHome(f.identity, f.home, { joinOnly: true }), error => nothingToJoin(error) && /gateway host can take it/.test((error as Error).message));
    assert.equal(await readNativeHomeOwner(f.nativeHome), undefined); assert.deepEqual(await f.holderFiles(), []);
    // With a live private engine there, it joins.
    const first = await claimPrivateNativeHome(f.identity, f.home); const joined = await claimPrivateNativeHome(f.identity, f.home, { joinOnly: true });
    assert.equal(joined.holders, 2); await joined.release(); await first.release();
    assert.equal(await readNativeHomeOwner(f.nativeHome), undefined); assert.deepEqual(await f.holderFiles(), []);
  } finally { await f.clean(); }
});

test("a lease whose marker cannot be written takes its own receipt back, so the host is not kept out", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const first = await claimPrivateNativeHome(f.identity, f.home); const marker = await readFile(f.receipt, "utf8");
    setClaimMarkerWriteForTests(async () => { throw new Error("fixture disk is full"); });
    await assert.rejects(claimPrivateNativeHome(f.identity, f.home), /fixture disk is full/);
    setClaimMarkerWriteForTests();
    // Only the first lease's receipt is left, and the marker still names it alone.
    assert.equal((await f.holderFiles()).length, 1); assert.equal(await readFile(f.receipt, "utf8"), marker); assert.equal(await privateNativeHolders(f.nativeHome, f.home), 1);
    await first.release(); await claimNativeHome(f.host, f.home);
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.hostPid, process.pid);
  } finally { setClaimMarkerWriteForTests(); await f.clean(); }
});

test("a release that failed is retried by the lease's own timer until it succeeds", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fixture(); const holder = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    await once(holder, "spawn");
    setPrivateMarkerRefreshForTests(100); const lease = await claimPrivateNativeHome(f.identity, f.home); setPrivateMarkerRefreshForTests();
    // Another process holds the receipt's lock past the five seconds a release waits.
    const lock = `${f.receipt}.lock`; await writeFile(lock, String(holder.pid), { mode: 0o600 });
    await assert.rejects(lease.release(), /busy/); assert.equal((await f.holderFiles()).length, 1);
    // Nobody calls release again: the timer does, once the lock is free. A completed release is observable only when the
    // receipt is gone and the marker has been synced away too; the receipt's unlink is just the first of its steps, and
    // the marker is read here without the lock, so waiting for the receipt alone can see the step in between.
    await rm(lock);
    for (const deadline = Date.now() + 10_000; (await f.holderFiles()).length || await readNativeHomeOwner(f.nativeHome);) { assert.ok(Date.now() < deadline, "the timer never released the lease"); await new Promise(done => setTimeout(done, 50)); }
    assert.equal(await readNativeHomeOwner(f.nativeHome), undefined); assert.deepEqual(await f.holderFiles(), []);
  } finally { setPrivateMarkerRefreshForTests(); holder.kill("SIGKILL"); await f.clean(); }
});
