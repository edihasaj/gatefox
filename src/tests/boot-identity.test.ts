import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fromPreviousBoot, ownerAlive, ownerStamp, parsePsStart, processStartMs, setBootIdentityForTests, setOwnPidForTests, setProcessStartReaderForTests, spawnStamp, thisProcessStartMs } from "../boot-identity.js";

const current = { id: "11111111-1111-4111-8111-111111111111", bootedAtMs: 1_700_000_000_000 };
const other = "22222222-2222-4222-8222-222222222222";
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 5000)"], { stdio: "ignore" });
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  return child.pid!;
}
async function runningChild(): Promise<{ pid: number; stop(): Promise<void> }> {
  const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise(done => setTimeout(done, 50));
  return { pid: child.pid!, stop: async () => { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } };
}

test("a receipt naming this very process never blocks a retry", async () => {
  setBootIdentityForTests(current);
  try {
    assert.equal(await ownerAlive({ pid: process.pid, bootId: current.id, startedAtMs: thisProcessStartMs() }, Date.now()), false);
    assert.equal(await ownerAlive({ pid: process.pid }, Date.now()), false);
  } finally { setBootIdentityForTests(); }
});

test("a receipt from an earlier boot is dead whatever its pid says", async () => {
  setBootIdentityForTests(current);
  const holder = await runningChild();
  try {
    // A live pid cannot rescue a receipt that belongs to the previous boot. The start time stays out of
    // these records: whose start this is is the next test's subject, and guessing it here would need `ps`.
    assert.equal(await ownerAlive({ pid: holder.pid, bootId: other }, current.bootedAtMs + 1000), false);
    assert.equal(await ownerAlive({ pid: holder.pid, bootId: current.id }, current.bootedAtMs + 1000), true);
  } finally { await holder.stop(); setBootIdentityForTests(); }
});

test("a receipt with no boot id is judged by its file time, with a minute of slack", async () => {
  setBootIdentityForTests(current);
  try {
    assert.equal(await fromPreviousBoot({}, current.bootedAtMs - 61_000), true);
    assert.equal(await fromPreviousBoot({}, current.bootedAtMs - 60_001), true);
    assert.equal(await fromPreviousBoot({}, current.bootedAtMs - 59_000), false);
    assert.equal(await fromPreviousBoot({}, current.bootedAtMs + 60_000), false);
    assert.equal(await fromPreviousBoot({ bootId: current.id }, 0), false);
  } finally { setBootIdentityForTests(); }
});

test("a pid that is gone or somebody else\'s is not an owner", { skip: process.platform === "win32" }, async () => {
  setBootIdentityForTests(current);
  const gone = await exitedPid();
  try {
    assert.equal(await ownerAlive({ pid: gone, bootId: current.id }, current.bootedAtMs + 1000), false);
    // uid 0 owns pid 1 here, so the probe answers EPERM: never this gateway's owner.
    let eperm = false;
    try { process.kill(1, 0); } catch (error) { eperm = (error as NodeJS.ErrnoException).code === "EPERM"; }
    if (eperm) assert.equal(await ownerAlive({ pid: 1, bootId: current.id }, current.bootedAtMs + 1000), false);
  } finally { setBootIdentityForTests(); }
});

test("a reused pid is dead, and a matching one is the only answer that keeps an owner", async () => {
  setBootIdentityForTests(current);
  const holder = await runningChild();
  try {
    setProcessStartReaderForTests(async () => current.bootedAtMs + 3_600_000);
    assert.equal(await ownerAlive({ pid: holder.pid, bootId: current.id, startedAtMs: current.bootedAtMs }, current.bootedAtMs + 1000), false);
    setProcessStartReaderForTests(async () => current.bootedAtMs + 2_001);
    assert.equal(await ownerAlive({ pid: holder.pid, bootId: current.id, startedAtMs: current.bootedAtMs }, current.bootedAtMs + 1000), false);
    setProcessStartReaderForTests(async () => current.bootedAtMs + 2_000);
    assert.equal(await ownerAlive({ pid: holder.pid, bootId: current.id, startedAtMs: current.bootedAtMs }, current.bootedAtMs + 1000), true);
    // A machine that answers no start time gives no evidence: the pid probe alone decides.
    setProcessStartReaderForTests(async () => undefined);
    assert.equal(await ownerAlive({ pid: holder.pid, bootId: current.id, startedAtMs: current.bootedAtMs }, current.bootedAtMs + 1000), true);
  } finally { await holder.stop(); setBootIdentityForTests(); setProcessStartReaderForTests(); }
});

test("this process\'s own start stamp cannot land in the future of its uptime", () => {
  const started = thisProcessStartMs();
  assert.ok(Math.abs(started - (Date.now() - 0)) <= 60_000);
});

// D4: a start computed from the uptime drifts from the kernel's record (about 0.64 s a day was measured), so after a few days a
// long-running supervisor's own receipt no longer matched what `ps` reports and its live host looked like a reused pid.
test("this process stamps its start from the same source a checker reads, so a drifting clock never makes it look dead", async () => {
  setBootIdentityForTests(current);
  const kernel = thisProcessStartMs() - 5000; // What `ps` says after days of drift between the uptime and the kernel's record.
  setProcessStartReaderForTests(async pid => pid === process.pid ? kernel : undefined);
  setOwnPidForTests(process.pid + 1_000_000); // Judge this process as another one would, not as its own leftover.
  try {
    const stamp = await ownerStamp();
    assert.equal(stamp.startedAtMs, kernel); assert.equal(stamp.bootId, current.id);
    assert.equal(await ownerAlive({ pid: process.pid, ...stamp }, Date.now()), true);
    // Without an answer from the operating system the estimate is the only stamp left.
    setProcessStartReaderForTests(async () => undefined);
    assert.ok(Math.abs((await ownerStamp()).startedAtMs - thisProcessStartMs()) < 1000);
  } finally { setOwnPidForTests(); setBootIdentityForTests(); setProcessStartReaderForTests(); }
});

test("a spawned child is stamped with the kernel's start when it answers, and with the spawn time when it does not", async () => {
  setBootIdentityForTests(current);
  try {
    setProcessStartReaderForTests(async pid => pid === 4_000_001 ? current.bootedAtMs + 7000 : undefined);
    assert.equal((await spawnStamp(4_000_001)).startedAtMs, current.bootedAtMs + 7000);
    const before = Date.now(); const stamp = await spawnStamp(4_000_002);
    assert.ok(stamp.startedAtMs >= before && stamp.startedAtMs <= Date.now()); assert.equal(stamp.bootId, current.id);
  } finally { setBootIdentityForTests(); setProcessStartReaderForTests(); }
});

// D6: `ps` printed local time without an offset, so the daylight-saving fall-back hour (and any zone change) moved a start by an hour.
test("process start times are read as UTC, so an ambiguous or skipped local hour cannot move them", () => {
  assert.equal(parsePsStart("Sun Nov  1 01:30:00 2026"), Date.UTC(2026, 10, 1, 1, 30, 0)); // Repeated in US zones at fall-back.
  assert.equal(parsePsStart("Sun Oct 25 02:30:00 2026"), Date.UTC(2026, 9, 25, 2, 30, 0)); // Repeated in European zones.
  assert.equal(parsePsStart("Sun Mar  8 02:30:00 2026\n"), Date.UTC(2026, 2, 8, 2, 30, 0)); // Skipped in US zones at spring-forward.
  assert.equal(parsePsStart("Sat Oct 17 01:08:03 2026"), Date.UTC(2026, 9, 17, 1, 8, 3));
  for (const text of ["", "garbage", "Sat Foo 17 01:08:03 2026", "Sat Oct 17 25:08:03 2026", "17/10/2026 01:08:03", "Sat Oct 17 01:08:03 2026 +0200"]) assert.equal(parsePsStart(text), undefined, text);
});

test("the operating system's start of a fresh child agrees with the time it was spawned, whatever this process's zone is", { skip: !["darwin", "linux"].includes(process.platform) }, async t => {
  const zone = process.env.TZ; process.env.TZ = "America/New_York";
  const before = Date.now(); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const started = await processStartMs(child.pid!);
    if (started === undefined) { t.skip("ps did not answer in time"); return; }
    // `ps` reports whole seconds, so the start can read up to a second before the spawn.
    assert.ok(started >= before - 1500 && started <= Date.now() + 1000, `started ${started - before} ms from the spawn`);
  } finally {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
});
