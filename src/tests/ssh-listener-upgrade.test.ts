import test from "node:test";
import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serveUnix } from "../unix-transport.js";
import { sshListenerOwner } from "../ssh-socket.js";
import { askStaleListenerToRetire, declineTrustMs, watchStaleListener, type StaleListenerDeps } from "../ssh-listener-upgrade.js";
import type { SshListenerOwner } from "../ssh-socket.js";
import type { ListenerRecord } from "../ssh-listener-activity.js";
import { shortFolder } from "./short-folder.js";

const startedAt = 1_800_000_000_000;
const older: SshListenerOwner = { release: "1.6.2", pid: 4242, startedAtMs: startedAt };
function deps(over: Partial<StaleListenerDeps> & { record?: ListenerRecord | undefined } = {}) {
  const signals: number[] = [];
  const record = "record" in over ? over.record : { pid: 4242, startedAt, busy: false };
  const value: StaleListenerDeps = {
    installed: () => "1.6.3",
    owner: async () => ({ release: "1.6.2", pid: 4242, startedAtMs: startedAt }),
    activity: async () => record,
    startMs: async () => startedAt + 400,
    signal: pid => { signals.push(pid); },
    ...over,
  };
  return { value, signals };
}

test("an idle listener on an older release is asked to retire once", async () => {
  const d = deps();
  assert.deepEqual(await askStaleListenerToRetire("/home", older, d.value), { outcome: "asked", from: "1.6.2", to: "1.6.3" });
  assert.deepEqual(d.signals, [4242]);
});

test("a listener on the installed release, a busy one, or one that cannot be vouched for is never signalled", async () => {
  const now = startedAt + 3_600_000;
  const cases: [string, SshListenerOwner | undefined, Partial<StaleListenerDeps> & { record?: ListenerRecord | undefined }, string][] = [
    ["current", { ...older, release: "1.6.3" }, {}, "current"],
    ["busy", older, { record: { pid: 4242, startedAt, busy: true } }, "busy"],
    ["busy with a recent decline", older, { record: { pid: 4242, startedAt, busy: true, declinedAt: now - 60_000 } }, "busy"],
    ["no activity record (a release that would die of SIGUSR2)", older, { record: undefined }, "unknown"],
    ["reused pid", older, { startMs: async () => startedAt + 60_000 }, "unknown"],
    ["reused pid that started another listener with a fresh record", older,
      { startMs: async () => startedAt + 60_000, record: { pid: 4242, startedAt: startedAt + 60_000, busy: false } }, "unknown"],
    ["unknown start", older, { startMs: async () => undefined }, "unknown"],
    ["no writer pid in the lease", { release: "1.6.2" }, {}, "unknown"],
    ["no writer start in the lease", { release: "1.6.2", pid: 4242 }, {}, "unknown"],
    ["no listener", undefined, {}, "unknown"],
    ["not an installed release", older, { installed: () => undefined }, "unknown"],
    ["its own pid", { ...older, pid: process.pid }, {}, "unknown"],
  ];
  for (const [name, owner, over, outcome] of cases) {
    const d = deps(over);
    assert.equal((await askStaleListenerToRetire("/home", owner, d.value, now)).outcome, outcome, name);
    assert.deepEqual(d.signals, [], name);
  }
});

test("a lease from before release names counts as an older release", async () => {
  const d = deps();
  assert.deepEqual(await askStaleListenerToRetire("/home", { pid: 4242, startedAtMs: startedAt }, d.value), { outcome: "asked", from: "unknown", to: "1.6.3" });
});

test("a decline stops being trusted after a while, so an idle listener is asked again", async () => {
  const declinedAt = startedAt + 3_600_000;
  const d = deps({ record: { pid: 4242, startedAt, busy: true, declinedAt } });
  assert.equal((await askStaleListenerToRetire("/home", older, d.value, declinedAt + declineTrustMs + 1)).outcome, "asked");
  assert.deepEqual(d.signals, [4242]);
});

test("the proxy keeps checking the listener it reached, not the one a later bootstrap put behind the socket", async () => {
  let current: SshListenerOwner = older;
  const d = deps({ owner: async () => current });
  const stop = watchStaleListener("/home", "/sock", { firstMs: 20, everyMs: 5, jitterMs: 0, followUpsMs: [] }, d.value);
  current = { release: "1.6.3", pid: 5151, startedAtMs: startedAt }; // Swapped in after this connection opened.
  try {
    for (let i = 0; i < 200 && !d.signals.length; i++) await delay(5);
    assert.deepEqual(d.signals.slice(0, 1), [4242]);
  } finally { stop(); }
});

test("the proxy keeps checking for the whole connection and stops when it ends", async () => {
  let calls = 0; let installed = "1.6.2";
  const d = deps({ installed: () => installed, activity: async () => { calls++; return { pid: 4242, startedAt, busy: false }; } });
  const stop = watchStaleListener("/home", "/sock", { firstMs: 5, everyMs: 5, jitterMs: 0, followUpsMs: [] }, d.value);
  try {
    let checks = 0; const counting = d.value.installed;
    d.value.installed = () => { checks++; return counting(); };
    for (let i = 0; i < 200 && checks < 3; i++) await delay(5);
    assert.ok(checks >= 3, "a current listener is checked again"); assert.deepEqual(d.signals, []);
    installed = "1.6.3"; // An install while the connection stays open.
    for (let i = 0; i < 200 && !d.signals.length; i++) await delay(5);
    assert.deepEqual(d.signals.slice(0, 1), [4242]);
  } finally { stop(); }
  const after = calls + d.signals.length; await delay(30);
  assert.equal(calls + d.signals.length, after, "no check runs after the connection ends");
});

test("the ownership record names the listener's release and pid only while it describes the live alias", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const folder = await shortFolder("gw-ssh-upg-");
  const path = join(folder.directory, "app-server-control/app-server-control.sock");
  const controller = new AbortController();
  const serving = serveUnix(path, controller.signal, async () => {}, "1.6.2"); serving.catch(() => {});
  try {
    for (let i = 0; i < 200 && !await lstat(path).then(() => true, () => false); i++) await delay(10);
    const owner = await sshListenerOwner(path);
    assert.equal(owner?.release, "1.6.2"); assert.equal(owner?.pid, process.pid); assert.equal(typeof owner?.startedAtMs, "number");
    assert.equal(await sshListenerOwner(join(folder.directory, "missing.sock")), undefined);
  } finally { controller.abort(); await serving.catch(() => {}); await folder.remove(); }
});

test("a declined request is followed up out of step with the regular checks, then the regular checks resume", async () => {
  // The listener declines every request: each one leaves its record busy with a decline at least as recent as the request.
  let record: ListenerRecord = { pid: 4242, startedAt, busy: false };
  const asked: number[] = [];
  const d = deps({ activity: async () => record });
  d.value.signal = () => { asked.push(Date.now()); record = { pid: 4242, startedAt, busy: true, declinedAt: Date.now() }; };
  const stop = watchStaleListener("/home", "/sock", { firstMs: 5, everyMs: 400, jitterMs: 0, followUpsMs: [30, 60] }, d.value);
  try {
    for (let i = 0; i < 100 && asked.length < 3; i++) await delay(5);
    assert.equal(asked.length, 3, "the first request and both follow-ups are sent although the record reads busy from the declines");
    assert.ok(asked[1]! - asked[0]! >= 25 && asked[2]! - asked[1]! >= 55, "each follow-up waits its own delay");
    await delay(150);
    assert.equal(asked.length, 3, "after the follow-ups, a record busy from a recent decline is trusted until the regular check");
  } finally { stop(); }
});

test("a listener busy with its own work before any request is not asked at all", async () => {
  const asked: number[] = [];
  const d = deps({ record: { pid: 4242, startedAt, busy: true } }); // A turn or an approval, and no decline recorded.
  d.value.signal = () => { asked.push(Date.now()); };
  const stop = watchStaleListener("/home", "/sock", { firstMs: 5, everyMs: 20, jitterMs: 0, followUpsMs: [20, 20] }, d.value);
  try { await delay(120); assert.equal(asked.length, 0); } finally { stop(); }
});
