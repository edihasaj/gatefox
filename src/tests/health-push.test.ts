import test from "node:test";
import assert from "node:assert/strict";
import { chmod, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shortFolder } from "./short-folder.js";
import { pushFindings, pushRequest, pushSummary, pushUrlPath, pushVerdict, readPushUrl, summaryLimit, type PushUrlReadResult } from "../health-push.js";
import { pushTimeoutMs, type Finding } from "../health-types.js";

/** A monitor URL whose every part is recognizable if it ever leaks into an output. */
const url = "https://kuma.invalid.example/api/push/aBcDeF-s3cr3t";
const findings = (...reasons: Array<[Finding["level"], string]>): Finding[] => reasons.map(([level, reason]) => ({ level, reason }));
const folders: Array<() => Promise<void>> = [];
async function dir() {
  const folder = await shortFolder("gw-push-");
  folders.push(folder.remove);
  return folder.directory;
}

test("the URL file lives in the state directory, never in the report", () => {
  assert.equal(pushUrlPath("/state"), "/state/alert-push-url");
});

test("a private regular file this user owns is accepted", async () => {
  const path = join(await dir(), "alert-push-url");
  await writeFile(path, url + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
  assert.deepEqual(await readPushUrl(path), { url });
});

test("group or other permission bits refuse the file", async () => {
  for (const mode of [0o644, 0o604, 0o600 ^ 0o077]) {
    const path = join(await dir(), "alert-push-url");
    await writeFile(path, url, { mode: 0o600 });
    await chmod(path, mode);
    const result = await readPushUrl(path);
    assert.deepEqual(result, { error: "insecure" });
    assert.equal(JSON.stringify(result).includes(url), false);
  }
});

test("anything that is not a regular file is refused", async () => {
  // A directory is the world-readable stand-in: never a monitor URL, always refused.
  const result: PushUrlReadResult = await readPushUrl(await dir());
  assert.deepEqual(result, { error: "insecure" });
});

// A file owned by another user cannot be made without privileges; that branch of the
// same check is exercised through the injected reader in health.test.ts.

test("another owner's file is refused, through the stat this run trusts", async () => {
  // No privileges are needed to describe the case: the reader is handed the inode answer.
  const path = join(await dir(), "alert-push-url");
  await writeFile(path, url + "\n", { mode: 0o600 });
  const foreign = await readPushUrl(path, { stat: async () => ({ mode: 0o600, uid: (process.getuid?.() ?? 0) + 1, isFile: true }) });
  assert.deepEqual(foreign, { error: "insecure" });
  assert.equal(JSON.stringify(foreign).includes(url), false);
  // A file this user owns, described the same way, is the file the run reads.
  assert.deepEqual(await readPushUrl(path, { stat: async () => ({ mode: 0o600, uid: process.getuid?.() ?? 0, isFile: true }) }), { url });
});

test("a link at the URL path is refused, not followed", async () => {
  const folder = await dir();
  const target = join(folder, "somewhere-else");
  await writeFile(target, url + "\n", { mode: 0o600 });
  const link = join(folder, "alert-push-url");
  await symlink(target, link);
  assert.deepEqual(await readPushUrl(link), { error: "insecure" });
});

test("a missing file is missing, and odd contents are refused", async () => {
  assert.deepEqual(await readPushUrl(join(await dir(), "absent")), { error: "missing" });
  const bad = ["", "   ", url + "\n" + url, "ftp://insecure.example/x", "not a url at all", "https:///no-host", "x".repeat(2050)];
  for (const text of bad) {
    const path = join(await dir(), "alert-push-url");
    await writeFile(path, text, { mode: 0o600 });
    assert.deepEqual(await readPushUrl(path), { error: "insecure" }, text.slice(0, 12));
  }
});

test("the summary leads with the verdict, drops info, and fits the limit", () => {
  assert.equal(pushSummary("ok", []), "gateway ok");
  assert.equal(pushSummary("warn", findings(["info", "app changed"], ["warn", "lagging service@0.4.3"])), "gateway warn: lagging service@0.4.3");
  // Findings past the budget are dropped whole; the text never spills over.
  const long = findings(["fail", "x".repeat(150)], ["fail", "y".repeat(150)]);
  const text = pushSummary("fail", long);
  assert.equal(text, `gateway fail: ${"x".repeat(150)}`.slice(0, summaryLimit));
  assert.ok(text.length <= summaryLimit);
});

test("one monitor request: status, url-encoded message, and the ping", async () => {
  assert.equal(new URL(pushRequest(url, "up", "a b&c")).searchParams.get("msg"), "a b&c");
  assert.equal(pushRequest(url, "up", "a b&c"), `${url}?status=up&msg=a%20b%26c&ping=`);
  // A query the copy-pasted URL already carries is answered, not doubled: the second copy would
  // be the one Uptime Kuma reads, and it would say OK forever.
  const kuma = `${url}?status=up&msg=OK&ping=`;
  const replaced = pushRequest(kuma, "down", "gateway fail: stale service@0.4.1");
  const params = new URL(replaced).searchParams;
  assert.equal(params.get("status"), "down");
  assert.equal(params.get("msg"), "gateway fail: stale service@0.4.1");
  assert.equal(params.getAll("status").length, 1);
  assert.equal(params.getAll("msg").length, 1);
  assert.equal(params.getAll("ping").length, 1);
  assert.equal(replaced.includes("OK"), false);
  assert.equal(pushRequest(url + "?x=1", "down", "m"), `${url}?x=1&status=down&msg=m&ping=`);
  // The path belongs to the token and travels as it was given, trailing slash and all.
  assert.ok(pushRequest(`${url}/`, "up", "m").startsWith(`${url}/?`));
  assert.ok(pushRequest(url, "up", "m").startsWith(`${url}?`));
  for (const [verdict, status] of [["ok", "up"], ["warn", "up"], ["fail", "down"]] as const) {
    let request = "";
    const outcome = await pushVerdict(url, verdict, findings(["warn", "lagging inference@0.4.3"]), {
      send: async target => { request = target; return { ok: true, status: 200 }; },
    });
    assert.ok(request.startsWith(`${url}?status=${status}&msg=`));
    assert.ok(request.endsWith("&ping="));
    assert.equal(new URL(request).searchParams.get("msg"), `gateway ${verdict}: lagging inference@0.4.3`);
    assert.deepEqual(outcome, { state: "sent", up: verdict !== "fail" });
  }
});

test("the heartbeat arms its timeout and names failures without naming the monitor", async () => {
  assert.equal(pushTimeoutMs, 10_000);
  const signals: AbortSignal[] = [];
  const ok = await pushVerdict(url, "ok", [], { send: async (_request, signal) => { signals.push(signal); return { ok: true, status: 200 }; } });
  assert.equal(signals[0] instanceof AbortSignal, true);
  assert.equal(signals[0].aborted, false);
  assert.deepEqual(ok, { state: "sent", up: true });
  const failings: Array<[unknown, string]> = [
    [Object.assign(new Error("deadline"), { name: "TimeoutError" }), "timeout"],
    [Object.assign(new Error("aborted"), { name: "AbortError" }), "timeout"],
    [new TypeError("fetch failed"), "network"],
  ];
  for (const [error, expected] of failings) {
    const outcome = await pushVerdict(url, "fail", [], { send: async () => { throw error; } });
    assert.deepEqual(outcome, { state: "failed", error: expected });
    assert.equal(JSON.stringify(outcome).includes(url), false);
  }
  const rejected = await pushVerdict(url, "warn", [], { send: async () => ({ ok: false, status: 502 }) });
  assert.deepEqual(rejected, { state: "failed", error: "http_502" });
});

test("a stopped service cancels the heartbeat that is in flight", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const sending = pushVerdict(url, "ok", [], { signal: controller.signal, send: (_request, signal) => new Promise((_resolve, reject) => {
    seen = signal; signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen?.aborted, false);
  controller.abort();
  assert.deepEqual(await sending, { state: "failed", error: "timeout" });
  assert.equal(seen?.aborted, true);
  // Without a caller's signal the request still has its own timeout signal.
  let own: AbortSignal | undefined;
  await pushVerdict(url, "ok", [], { send: async (_request, signal) => { own = signal; return { ok: true, status: 200 }; } });
  assert.equal(own?.aborted, false);
});

test("push findings carry outcomes, not the URL", () => {
  assert.deepEqual(pushFindings({ state: "sent", up: false }), []);
  assert.deepEqual(pushFindings({ state: "skipped" }), [{ level: "info", reason: "alert push not configured" }]);
  assert.deepEqual(pushFindings({ state: "insecure" }), [{ level: "fail", reason: "alert push url not private" }]);
  assert.deepEqual(pushFindings({ state: "failed", error: "timeout" }), [{ level: "warn", reason: "alert push failed (timeout)" }]);
  assert.equal(JSON.stringify(pushFindings({ state: "failed", error: "http_500" })).includes(url), false);
});

test("the push tests leave no folder behind", async () => {
  // Every folder above is this suite's own, and `npm test` counts what the run left in the temp root.
  for (const remove of folders) await remove();
});
