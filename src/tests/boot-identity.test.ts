import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fromPreviousBoot, ownerAlive, setBootIdentityForTests, setProcessStartReaderForTests, thisProcessStartMs } from "../boot-identity.js";

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
