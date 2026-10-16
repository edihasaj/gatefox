import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, access, symlink, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setBootIdentityForTests, setProcessStartReaderForTests } from "../boot-identity.js";
import { withPrivateFileLock } from "../private-file-lock.js";

test("private preference locks recover a dead writer and release after a failed update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-preference-lock-")); const path = join(directory, "preferences");
  await writeFile(`${path}.lock`, "2147483647", { mode: 0o600 });
  await assert.rejects(withPrivateFileLock(path, async () => { throw new Error("failed update"); }), /failed update/);
  await assert.rejects(access(`${path}.lock`));
  assert.equal(await withPrivateFileLock(path, async () => "recovered"), "recovered");
  await assert.rejects(access(`${path}.lock`));
});

test("private preference locks reject occupied symlinks without changing their targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-preference-lock-")); const path = join(directory, "preferences");
  const target = join(directory, "unrelated"); await writeFile(target, "leave unchanged"); await symlink(target, `${path}.lock`);
  await assert.rejects(withPrivateFileLock(path, async () => "unused"), /lock is invalid/);
  assert.equal(await readFile(target, "utf8"), "leave unchanged");
});

// The same liveness rule as an ownership receipt: see src/boot-identity.ts.
const booted = 1_700_000_000_000;
async function stalled(path: string, pid: number, mtimeMs: number): Promise<void> {
  await writeFile(`${path}.lock`, String(pid), { mode: 0o600 });
  await utimes(`${path}.lock`, new Date(mtimeMs), new Date(mtimeMs));
}

test("a lock this process still holds is never broken by a second writer in the same process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-preference-lock-")); const path = join(directory, "preferences");
  setBootIdentityForTests({ id: "11111111-1111-4111-8111-111111111111", bootedAtMs: booted });
  let release!: () => void;
  try {
    const first = withPrivateFileLock(path, () => new Promise<string>(done => { release = () => done("first"); }));
    await new Promise(done => setImmediate(done));
    await assert.rejects(withPrivateFileLock(path, async () => "second", 200), /busy/);
    assert.equal(await readFile(`${path}.lock`, "utf8"), String(process.pid));
    release(); assert.equal(await first, "first");
    await assert.rejects(access(`${path}.lock`));
  } finally { setBootIdentityForTests(); setProcessStartReaderForTests(); }
});

test("a leftover lock naming this process is recovered, because its writer is gone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-preference-lock-")); const path = join(directory, "preferences");
  setBootIdentityForTests({ id: "11111111-1111-4111-8111-111111111111", bootedAtMs: booted });
  try {
    await stalled(path, process.pid, booted + 5000);
    assert.equal(await withPrivateFileLock(path, async () => "recovered"), "recovered");
  } finally { setBootIdentityForTests(); }
});

test("a lock from the previous boot is recovered, and one from this boot is not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-preference-lock-")); const path = join(directory, "preferences");
  setBootIdentityForTests({ id: "11111111-1111-4111-8111-111111111111", bootedAtMs: booted });
  try {
    await stalled(path, 1, booted - 120_000); // Written before this machine booted: its writer cannot exist.
    assert.equal(await withPrivateFileLock(path, async () => "recovered"), "recovered");
    await stalled(path, 1, Date.now()); // A live pid owned by uid 0: the probe answers EPERM, never ours.
    let eperm = false;
    try { process.kill(1, 0); } catch (error) { eperm = (error as NodeJS.ErrnoException).code === "EPERM"; }
    assert.equal(await withPrivateFileLock(path, async () => "taken", 300).then(() => eperm ? "refused" : "taken", () => "refused"), eperm ? "refused" : "taken");
  } finally { setBootIdentityForTests(); }
});

test("a lock whose pid was reused by a process that started later is recovered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-preference-lock-")); const path = join(directory, "preferences");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  setBootIdentityForTests({ id: "11111111-1111-4111-8111-111111111111", bootedAtMs: booted });
  try {
    await stalled(path, child.pid!, booted + 1000);
    // The process answers, but it began three seconds after that lock was written: a different process wearing the pid.
    setProcessStartReaderForTests(async () => booted + 4000);
    assert.equal(await withPrivateFileLock(path, async () => "recovered"), "recovered");
    await stalled(path, child.pid!, booted + 1000);
    setProcessStartReaderForTests(async () => booted + 1000);
    assert.equal(await withPrivateFileLock(path, async () => "taken", 300).catch(() => "refused"), "refused");
  } finally {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    setBootIdentityForTests(); setProcessStartReaderForTests();
  }
});

test("a lock stamped in the future is recovered once its owner is gone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-preference-lock-")); const path = join(directory, "preferences");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  setBootIdentityForTests({ id: "11111111-1111-4111-8111-111111111111", bootedAtMs: booted });
  try {
    await stalled(path, child.pid!, Date.now() + 3_600_000); // A clock that stepped backwards cannot hide a live writer.
    assert.equal(await withPrivateFileLock(path, async () => "taken", 300).catch(() => "refused"), "refused");
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    assert.equal(await withPrivateFileLock(path, async () => "recovered"), "recovered");
  } finally { setBootIdentityForTests(); setProcessStartReaderForTests(); }
});
