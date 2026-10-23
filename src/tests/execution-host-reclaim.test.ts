import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { claimHost, executionHostMarker, privateDirectory, removeOwnedSocket, sdkSocketTarget, setSdkSocketRootForTests, socketAnswers, socketIdentity, type HostIdentity } from "../execution-host-storage.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { setBootIdentityForTests, setProcessStartReaderForTests } from "../boot-identity.js";
import { writePrivateJson } from "../config.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

const roots = isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.

const current = { id: "11111111-1111-4111-8111-111111111111", bootedAtMs: 1_700_000_000_000 };
const earlier = "22222222-2222-4222-8222-222222222222";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gwt-claim-"));
  const root = join(directory, "r"); await mkdir(root, { mode: 0o700 }); setSdkSocketRootForTests(root);
  const home = join(directory, "host"); await privateDirectory(home);
  const socketPath = resolve(home, "host.sock");
  const identity: HostIdentity = { version: 1, managed: executionHostMarker, configPath: join(directory, "gateway.json"), nativeHome: join(directory, "native"),
    codex: join(directory, "codex"), sdkSha256: "a".repeat(64), socketPath, capabilities: ["gateway"] };
  configureTelemetry(join(directory, "state"), "test");
  // What a killed host leaves behind: its advertised link, and a protected socket nothing listens on.
  const deadLink = async (path: string) => {
    const target = await sdkSocketTarget(path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 }).catch(() => {});
    // Closing a server unlinks its socket, so only a listener that is killed leaves the file a dead host leaves.
    const child = spawn(process.execPath, ["-e", 'require("node:net").createServer().listen(process.argv[1], () => console.log("ready"))', target], { stdio: ["ignore", "pipe", "ignore"] });
    const exited = once(child, "exit"); await once(child.stdout!, "data"); child.kill("SIGKILL"); await exited;
    await chmod(target, 0o600); await symlink(target, path);
    return target;
  };
  // What a reboot leaves behind: the link, with the SDK folder it named already cleared away.
  const danglingLink = async (path: string) => {
    const target = await sdkSocketTarget(path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 }).catch(() => {});
    await symlink(target, path);
    return target;
  };
  const dropRoot = async () => { await rm(root, { recursive: true, force: true }); };
  // A process that ran and is gone: a real pid this boot could hand out again, never a made-up one that might be running.
  const exitedPid = async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 5000)"], { stdio: "ignore" });
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; return child.pid!;
  };
  const gone = await exitedPid();
  const receipt = async (fields: Record<string, unknown>) => writePrivateJson(join(home, "owner.json"),
    { pid: gone, state: "running", generations: [], bootId: current.id, startedAtMs: current.bootedAtMs + 2000, ...identity, ...fields });
  const reclaims = async () => { await flushTelemetry(); return (await readTelemetry(join(directory, "state"), current.bootedAtMs - 1000)).filter(event => event.event === "execution_owner_reclaimed"); };
  // A listener that keeps serving while the test looks at what a claim does around it.
  const listener = async (path: string) => { const server = createServer(); server.listen(path); await once(server, "listening"); await chmod(path, 0o600); return server; };
  return { directory, home, root, identity, socketPath, deadLink, danglingLink, dropRoot, receipt, reclaims, exitedPid, gone, listener,
    clean: async () => { roots.restore(); setBootIdentityForTests(); setProcessStartReaderForTests(); await rm(directory, { recursive: true, force: true }); } };
}

test("a rebooted machine clears the SDK folder and the next host still starts", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    const generation = { revision: "b".repeat(64), pid: await f.exitedPid(), socketPath: join(f.home, "e-bbbbbbbbbbbbbbbb.sock") };
    await f.danglingLink(generation.socketPath); await f.danglingLink(f.socketPath);
    await f.receipt({ bootId: earlier, generations: [generation] });
    await f.dropRoot(); // macOS cleared /tmp on boot; every recorded link now dangles.
    const owner = await claimHost(f.home, f.identity);
    assert.equal(owner.pid, process.pid); assert.equal(owner.state, "running"); assert.equal(owner.bootId, current.id);
    await assert.rejects(lstat(generation.socketPath), { code: "ENOENT" });
    const stale = await readdir(join(f.home, "stale"));
    assert.equal(stale.length, 1); assert.match(stale[0], /^owner-\d+\.json$/);
    assert.equal(JSON.parse(await readFile(join(f.home, "stale", stale[0]), "utf8")).bootId, earlier);
    assert.equal((await lstat(join(f.home, "stale"))).mode & 0o777, 0o700);
    assert.equal((await lstat(join(f.home, "stale", stale[0]))).mode & 0o777, 0o600);
    assert.deepEqual((await f.reclaims()).map(event => [event.scope, event.reason]), [["host", "previous_boot"]]);
  } finally { await f.clean(); }
});

test("a receipt written before the boot stamp is dead by its file time alone", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    await f.receipt({ bootId: undefined });
    const receipt = join(f.home, "owner.json");
    await utimes(receipt, new Date(current.bootedAtMs - 120_000), new Date(current.bootedAtMs - 120_000));
    assert.equal((await claimHost(f.home, f.identity)).pid, process.pid);
    assert.deepEqual((await f.reclaims()).map(event => event.reason), ["previous_boot"]);
  } finally { await f.clean(); }
});

test("a receipt naming this very process never blocks its own retry", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current); setProcessStartReaderForTests(async () => current.bootedAtMs + 1000);
    await f.receipt({ pid: process.pid, startedAtMs: current.bootedAtMs + 1000 });
    assert.equal((await claimHost(f.home, f.identity)).pid, process.pid);
    assert.deepEqual((await f.reclaims()).map(event => event.reason), ["dead_pids"]);
  } finally { await f.clean(); }
});

test("an app update that moved its engine still lets a dead host be replaced", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    await f.receipt({ codex: join(dirname(f.identity.codex), "Older.app", "codex"), sdkSha256: "b".repeat(64), nativeSdkExecutable: join(dirname(f.identity.codex), "Older.app", "engine"), nativeSdkSha256: "c".repeat(64) });
    assert.equal((await claimHost(f.home, f.identity)).codex, f.identity.codex);
    assert.deepEqual((await f.reclaims()).map(event => event.reason), ["dead_pids"]);
  } finally { await f.clean(); }
});

test("a garbled owner receipt is reclaimed while nothing it could name answers", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    await writeFile(join(f.home, "owner.json"), "{ this is not json", { mode: 0o600 });
    assert.equal((await claimHost(f.home, f.identity)).pid, process.pid);
    assert.equal((await readdir(join(f.home, "stale"))).length, 1);
    assert.deepEqual((await f.reclaims()).map(event => event.reason), ["invalid_receipt"]);
  } finally { await f.clean(); }
});

test("a garbled owner receipt with a live listener is refused and preserved", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture(); const server = createServer();
  try {
    setBootIdentityForTests(current);
    server.listen(f.socketPath); await once(server, "listening"); await chmod(f.socketPath, 0o600);
    await writeFile(join(f.home, "owner.json"), "{ this is not json", { mode: 0o600 });
    await assert.rejects(claimHost(f.home, f.identity), /receipt is invalid/);
    assert.ok(server.listening);
    assert.equal(await readFile(join(f.home, "owner.json"), "utf8"), "{ this is not json");
    assert.deepEqual(await f.reclaims(), []);
  } finally { server.close(); await f.clean(); }
});

test("a live host is never displaced, whatever its receipt says about its pid", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture(); const server = createServer();
  try {
    setBootIdentityForTests(current); setProcessStartReaderForTests(async () => current.bootedAtMs + 1000);
    server.listen(f.socketPath); await once(server, "listening"); await chmod(f.socketPath, 0o600);
    // A running host always records its socket, and that link answering is what keeps the owner alive here: its own pid is not.
    await f.receipt({ pid: process.pid, socket: await socketIdentity(f.socketPath) });
    await assert.rejects(claimHost(f.home, f.identity), /A live execution listener was preserved/);
    assert.ok(server.listening);
    await assert.rejects(claimHost(f.home, { ...f.identity, nativeHome: join(f.directory, "elsewhere") }), /identity changed/);
  } finally { server.close(); await f.clean(); }
});

test("a dead owner\'s unrecorded link is removed, and a foreign target is never touched", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    await f.danglingLink(f.socketPath);
    await f.receipt({ socket: undefined }); // Killed between publishing its pid and its socket identity.
    assert.equal((await claimHost(f.home, f.identity)).pid, process.pid);
    const unrelated = join(f.directory, "unrelated.sock"); await writeFile(unrelated, "preserve", { mode: 0o600 });
    await symlink(unrelated, f.socketPath);
    await f.receipt({ socket: undefined });
    await assert.rejects(claimHost(f.home, f.identity), /unrelated target/);
    assert.equal(await readFile(unrelated, "utf8"), "preserve");
  } finally { await f.clean(); }
});

test("an unrecorded live socket is refused on a clean start, and its identity is never guessed", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture(); const server = createServer();
  try {
    setBootIdentityForTests(current);
    server.listen(f.socketPath); await once(server, "listening"); await chmod(f.socketPath, 0o600);
    await assert.rejects(claimHost(f.home, f.identity), /belongs to another listener/);
    assert.ok(server.listening);
    const other = await claimHost(join(f.directory, "other"), { ...f.identity, socketPath: join(f.directory, "other", "host.sock") });
    assert.equal(other.socketPath, join(f.directory, "other", "host.sock"));
  } finally { server.close(); await f.clean(); }
});

test("reclaims keep the five newest receipts and a stopped handover records nothing", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    await f.receipt({ pid: 0, state: "stopped", bootId: current.id });
    assert.equal((await claimHost(f.home, f.identity)).pid, process.pid);
    assert.deepEqual(await f.reclaims(), []);
    assert.equal((await readdir(join(f.home, "stale")).catch(() => [] as string[])).length, 0);
    for (let attempt = 0; attempt < 7; attempt++) {
      await f.receipt({ bootId: earlier, pid: await f.exitedPid() });
      await claimHost(f.home, f.identity);
      assert.equal((await readdir(join(f.home, "stale"))).length, Math.min(attempt + 1, 5));
    }
    assert.equal((await f.reclaims()).length, 7);
    for (const name of await readdir(join(f.home, "stale"))) assert.match(await readlink(join(f.home, "stale", name)).catch(() => ""), /^$/);
  } finally { await f.clean(); }
});

test("recovery removes only what its receipt recorded once the SDK folder is missing", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    const target = await f.deadLink(f.socketPath);
    const identity = (await socketIdentity(f.socketPath))!; assert.ok(identity.targetInode);
    await f.dropRoot(); // The link is still there and its folder is not: that alone must read as stale.
    assert.equal(await socketAnswers(f.socketPath), false); // Nothing answers a connect through a folder that is gone.
    await removeOwnedSocket(f.socketPath, identity);
    await assert.rejects(lstat(f.socketPath), { code: "ENOENT" });
    await removeOwnedSocket(f.socketPath, identity); // Nothing is left: an unchanged alias is not an error.
    await mkdir(dirname(target), { mode: 0o700 });
    const alias = await claimHost(f.home, f.identity); // The claim recreates the folder it needs.
    assert.equal(alias.pid, process.pid);
    void target;
  } finally { await f.clean(); }
});

const close = (server: ReturnType<typeof createServer>) => new Promise<void>(done => server.listening ? server.close(() => done()) : done());

// L1: a link can be gone while the SDK socket it named still serves; liveness asks the target as well.
test("a generation whose link is gone but whose SDK socket still answers keeps its dead host's receipt", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture(); let server: ReturnType<typeof createServer> | undefined;
  try {
    setBootIdentityForTests(current);
    const link = join(f.home, "e-cccccccccccccccc.sock"); const target = await sdkSocketTarget(link);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 }); server = await f.listener(target);
    await f.receipt({ generations: [{ revision: "c".repeat(64), pid: await f.exitedPid(), socketPath: link }] });
    const written = await readFile(join(f.home, "owner.json"), "utf8");
    await assert.rejects(claimHost(f.home, f.identity));
    assert.ok(server.listening); assert.equal(await readFile(join(f.home, "owner.json"), "utf8"), written);
    assert.deepEqual(await f.reclaims(), []);
  } finally { if (server) await close(server); await f.clean(); }
});

// L6 (mutant M8) and L2: what answers in the home keeps a dead receipt, whether its processes are gone or from an earlier boot.
test("a listener nobody recorded in a dead host's home keeps the receipt, even one from an earlier boot", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture(); let server: ReturnType<typeof createServer> | undefined;
  try {
    setBootIdentityForTests(current);
    server = await f.listener(join(f.home, "native.sock")); // A native SDK the dead host started but never recorded.
    for (const fields of [{}, { bootId: earlier }, { bootId: undefined }]) {
      await f.receipt(fields);
      if (!("bootId" in fields) || fields.bootId === undefined) { const old = new Date(current.bootedAtMs - 120_000); await utimes(join(f.home, "owner.json"), old, old); }
      const written = await readFile(join(f.home, "owner.json"), "utf8");
      await assert.rejects(claimHost(f.home, f.identity), /already owns this configuration|live execution listener/);
      assert.ok(server.listening); assert.equal(await readFile(join(f.home, "owner.json"), "utf8"), written);
    }
    assert.deepEqual(await f.reclaims(), []);
    await close(server); server = undefined;
    assert.equal((await claimHost(f.home, f.identity)).pid, process.pid); // Nothing answers any more: the receipt is dead.
  } finally { if (server) await close(server); await f.clean(); }
});

// D8: an invalid receipt is judged by every link its home holds, generation links included, and its dead ones are removed.
test("an invalid receipt counts its generation links: a live one keeps it, a dead one is removed with it", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture(); let server: ReturnType<typeof createServer> | undefined;
  try {
    setBootIdentityForTests(current);
    const link = join(f.home, "e-dddddddddddddddd.sock"); await f.deadLink(link);
    const generation = join(f.home, "e-eeeeeeeeeeeeeeee.sock"); server = await f.listener(generation);
    await writeFile(join(f.home, "owner.json"), "{ garbled", { mode: 0o600 });
    await assert.rejects(claimHost(f.home, f.identity), /receipt is invalid/);
    assert.ok(server.listening); assert.equal(await readFile(join(f.home, "owner.json"), "utf8"), "{ garbled");
    await close(server); server = undefined; await rm(generation, { force: true });
    assert.equal((await claimHost(f.home, f.identity)).pid, process.pid);
    await assert.rejects(lstat(link), { code: "ENOENT" }); // Left in place it would block that generation for ever.
    assert.deepEqual((await f.reclaims()).map(event => event.reason), ["invalid_receipt"]);
  } finally { if (server) await close(server); await f.clean(); }
});

test("an invalid receipt that still names a live process is kept", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture(); const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    setBootIdentityForTests(current); setProcessStartReaderForTests(async () => undefined);
    // A newer release's receipt this one cannot validate, from a host that is still running.
    await f.receipt({ pid: holder.pid, startedAtMs: undefined, state: "draining" });
    await assert.rejects(claimHost(f.home, f.identity), /receipt is invalid/);
    assert.deepEqual(await f.reclaims(), []);
  } finally { const exited = once(holder, "exit"); holder.kill("SIGKILL"); await exited; await f.clean(); }
});

test("recovery preserves a live generation beyond the eighth entry of a large invalid receipt", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture(); const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    setBootIdentityForTests(current); setProcessStartReaderForTests(async () => undefined);
    const generations = [...Array.from({ length: 8 }, () => ({ pid: f.gone })), { pid: holder.pid }];
    await f.receipt({ state: "draining", generations, padding: "x".repeat(70 * 1024) });
    await assert.rejects(claimHost(f.home, f.identity), /receipt is invalid/);
    assert.deepEqual(await f.reclaims(), []);
    assert.equal(JSON.parse(await readFile(join(f.home, "owner.json"), "utf8")).generations[8].pid, holder.pid);
  } finally { const exited = once(holder, "exit"); holder.kill("SIGKILL"); await exited; await f.clean(); }
});

// L4: archiving reads only a plain file; anything else is moved aside whole, never followed, never read.
test("a receipt that is a link or a pipe is moved aside as it is, and what it names is untouched", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    const elsewhere = join(f.directory, "elsewhere.json"); await writeFile(elsewhere, "keep me", { mode: 0o600 });
    await symlink(elsewhere, join(f.home, "owner.json"));
    assert.equal((await claimHost(f.home, f.identity)).pid, process.pid);
    const [linked] = await readdir(join(f.home, "stale"));
    assert.ok((await lstat(join(f.home, "stale", linked))).isSymbolicLink()); assert.equal(await readFile(elsewhere, "utf8"), "keep me");
    await rm(join(f.home, "owner.json"));
    await new Promise<void>((done, failed) => execFile("/usr/bin/mkfifo", ["-m", "600", join(f.home, "owner.json")], error => error ? failed(error) : done()));
    assert.equal((await claimHost(f.home, f.identity)).pid, process.pid); // Reading a pipe with no writer would wait for ever.
    const pipes = [];
    for (const name of await readdir(join(f.home, "stale"))) if ((await lstat(join(f.home, "stale", name))).isFIFO()) pipes.push(name);
    assert.equal(pipes.length, 1);
  } finally { await f.clean(); }
});

// What the reported reboot left: the advertised link, a recorded device number the machine no longer uses, and the SDK folder gone.
async function driftedLinkReceipt(f: Awaited<ReturnType<typeof fixture>>, bootId: string) {
  await f.danglingLink(f.socketPath);
  const info = await lstat(f.socketPath);
  await f.receipt({ bootId, socket: { inode: String(info.ino), device: String(info.dev + 1), targetPath: await sdkSocketTarget(f.socketPath) } });
}

test("a rebooted machine reclaims a dangling SDK link whose recorded device number changed", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    await driftedLinkReceipt(f, earlier); await f.dropRoot();
    const owner = await claimHost(f.home, f.identity);
    assert.equal(owner.pid, process.pid); assert.equal(owner.bootId, current.id);
    await assert.rejects(lstat(f.socketPath), { code: "ENOENT" });
    assert.deepEqual((await f.reclaims()).map(event => event.reason), ["previous_boot"]);
  } finally { await f.clean(); }
});

test("the same device mismatch within the current boot is refused and preserved", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    setBootIdentityForTests(current);
    await driftedLinkReceipt(f, current.id);
    await assert.rejects(claimHost(f.home, f.identity), /another listener/);
    assert.ok((await lstat(f.socketPath)).isSymbolicLink());
    assert.deepEqual(await f.reclaims(), []);
  } finally { await f.clean(); }
});
