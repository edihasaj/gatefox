import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, access, symlink, readFile, rm, utimes } from "node:fs/promises";
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
  let release!: () => void; let acquired!: () => void;
  // The second attempt starts only once the first writer holds the lock: a fixed tick raced the first one's file creation.
  const holding = new Promise<void>(done => { acquired = done; });
  try {
    const first = withPrivateFileLock(path, () => { acquired(); return new Promise<string>(done => { release = () => done("first"); }); });
    await holding;
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

test("a lock naming another user's process is recovered, because it can never be this gateway's", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-preference-lock-")); const path = join(directory, "preferences");
  let eperm = false;
  try { process.kill(1, 0); } catch (error) { eperm = (error as NodeJS.ErrnoException).code === "EPERM"; }
  if (!eperm) { t.skip("pid 1 is this user's here"); return; }
  // Written just now, so no time rule could call it stale: only whose process it names decides.
  await stalled(path, 1, Date.now());
  assert.equal(await withPrivateFileLock(path, async () => "recovered"), "recovered");
});

test("a lock from an earlier boot is recovered by what its pid shows, never by its file time", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-preference-lock-")); const path = join(directory, "preferences");
  const gone = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" }); await once(gone, "exit");
  setBootIdentityForTests({ id: "11111111-1111-4111-8111-111111111111", bootedAtMs: booted });
  try {
    await stalled(path, gone.pid!, booted - 120_000); // Its writer did not survive the reboot: the pid is gone.
    assert.equal(await withPrivateFileLock(path, async () => "recovered"), "recovered");
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

// Reviewer probe p5 (D1): a caller that released its lock left `held` before the file was gone, so another caller in this
// process read our pid with nothing held, took the lock for a leftover, removed it and took its own; our release then removed
// that live lock. Up to two holders were seen at once, and callers failed with ENOENT.
test("concurrent callers in one process never hold one lock together, and none of them fails", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-preference-lock-")); const path = join(directory, "prefs");
  let inside = 0; let most = 0; let completed = 0; const errors: Record<string, number> = {};
  const worker = async () => {
    for (let round = 0; round < 40; round++) {
      try {
        await withPrivateFileLock(path, async () => { inside++; most = Math.max(most, inside); await new Promise(done => setTimeout(done, Math.random() * 3)); inside--; }, 20000);
        completed++;
      } catch (error) { const key = (error as NodeJS.ErrnoException).code ?? (error as Error).message; errors[key] = (errors[key] ?? 0) + 1; }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  assert.deepEqual({ completed, most, errors }, { completed: 320, most: 1, errors: {} });
  await assert.rejects(access(`${path}.lock`));
});

test("a release never removes a lock somebody else created in its place", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-preference-lock-")); const path = join(directory, "preferences");
  await withPrivateFileLock(path, async () => {
    // Whoever replaced it: the path now names a file this release did not create.
    await rm(`${path}.lock`); await writeFile(`${path}.lock`, "2147483646", { mode: 0o600 });
  });
  assert.equal(await readFile(`${path}.lock`, "utf8"), "2147483646");
});

test("a live lock is never broken by a clock that stepped forward past its file time", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-preference-lock-")); const path = join(directory, "preferences");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  setBootIdentityForTests({ id: "11111111-1111-4111-8111-111111111111", bootedAtMs: booted });
  try {
    // After a forward step the boot looks later than this lock's write, but its holder started before the write and still runs.
    await stalled(path, child.pid!, booted - 3_600_000);
    setProcessStartReaderForTests(async pid => pid === child.pid ? booted - 3_700_000 : undefined);
    assert.equal(await withPrivateFileLock(path, async () => "taken", 300).catch(() => "refused"), "refused");
    assert.equal(await readFile(`${path}.lock`, "utf8"), String(child.pid));
  } finally {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    setBootIdentityForTests(); setProcessStartReaderForTests();
  }
});

test("only one breaker at a time removes a stale lock, and a breaker that died does not stop the next one", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-preference-lock-")); const path = join(directory, "preferences");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const gone = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" }); await once(gone, "exit");
  try {
    await stalled(path, gone.pid!, Date.now());
    // Another process is removing this stale lock right now: this caller waits instead of racing it.
    await writeFile(`${path}.lock.break`, String(child.pid), { mode: 0o600 });
    assert.equal(await withPrivateFileLock(path, async () => "taken", 300).catch(() => "refused"), "refused");
    assert.equal(await readFile(`${path}.lock`, "utf8"), String(gone.pid));
    // That breaker died inside its step: its marker no longer holds anybody back.
    await writeFile(`${path}.lock.break`, String(gone.pid), { mode: 0o600 });
    assert.equal(await withPrivateFileLock(path, async () => "recovered"), "recovered");
    await assert.rejects(access(`${path}.lock`)); await assert.rejects(access(`${path}.lock.break`));
  } finally { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
});

// A3 (reviewer probe alias.mjs): `held`, `breaking` and the break marker were keyed by the caller's spelling of the path. A
// second caller that reached the same file through a linked folder (`/tmp` and `/private/tmp` on macOS) read our live lock as
// this process's own leftover, broke it and held it too: two holders at once. A linked folder shows it on every platform.
test("one lock reached through two spellings of its folder is still one lock", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-preference-lock-"));
  const real = join(directory, "real"); await mkdir(real, { mode: 0o700 });
  const alias = join(directory, "alias"); await symlink(real, alias);
  try {
    for (const [first, second] of [[real, alias], [alias, real]]) {
      let inside = 0; let most = 0;
      const operation = async () => { inside++; most = Math.max(most, inside); await new Promise(done => setTimeout(done, 200)); inside--; return "done"; };
      const holder = withPrivateFileLock(join(first, "prefs"), operation, 3000);
      await new Promise(done => setTimeout(done, 20)); // The first caller holds the lock now.
      const results = await Promise.allSettled([holder, withPrivateFileLock(join(second, "prefs"), operation, 3000)]);
      assert.deepEqual({ most, results: results.map(result => result.status) }, { most: 1, results: ["fulfilled", "fulfilled"] });
      await assert.rejects(access(join(real, "prefs.lock"))); await assert.rejects(access(join(real, "prefs.lock.break")));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
