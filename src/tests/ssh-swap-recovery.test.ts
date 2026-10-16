import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { chmod, link, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { serveUnix } from "../unix-transport.js";
import { isManagedSshSocket, reuseSshSocket, sweepSshLeftovers } from "../ssh-socket.js";
import { writePrivateJson } from "../config.js";
import { shortFolder } from "./short-folder.js";

type Folder = Awaited<ReturnType<typeof shortFolder>>;
const echo = async (input: AsyncIterable<unknown>, emit: (message: never) => Promise<void>) => { for await (const chunk of input) await emit(JSON.parse(String(chunk)) as never); };
const installed = { running: "0.5.0", installed: "0.5.0" };
const exists = (path: string) => lstat(path).then(() => true, () => false);
const read = (path: string) => readFile(path, "utf8").catch(() => undefined);
const inodeOf = async (path: string) => { const info = await lstat(path, { bigint: true }); return `${info.dev}:${info.ino}`; };
const names = async (directory: string, prefix: string) => (await readdir(directory)).filter(name => name.startsWith(prefix)).sort();

// Fault injection into the real fs/promises, the way the publish sees it: the rename of the staged alias,
// and the temporary file a private record is written through.
type Fs = { rename: (from: string, to: string) => Promise<void>; open: (...args: unknown[]) => Promise<unknown> };
const fsp = createRequire(import.meta.url)("fs/promises") as unknown as Fs;
const real = { rename: fsp.rename, open: fsp.open };
const fault = { rename: false, record: "off" as "off" | "all" | "after-first" }; let recordOpens = 0;
fsp.rename = async (from, to) => {
  if (fault.rename && String(from).endsWith(".alias")) throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
  return real.rename(from, to);
};
fsp.open = async (...args) => {
  const path = String(args[0]);
  if (fault.record !== "off" && path.includes(".gateway-lease.") && path.endsWith(".tmp") && (fault.record === "all" || recordOpens++ > 0)) throw Object.assign(new Error("injected record failure"), { code: "ENOSPC" });
  return real.open(...args);
};
// A liveness probe whose answer is unknown (not "refused", not "connected"): the paths listed here fail with EAGAIN.
const net = createRequire(import.meta.url)("net") as unknown as { connect: (...args: unknown[]) => unknown; Socket: new () => { emit: (name: string, error: Error) => void } };
const realConnect = net.connect; const unknownAnswer = new Set<string>();
net.connect = (...args) => {
  if (!unknownAnswer.has(String(args[0]))) return realConnect(...args);
  const socket = new net.Socket(); process.nextTick(() => socket.emit("error", Object.assign(new Error("injected probe failure"), { code: "EAGAIN" })));
  return socket;
};
syncBuiltinESMExports();
const heal = () => { fault.rename = false; fault.record = "off"; recordOpens = 0; };
// A test that times out never reaches its own finally; reset injected faults after every test regardless.
test.afterEach(() => { heal(); unknownAnswer.clear(); });

/** A live listener published at `path` (default: the folder's usual alias). */
async function listener(folder: Folder, release: string, file = "app-server-control.sock", sub = "c") {
  const path = join(folder.directory, sub, file); const controller = new AbortController();
  const done = serveUnix(path, controller.signal, echo as never, release); done.catch(() => {});
  for (let i = 0; i < 300 && !await exists(path); i++) await delay(10);
  assert.ok(await exists(path), "the listener published its alias");
  return { path, stop: async () => { controller.abort(); await done.catch(() => {}); } };
}

/** Whether a client reaching `path` gets its own message back. */
async function answers(path: string) {
  const client = new WebSocket(`ws+unix://${path}:/rpc`);
  try {
    await once(client, "open"); const reply = once(client, "message"); client.send('{"id":"still-here"}');
    return JSON.parse((await reply)[0].toString()).id === "still-here";
  } catch { return false; } finally { client.terminate(); }
}

/** A dead socket: the inode of a closed listener, kept alive under `names` (all hard links). */
async function deadSocket(folder: Folder, linkNames: string[], mode = 0o600) {
  const scratch = join(folder.directory, `s${Math.random().toString(16).slice(2, 8)}`); const server = createServer();
  server.listen(scratch); await once(server, "listening"); await chmod(scratch, mode);
  for (const name of linkNames) await link(scratch, name);
  server.close(); await once(server, "close");
}

/** A live socket listening at `path`, standing in for a listener that is still running. */
async function liveSocket(path: string): Promise<Server> {
  const server = createServer(socket => socket.destroy()); server.listen(path); await once(server, "listening"); await chmod(path, 0o600); return server;
}

const closeServer = async (server: Server) => { server.close(); await once(server, "close").catch(() => {}); };

// ---------------------------------------------------------------- D1: a crash during the swap

const crashChild = `
import { createRequire, syncBuiltinESMExports } from "node:module";
const fsp = createRequire(import.meta.url)("fs/promises"); const realRename = fsp.rename;
fsp.rename = async (from, to) => { if (String(from).endsWith(".alias")) { console.log("stuck"); return new Promise(() => {}); } return realRename(from, to); };
syncBuiltinESMExports();
const [dist, path, release] = process.argv.slice(2);
const { serveUnix } = await import(dist + "unix-transport.js");
const { reuseSshSocket } = await import(dist + "ssh-socket.js");
const reuse = await reuseSshSocket(path, { running: release, installed: release });
serveUnix(path, new AbortController().signal, async () => {}, release, undefined, reuse.replace);
`;

/** An old 0.4.0 listener, and a 0.5.0 bootstrap killed between its record write and its rename. */
async function interruptedSwap(decide = false) {
  const folder = await shortFolder("gw-swap-"); const old = await listener(folder, "0.4.0");
  // A later bootstrap inspected the live listener before the crash and decided to replace it (the decision is taken, nothing is done yet).
  const reuse = decide ? await reuseSshSocket(old.path, installed) : undefined;
  if (decide) assert.equal(reuse?.replace?.from, "0.4.0", "the bootstrap decided to replace the live listener");
  const script = join(folder.directory, "crash-child.mjs"); await writeFile(script, crashChild);
  const leaseBefore = (await read(old.path + ".gateway-lease"))!; const oldInode = await inodeOf(old.path);
  const dist = pathToFileURL(fileURLToPath(new URL("../", import.meta.url))).href;
  const child = spawn(process.execPath, [script, dist, old.path, "0.5.0"], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = once(child, "close");
  const stuck = await Promise.race([once(child.stdout!, "data").then(([chunk]) => String(chunk).includes("stuck")), delay(15000).then(() => false)]);
  child.kill("SIGKILL"); await exited;
  assert.ok(stuck, "the bootstrap reached the point between the record write and the rename");
  return { folder, old, leaseBefore, oldInode, reuse, dir: join(folder.directory, "c") };
}

for (const [label, state, expected] of [
  ["an installed-release bootstrap", installed, "replace"],
  ["a same-release bootstrap", { running: "0.4.0", installed: "0.5.0" }, "reused"],
] as const) {
  test(`after a bootstrap was killed between its record write and its rename, ${label} still gets a decision`, { skip: process.platform === "win32", timeout: 30000 }, async () => {
    const swap = await interruptedSwap();
    try {
      const stuckLease = JSON.parse((await read(swap.old.path + ".gateway-lease"))!);
      assert.notEqual(`${stuckLease.device}:${stuckLease.inode}`, swap.oldInode, "the crash left the record naming the dead new listener");
      assert.equal(stuckLease.release, "0.5.0"); assert.equal(stuckLease.previous.release, "0.4.0", "the record carries the displaced listener's record");
      assert.equal(await inodeOf(swap.old.path), swap.oldInode, "the alias is still the old listener's");
      assert.ok((await names(swap.dir, ".gw-")).some(name => name.endsWith(".alias")), "the staged link was left behind");
      assert.ok(await answers(swap.old.path), "the old listener answers before the repair");

      const reuse = await reuseSshSocket(swap.old.path, state);
      if (expected === "replace") assert.deepEqual([reuse.reused, reuse.replace?.from, reuse.replace?.inode], [false, "0.4.0", swap.oldInode.split(":")[1]]);
      else assert.deepEqual(reuse, { reused: true });

      assert.equal(await read(swap.old.path + ".gateway-lease"), swap.leaseBefore, "the record is the old listener's again, byte for byte");
      assert.equal(await inodeOf(swap.old.path), swap.oldInode); assert.ok(await answers(swap.old.path), "the old listener answers after the repair");
      assert.deepEqual((await names(swap.dir, ".gw-")).filter(name => name.endsWith(".alias")), [], "the staged link is gone");
      assert.equal((await names(swap.dir, ".gw-")).length, 1, "only the old listener's bound socket remains; the dead new one is removed");
      assert.deepEqual((await reuseSshSocket(swap.old.path, state)).reused, expected === "reused", "and the next bootstrap decides the same way");
    } finally { await swap.old.stop(); await swap.folder.remove(); }
  });
}

test("a record that cannot be put back keeps the staged link, and the next bootstrap repairs the swap", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const folder = await shortFolder("gw-swap-"); const old = await listener(folder, "0.4.0"); const dir = join(folder.directory, "c");
  try {
    const leaseBefore = (await read(old.path + ".gateway-lease"))!; const reuse = await reuseSshSocket(old.path, installed);
    assert.ok(reuse.replace);
    // The new record is written (the first temporary file), then the rename fails and the old record cannot be written back.
    fault.rename = true; fault.record = "after-first";
    await assert.rejects(serveUnix(old.path, new AbortController().signal, echo as never, "0.5.0", undefined, reuse.replace), /injected rename failure/);
    heal();
    assert.notEqual(await read(old.path + ".gateway-lease"), leaseBefore, "the record still names the listener that never published");
    assert.deepEqual((await names(dir, ".gw-")).filter(name => name.endsWith(".alias")).length, 1, "the staged link stays: it is the mark of the half-finished swap");
    assert.ok(await answers(old.path));
    const next = await reuseSshSocket(old.path, installed);
    assert.equal(next.replace?.from, "0.4.0", "the next bootstrap decides to replace rather than throwing");
    assert.equal(await read(old.path + ".gateway-lease"), leaseBefore); assert.equal((await names(dir, ".gw-")).length, 1);
  } finally { heal(); await old.stop(); await folder.remove(); }
});

test("the repair never removes a new listener's socket that still answers", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const folder = await shortFolder("gw-swap-"); const old = await listener(folder, "0.4.0"); const dir = join(folder.directory, "c");
  const bound = join(dir, ".gw-123456abcdef"); let live: Server | undefined;
  try {
    const leaseBefore = JSON.parse((await read(old.path + ".gateway-lease"))!);
    live = await liveSocket(bound); await link(bound, bound + ".alias"); const newest = await lstat(bound, { bigint: true });
    await writePrivateJson(old.path + ".gateway-lease", { inode: String(newest.ino), device: String(newest.dev), boundPath: bound, release: "0.5.0", previous: leaseBefore });
    assert.equal((await reuseSshSocket(old.path, installed)).replace?.from, "0.4.0");
    assert.ok(await exists(bound), "an answering socket is left alone"); assert.equal(await exists(bound + ".alias"), false, "the staged link is dropped");
    assert.deepEqual(JSON.parse((await read(old.path + ".gateway-lease"))!), leaseBefore);
  } finally { if (live) await closeServer(live); await old.stop(); await folder.remove(); }
});

test("a record naming another listener is still refused when there is no staged link to show an interrupted swap", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const folder = await shortFolder("gw-swap-"); const old = await listener(folder, "0.4.0"); const dir = join(folder.directory, "c");
  try {
    const leaseBefore = JSON.parse((await read(old.path + ".gateway-lease"))!);
    await writePrivateJson(old.path + ".gateway-lease", { inode: "1", device: "2", boundPath: join(dir, ".gw-123456abcdef"), release: "0.5.0", previous: leaseBefore });
    await assert.rejects(reuseSshSocket(old.path, installed), /belongs to another listener/);
    assert.ok(await answers(old.path), "the old listener is untouched");
  } finally { await old.stop(); await folder.remove(); }
});

// ---------------------------------------------------------------- D5: a publish repairs a crashed swap before it sweeps

/** The listener behind `swap` publishes with a replacement decided before the crash, and `inject` fails. */
async function publishOverCrash(inject: "rename" | "record-all" | "record-after-repair") {
  const swap = await interruptedSwap(true); const path = swap.old.path;
  try {
    const stuck = (await read(path + ".gateway-lease"))!; assert.notEqual(stuck, swap.leaseBefore, "the crash left the record naming the dead new listener");
    if (inject === "rename") fault.rename = true; else fault.record = inject === "record-all" ? "all" : "after-first";
    const failure = await serveUnix(path, new AbortController().signal, echo as never, "0.5.0", undefined, swap.reuse!.replace).then(() => undefined, (error: Error) => error);
    heal();
    assert.match(failure?.message ?? "no failure", inject === "rename" ? /injected rename failure/ : /injected record failure/);
    assert.equal(await inodeOf(path), swap.oldInode, "the public alias did not move"); assert.ok(await answers(path), "the old listener answers");
    if (inject === "record-all") {
      // The repair itself could not write: the publish stops before it sweeps, so the evidence is still there for the next bootstrap.
      assert.equal(await read(path + ".gateway-lease"), stuck, "the record is untouched");
      assert.equal((await names(swap.dir, ".gw-")).filter(name => name.endsWith(".alias")).length, 1, "the staged link that proves the half-finished swap stays");
    } else {
      assert.equal(await read(path + ".gateway-lease"), swap.leaseBefore, "the record names the old listener again, byte for byte");
      assert.deepEqual((await names(swap.dir, ".gw-")).filter(name => name.endsWith(".alias")), [], "no staged link remains");
      assert.equal((await names(swap.dir, ".gw-")).length, 1, "only the old listener's bound socket remains");
    }
    const next = await reuseSshSocket(path, installed);
    assert.deepEqual([next.reused, next.replace?.from], [false, "0.4.0"], "the next bootstrap decides to replace the live listener rather than throwing");
    assert.equal((await reuseSshSocket(path, installed)).replace?.from, "0.4.0", "and keeps deciding the same way");
    assert.equal(await read(path + ".gateway-lease"), swap.leaseBefore); assert.ok(await answers(path));
  } finally { heal(); await swap.old.stop(); await swap.folder.remove(); }
}

const crashed = { skip: process.platform === "win32", timeout: 30000 };
test("a publish whose rename fails after a crashed swap leaves the old listener repairable", crashed, () => publishOverCrash("rename"));
test("a publish whose record write fails after a crashed swap keeps the evidence for the next bootstrap", crashed, () => publishOverCrash("record-all"));
test("a publish whose record write fails after it repaired a crashed swap leaves the repaired record", crashed, () => publishOverCrash("record-after-repair"));

test("a publish that succeeds over a crashed swap records the real previous listener", crashed, async () => {
  const swap = await interruptedSwap(true); const path = swap.old.path; const controller = new AbortController();
  try {
    let replaced: boolean | undefined; let published!: () => void; const ready = new Promise<void>(resolve => { published = resolve; });
    const serving = serveUnix(path, controller.signal, echo as never, "0.5.0", (_listener, did) => { replaced = did; published(); }, swap.reuse!.replace); serving.catch(() => {});
    await Promise.race([ready, serving]);
    assert.equal(replaced, true, "the publish replaced the listener it was told to replace");
    const lease = JSON.parse((await read(path + ".gateway-lease"))!);
    assert.equal(lease.release, "0.5.0"); assert.equal(lease.previous?.release, "0.4.0", "previous is the listener that really held the alias");
    assert.equal(`${lease.previous.device}:${lease.previous.inode}`, swap.oldInode);
    assert.notEqual(await inodeOf(path), swap.oldInode, "the alias is the new listener's"); assert.ok(await answers(path), "the new listener serves");
    assert.deepEqual((await names(swap.dir, ".gw-")).filter(name => name.endsWith(".alias")), [], "no staged link remains");
    assert.deepEqual(await reuseSshSocket(path, installed), { reused: true }, "the new listener is current");
  } finally { controller.abort(); await swap.old.stop(); await swap.folder.remove(); }
});

// ---------------------------------------------------------------- D2: a failed publish restores everything

/** Run `serveUnix` with a fault; return its error. A replacement (`old`) first decides against the live 0.4.0 listener. */
async function failedPublish(inject: "rename" | "record", opts: { old: boolean; stale?: boolean }) {
  const folder = await shortFolder("gw-fail-"); const dir = join(folder.directory, "c"); const path = join(dir, "app-server-control.sock");
  const old = opts.old ? await listener(folder, "0.4.0") : undefined;
  if (opts.stale) { await mkdir(dir, { recursive: true, mode: 0o700 }); await writePrivateJson(path + ".gateway-lease", { inode: "1", device: "2", boundPath: join(dir, ".gw-000000000000"), release: "0.3.0" }); }
  try {
    const leaseBefore = await read(path + ".gateway-lease"); const aliasBefore = await exists(path) ? await inodeOf(path) : undefined;
    const reuse = old ? await reuseSshSocket(path, installed) : { reused: false, replace: undefined };
    if (old) assert.ok(reuse.replace, "the bootstrap decides to replace the live listener");
    if (inject === "rename") fault.rename = true; else fault.record = "all";
    const failure = await serveUnix(path, new AbortController().signal, echo as never, "0.5.0", undefined, reuse.replace).then(() => undefined, (error: Error) => error);
    heal();
    assert.match(failure?.message ?? "no failure", inject === "rename" ? /injected rename failure/ : /injected record failure/);
    assert.equal(await read(path + ".gateway-lease"), leaseBefore, "the ownership record is exactly what it was");
    assert.equal(await exists(path) ? await inodeOf(path) : undefined, aliasBefore, "the public alias did not move");
    assert.deepEqual((await names(dir, ".gw-")).filter(name => name.endsWith(".alias")), [], "no staged link remains");
    assert.deepEqual((await readdir(dir)).filter(name => name.endsWith(".tmp")), [], "no temporary record remains");
    assert.equal((await names(dir, ".gw-")).length, old ? 1 : 0, "the failed listener's own socket is gone; only the old listener's remains");
    if (old) {
      assert.ok(await answers(path), "the old listener answers");
      assert.equal((await reuseSshSocket(path, installed)).replace?.from, "0.4.0", "the next bootstrap still decides to replace");
    } else {
      const fresh = await listener(folder, "0.5.0");
      try { assert.ok(await answers(fresh.path), "the next bootstrap publishes normally"); } finally { await fresh.stop(); }
    }
  } finally { heal(); await old?.stop(); await folder.remove(); }
}

const skip = process.platform === "win32";
test("a replacement whose rename fails leaves the old listener, its record and its alias as they were", { skip, timeout: 30000 }, () => failedPublish("rename", { old: true }));
test("a replacement whose record write fails leaves the old listener, its record and its alias as they were", { skip, timeout: 30000 }, () => failedPublish("record", { old: true }));
test("a fresh publish whose rename fails leaves no record behind", { skip, timeout: 30000 }, () => failedPublish("rename", { old: false }));
test("a fresh publish whose rename fails restores a stale record", { skip, timeout: 30000 }, () => failedPublish("rename", { old: false, stale: true }));
test("a fresh publish whose record write fails restores a stale record", { skip, timeout: 30000 }, () => failedPublish("record", { old: false, stale: true }));

// ---------------------------------------------------------------- D4: sweep what crashed bootstraps left

test("the sweep removes dead leftovers and keeps live sockets, the current alias, and anything it cannot vouch for", { skip, timeout: 30000 }, async () => {
  const folder = await shortFolder("gw-sweep-"); const current = await listener(folder, "0.4.0"); const dir = join(folder.directory, "c");
  const other = await listener(folder, "0.4.0", "other.sock");
  try {
    const live = (await names(dir, ".gw-")); assert.equal(live.length, 2, "two live listeners, each with a bound socket");
    const at = (name: string) => join(dir, name);
    // Removed: a dead bound socket; a staged link whose bound socket is missing; a staged link beside a dead bound socket.
    await deadSocket(folder, [at(".gw-aaaaaaaaaaaa")]);
    await deadSocket(folder, [at(".gw-bbbbbbbbbbbb.alias")]);
    await deadSocket(folder, [at(".gw-cccccccccccc"), at(".gw-cccccccccccc.alias")]);
    // Kept: a staged link beside a live bound socket (of the other, still running listener).
    const currentBound = (JSON.parse((await read(current.path + ".gateway-lease"))!).boundPath as string).split("/").at(-1);
    const otherBound = live.find(name => name !== currentBound)!;
    await link(at(otherBound), at(otherBound + ".alias"));
    // Kept: dead sockets the sweep cannot vouch for (group-readable; not a socket; a name outside the pattern).
    await deadSocket(folder, [at(".gw-dddddddddddd")], 0o644);
    await writeFile(at(".gw-eeeeeeeeeeee"), "not a socket");
    await deadSocket(folder, [at(".gw-ffff"), at(".gw-ABCDEFABCDEF")]);
    await deadSocket(folder, [at(".gw-999999999999")], 0o700);
    // Kept: a dead socket that shares the current alias's inode is the alias.
    const aliasInode = await inodeOf(current.path);
    const before = await names(dir, "");
    await sweepSshLeftovers(current.path);
    const after = await names(dir, "");
    assert.deepEqual(before.filter(name => !after.includes(name)), [".gw-aaaaaaaaaaaa", ".gw-bbbbbbbbbbbb.alias", ".gw-cccccccccccc", ".gw-cccccccccccc.alias"]);
    assert.equal(await inodeOf(current.path), aliasInode, "the current alias is untouched");
    assert.ok(await answers(current.path) && await answers(other.path), "both live listeners still answer");
    assert.ok(await exists(at(otherBound)) && await exists(at(otherBound + ".alias")), "a live listener's socket and its staged link stay");
  } finally { await other.stop(); await current.stop(); await folder.remove(); }
});

test("the sweep keeps a dead socket that is the current alias's own inode", { skip, timeout: 30000 }, async () => {
  const folder = await shortFolder("gw-sweep-"); const dir = join(folder.directory, "c");
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const alias = join(dir, "app-server-control.sock");
    await deadSocket(folder, [alias, join(dir, ".gw-aaaaaaaaaaaa"), join(dir, ".gw-aaaaaaaaaaaa.alias")]);
    await sweepSshLeftovers(alias);
    assert.deepEqual(await names(dir, ""), [".gw-aaaaaaaaaaaa", ".gw-aaaaaaaaaaaa.alias", "app-server-control.sock"], "nothing that is the alias's inode is removed");
  } finally { await folder.remove(); }
});

test("the sweep decides a staged link by its bound socket and never connects to the .alias name", { skip, timeout: 30000 }, async () => {
  const folder = await shortFolder("gw-sweep-");
  try {
    // A bound path of 100 bytes is valid; with ".alias" it is 106, over the 103 byte limit a connect accepts.
    let dir = join(folder.directory, "d"); while (Buffer.byteLength(join(dir, ".gw-aaaaaaaaaaaa")) < 98) dir = join(dir, "n".repeat(Math.min(20, 98 - Buffer.byteLength(join(dir, ".gw-aaaaaaaaaaaa")) - 1)));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const bound = join(dir, ".gw-aaaaaaaaaaaa"); assert.ok(Buffer.byteLength(bound) <= 103 && Buffer.byteLength(bound + ".alias") > 103);
    const liveBound = join(dir, ".gw-bbbbbbbbbbbb"); let live: Server | undefined;
    try {
      await deadSocket(folder, [bound + ".alias"]);
      live = await liveSocket(liveBound); await link(liveBound, liveBound + ".alias");
      await sweepSshLeftovers(join(dir, "app-server-control.sock"));
      assert.equal(await exists(bound + ".alias"), false, "a leftover staged link with no bound socket goes, however long its name");
      assert.ok(await exists(liveBound + ".alias"), "a staged link whose bound socket answers stays, though its own name cannot be connected to");
    } finally { if (live) await closeServer(live); }
  } finally { await folder.remove(); }
});

// Short, because the folder `npm test` hands out already takes most of the 103 bytes a socket path may have.
const managed = ".local/state/gw-ssh/x";

/** Run `body` with `folder` as the home directory, so that a socket under `managed` is an SSH control socket. */
async function atHome<T>(folder: Folder, body: () => Promise<T>): Promise<T> {
  const home = process.env.HOME; process.env.HOME = folder.directory;
  try { return await body(); } finally { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; }
}

/** Dead leftovers of two crashed bootstraps and a stale record temporary file, beside the alias `path`. */
async function leftovers(folder: Folder, path: string) {
  const dir = join(path, ".."); const at = (name: string) => join(dir, name);
  await deadSocket(folder, [at(".gw-aaaaaaaaaaaa"), at(".gw-aaaaaaaaaaaa.alias")]);
  await deadSocket(folder, [at(".gw-bbbbbbbbbbbb.alias")]);
  const temporary = `${path}.gateway-lease.0123456789abcdef.tmp`; await writeFile(temporary, "{", { mode: 0o600 });
  return { dir, temporary, dead: [".gw-aaaaaaaaaaaa", ".gw-aaaaaaaaaaaa.alias", ".gw-bbbbbbbbbbbb.alias"] };
}

test("a fresh SSH bootstrap sweeps crashed bootstraps' leftovers under its publish lock and keeps a live listener's socket", { skip, timeout: 30000 }, async () => {
  const folder = await shortFolder("gw-sweep-"); const sub = managed; const dir = join(folder.directory, sub);
  const other = await listener(folder, "0.4.0", "other.sock", sub); const fresh = new AbortController();
  try {
    const otherBound = (await names(dir, ".gw-"))[0]; const path = join(dir, "a.sock");
    const left = await leftovers(folder, path);
    await atHome(folder, async () => {
      const serving = serveUnix(path, fresh.signal, echo as never, "0.5.0"); serving.catch(() => {});
      for (let i = 0; i < 300 && !await exists(path); i++) await delay(10);
    });
    assert.ok(await answers(path), "the new listener serves");
    assert.deepEqual((await names(dir, ".gw-")).filter(name => /^\.gw-[ab]{12}/.test(name)), [], "the crashed bootstraps' leftovers are gone");
    assert.equal(await exists(left.temporary), false, "and so is the record's temporary file");
    assert.ok(await exists(join(dir, otherBound)) && await answers(other.path), "the live listener's socket is untouched");
    assert.equal((await names(dir, ".gw-")).length, 2, "the live listener's and the new listener's bound sockets remain");
  } finally { fresh.abort(); await other.stop(); await folder.remove(); }
});

test("a replacement sweeps wherever its socket is, and removes a stale record temporary file", { skip, timeout: 30000 }, async () => {
  const folder = await shortFolder("gw-sweep-"); const old = await listener(folder, "0.4.0"); const controller = new AbortController();
  try {
    const left = await leftovers(folder, old.path); const reuse = await reuseSshSocket(old.path, installed); assert.ok(reuse.replace);
    let published!: () => void; const ready = new Promise<void>(resolve => { published = resolve; });
    const serving = serveUnix(old.path, controller.signal, echo as never, "0.5.0", () => published(), reuse.replace); serving.catch(() => {});
    await Promise.race([ready, serving]);
    for (const name of left.dead) assert.equal(await exists(join(left.dir, name)), false, `${name} was swept`);
    assert.equal(await exists(left.temporary), false, "the stale record temporary file was swept");
  } finally { controller.abort(); await old.stop(); await folder.remove(); }
});

test("a custom listen publish never sweeps", { skip, timeout: 30000 }, async () => {
  const folder = await shortFolder("gw-sweep-"); const path = join(folder.directory, "c", "custom.sock"); const fresh = new AbortController();
  try {
    await mkdir(join(folder.directory, "c"), { recursive: true, mode: 0o700 });
    const left = await leftovers(folder, path); const before = await names(left.dir, "");
    const serving = serveUnix(path, fresh.signal, echo as never, "0.5.0"); serving.catch(() => {});
    for (let i = 0; i < 300 && !await exists(path); i++) await delay(10);
    assert.ok(await answers(path), "the listener serves");
    for (const name of [...left.dead, basename(left.temporary)]) assert.ok(await exists(join(left.dir, name)), `${name} is left alone`);
    const after = await names(left.dir, ""); assert.deepEqual(before.filter(name => !after.includes(name)), [], "nothing that was there went");
  } finally { fresh.abort(); await folder.remove(); }
});

test("only a socket under the managed SSH state folder counts as an SSH control socket", { skip }, async () => {
  const folder = await shortFolder("gw-sweep-");
  try {
    await atHome(folder, async () => {
      assert.equal(isManagedSshSocket(join(folder.directory, managed, "a.sock")), true);
      for (const outside of [".local/state/gw-ssh", ".local/state/gw-ssh2/x/a.sock", ".local/state/other/a.sock", "c/app-server-control.sock", "../x.sock"])
        assert.equal(isManagedSshSocket(join(folder.directory, outside)), false, outside);
    });
  } finally { await folder.remove(); }
});

test("the sweep removes stale record temporary files that are regular files of this alias and nothing else", { skip, timeout: 30000 }, async () => {
  const folder = await shortFolder("gw-sweep-"); const dir = join(folder.directory, "c"); await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const alias = join(dir, "app-server-control.sock"); const at = (name: string) => join(dir, name);
    const gone = ["app-server-control.sock.gateway-lease.0123456789abcdef.tmp", "app-server-control.sock.gateway-lease.fedcba9876543210.tmp"];
    for (const name of gone) await writeFile(at(name), "{", { mode: 0o600 });
    const kept = ["app-server-control.sock.gateway-lease.0123456789abcde.tmp", "app-server-control.sock.gateway-lease.0123456789ABCDE0.tmp", "app-server-control.sock.gateway-lease.0123456789abcdef.tmp.keep",
      "other.sock.gateway-lease.0123456789abcdef.tmp", "xapp-server-control.sock.gateway-lease.0123456789abcdef.tmp", "app-server-controlXsock.gateway-lease.0123456789abcdef.tmp"];
    for (const name of kept) await writeFile(at(name), "{", { mode: 0o600 });
    await writeFile(at("target"), "keep me"); await symlink(at("target"), at("app-server-control.sock.gateway-lease.1111111111111111.tmp")); kept.push("app-server-control.sock.gateway-lease.1111111111111111.tmp");
    await mkdir(at("app-server-control.sock.gateway-lease.2222222222222222.tmp")); kept.push("app-server-control.sock.gateway-lease.2222222222222222.tmp");
    await sweepSshLeftovers(alias);
    for (const name of gone) assert.equal(await exists(at(name)), false, `${name} was removed`);
    for (const name of kept) assert.ok(await exists(at(name)), `${name} stays`);
    assert.equal(await read(at("target")), "keep me", "a symlink's target is never touched");
  } finally { await folder.remove(); }
});

test("the sweep keeps a socket whose liveness it could not determine", { skip, timeout: 30000 }, async () => {
  const folder = await shortFolder("gw-sweep-"); const dir = join(folder.directory, "c"); await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const unknown = join(dir, ".gw-aaaaaaaaaaaa"); const dead = join(dir, ".gw-bbbbbbbbbbbb");
    await deadSocket(folder, [unknown, unknown + ".alias"]); await deadSocket(folder, [dead]);
    unknownAnswer.add(unknown);
    try { await sweepSshLeftovers(join(dir, "app-server-control.sock")); } finally { unknownAnswer.delete(unknown); }
    assert.deepEqual(await names(dir, ""), [".gw-aaaaaaaaaaaa", ".gw-aaaaaaaaaaaa.alias"], "an unknown answer is not a refusal; only the refused socket went");
  } finally { await folder.remove(); }
});
