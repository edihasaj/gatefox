import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { linkAnswers, removeOwnedSocket, sameSocketIdentity, sdkSocketTarget, setSdkSocketRootForTests, socketAnswers, socketIdentity } from "../execution-host-storage.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

const roots = isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.

async function fixture() {
  // The rendezvous is a machine-wide fixed folder: a run only ever uses a short folder of its own.
  const directory = await mkdtemp(join(tmpdir(), "gwt-sdk-"));
  const root = join(directory, "r");
  await mkdir(root, { mode: 0o700 }); setSdkSocketRootForTests(root);
  const path = join(directory, "engine.sock"); const target = await sdkSocketTarget(path);
  const info = await lstat(dirname(target));
  assert.equal(info.uid, process.getuid?.()); assert.equal(info.mode & 0o777, 0o700);
  return { directory, path, target, clean: async () => { roots.restore(); await rm(directory, { recursive: true, force: true }); } };
}
async function childSocket(path: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "const fs=require('node:fs');require('node:net').createServer().listen(process.argv[1],()=>{fs.chmodSync(process.argv[1],0o600);console.log('ready')})", path], { stdio: ["ignore", "pipe", "ignore"] });
  await once(child.stdout!, "data"); return child;
}
async function kill(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "close"); child.kill("SIGKILL"); await exited;
}

test("SDK rendezvous pins its private socket and preserves a live listener", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const f = await fixture(); let child;
  try {
    child = await childSocket(f.target); await symlink(f.target, f.path);
    const identity = await socketIdentity(f.path); assert.ok(identity);
    assert.equal(identity.targetPath, f.target); assert.equal(identity.targetInode, String((await lstat(f.target)).ino));
    assert.ok(sameSocketIdentity(identity, (await socketIdentity(f.path))!));
    await assert.rejects(removeOwnedSocket(f.path, identity), /live execution listener/);
    assert.ok((await lstat(f.path)).isSymbolicLink()); assert.ok((await lstat(f.target)).isSocket());
    await kill(child); child = undefined;
    await removeOwnedSocket(f.path, identity);
    await assert.rejects(lstat(f.path), { code: "ENOENT" }); await assert.rejects(lstat(f.target), { code: "ENOENT" });
  } finally { await kill(child); await f.clean(); }
});

test("SDK recovery preserves a replaced physical socket despite an unchanged alias", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const f = await fixture(); let child;
  try {
    child = await childSocket(f.target); await symlink(f.target, f.path);
    const identity = (await socketIdentity(f.path))!; await kill(child); child = undefined;
    // Retain the old inode at another path so the replacement cannot reuse it.
    await rename(f.target, f.target + ".reserve");
    child = await childSocket(f.target);
    const current = (await socketIdentity(f.path))!;
    assert.equal(current.inode, identity.inode); assert.notEqual(current.targetInode, identity.targetInode);
    assert.equal(sameSocketIdentity(identity, current), false);
    await assert.rejects(removeOwnedSocket(f.path, identity), /another listener/);
    assert.ok((await lstat(f.target)).isSocket());
  } finally { await kill(child); await rm(f.target + ".reserve", { force: true }); await f.clean(); }
});

test("SDK recovery removes its recorded dangling alias without touching unrelated paths", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const f = await fixture(); const server = createServer();
  try {
    server.listen(f.target); await once(server, "listening"); await chmod(f.target, 0o600); await symlink(f.target, f.path);
    const identity = (await socketIdentity(f.path))!;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await assert.rejects(lstat(f.target), { code: "ENOENT" });
    await removeOwnedSocket(f.path, identity); await assert.rejects(lstat(f.path), { code: "ENOENT" });
  } finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); await f.clean(); }
});

test("SDK socket validation rejects unrelated symlinks and non-socket protected targets", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const f = await fixture(); const unrelated = join(f.directory, "untouched.txt");
  try {
    await writeFile(unrelated, "preserve", { mode: 0o640 }); await symlink(unrelated, f.path);
    await assert.rejects(socketIdentity(f.path), /unrelated target/);
    await assert.rejects(removeOwnedSocket(f.path), /unrelated target/);
    assert.equal(await readFile(unrelated, "utf8"), "preserve"); assert.equal((await lstat(unrelated)).mode & 0o777, 0o640);
    await unlink(f.path); await writeFile(f.target, "protected unexpected file", { mode: 0o600 }); await symlink(f.target, f.path);
    await assert.rejects(socketIdentity(f.path), /target must be private/);
    await assert.rejects(removeOwnedSocket(f.path), /target must be private/);
    assert.equal(await readFile(f.target, "utf8"), "protected unexpected file");
  } finally { await f.clean(); }
});

test("SDK recovery removes only its recorded dead physical target after the alias disappears", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const f = await fixture(); let child;
  try {
    child = await childSocket(f.target); await symlink(f.target, f.path);
    const identity = (await socketIdentity(f.path))!; await unlink(f.path);
    await assert.rejects(removeOwnedSocket(f.path, identity), /live execution listener/);
    await kill(child); child = undefined;
    await removeOwnedSocket(f.path); assert.ok((await lstat(f.target)).isSocket());
    await removeOwnedSocket(f.path, identity); await assert.rejects(lstat(f.target), { code: "ENOENT" });
  } finally { await kill(child); await f.clean(); }
});

// A3: connect on a plain file fails with ENOTSOCK, which the probe counted as "answering". A stray file at a socket path, or
// at the SDK target a dead link names, then kept a dead owner alive for good. Nothing that is not a socket can listen.
test("only a socket can answer: a plain file, a folder or a pipe never keeps an owner alive", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const f = await fixture(); let child;
  try {
    const file = join(f.directory, "file.sock"); await writeFile(file, "not a socket", { mode: 0o600 });
    const folder = join(f.directory, "folder.sock"); await mkdir(folder, { mode: 0o700 });
    const pipe = join(f.directory, "pipe.sock"); await new Promise<void>((done, failed) => spawn("/usr/bin/mkfifo", ["-m", "600", pipe]).once("exit", code => code === 0 ? done() : failed(new Error("mkfifo failed"))));
    const link = join(f.directory, "link.sock"); await symlink(file, link);
    for (const path of [file, folder, pipe, link]) assert.equal(await socketAnswers(path), false, path);
    // The SDK's own target turned into a plain file: its link is not answering either.
    await writeFile(f.target, "stray", { mode: 0o600 }); await symlink(f.target, f.path);
    assert.equal(await linkAnswers(f.path), false);
    await unlink(f.target);
    // A socket nobody listens on is not answering, and a live one is: the rule for sockets is unchanged.
    child = await childSocket(f.target);
    assert.equal(await socketAnswers(f.target), true); assert.equal(await linkAnswers(f.path), true);
    await kill(child); child = undefined;
    assert.equal(await socketAnswers(f.target), false); assert.equal(await socketAnswers(join(f.directory, "missing.sock")), false);
  } finally { await kill(child); await f.clean(); }
});
