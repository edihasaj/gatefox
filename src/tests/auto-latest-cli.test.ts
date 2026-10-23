import test from "node:test";
import assert from "node:assert/strict";
import { checkExitCode, runAutoLatestCli, sanitizeCheckResult, type AutoLatestCliTools } from "../auto-latest-cli.js";

function harness(reconcile: AutoLatestCliTools["reconcile"], extra: Partial<AutoLatestCliTools> = {}) {
  const out: string[] = []; const events: string[] = [];
  let stop: (() => void) | undefined;
  const tools: AutoLatestCliTools = {
    reconcile, prepareTemp: async () => "/tmp/job", trimLog: async () => { events.push("trim"); }, status: async () => ({ supported: true }),
    stdout: text => out.push(text), useTemp: directory => events.push(`tmp:${directory}`),
    onStop: abort => { stop = abort; return () => { events.push("released"); }; }, ...extra,
  };
  return { tools, out, events, stop: () => stop?.() };
}
const done = { outcome: "updated", changed: true, activated: 2, providersChecked: 3, providersFailed: 0, nativeUpdated: true, checkedAt: 1700000000 };

test("check prints only the fixed fields and maps outcomes to exit codes", async () => {
  const h = harness(async () => ({ ...done, secret: "token", error: new Error("raw provider text") }));
  assert.equal(await runAutoLatestCli(["check", "--config", "/c.json"], h.tools), 0);
  assert.deepEqual(JSON.parse(h.out.join("")), done);
  for (const [outcome, code] of [["unchanged", 0], ["baseline", 0], ["partial", 0], ["disabled", 0], ["busy", 75], ["cancelled", 75], ["stale", 75], ["failed", 1]] as const) {
    assert.equal(checkExitCode(outcome), code, outcome);
  }
  assert.equal(sanitizeCheckResult({ outcome: "exploded", activated: -1, providersChecked: "3" }).outcome, "failed");
  assert.equal(sanitizeCheckResult(undefined).checkedAt, 0);
});

test("an engine that throws yields a fixed failure and never its message", async () => {
  const h = harness(async () => { throw new Error("Bearer abc123 /secret/path"); });
  assert.equal(await runAutoLatestCli(["check", "--config", "/c.json"], h.tools), 1);
  assert.deepEqual(JSON.parse(h.out.join("")), { outcome: "failed", reason: "check_failed" });
  assert.equal(h.out.join("").includes("abc123"), false);
  assert.deepEqual(h.events, ["released"], "an interactive check keeps the person's TMPDIR");
});

test("a stop signal aborts the pass that is running", async () => {
  let seen: AbortSignal | undefined;
  const h = harness((_path, options) => new Promise(resolve => { seen = options.signal; seen.addEventListener("abort", () => resolve({ ...done, outcome: "cancelled", changed: false })); }));
  const run = runAutoLatestCli(["check", "--config", "/c.json"], h.tools) as Promise<number>;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen?.aborted, false);
  h.stop();
  assert.equal(await run, 75);
  assert.equal(seen?.aborted, true);
});

test("the scheduled job prepares its private TMPDIR first, and fails closed without it", async () => {
  const h = harness(async () => done);
  assert.equal(await runAutoLatestCli(["check", "--config", "/c.json", "--scheduled"], h.tools), 0);
  assert.deepEqual(h.events.slice(0, 2), ["tmp:/tmp/job", "trim"]);
  const bad = harness(async () => done, { prepareTemp: async () => { throw new Error("unsafe"); } });
  assert.equal(await runAutoLatestCli(["check", "--config", "/c.json", "--scheduled"], bad.tools), 1);
  assert.deepEqual(JSON.parse(bad.out.join("")), { outcome: "failed", reason: "temp_unavailable" });
});

test("probe, status and usage errors", async () => {
  const h = harness(async () => done);
  assert.equal(await runAutoLatestCli(["probe"], h.tools), 0);
  assert.deepEqual(JSON.parse(h.out.join("")), { autoLatest: 1 });
  const s = harness(async () => done);
  assert.equal(await runAutoLatestCli(["status", "--config", "/c.json"], s.tools), 0);
  assert.deepEqual(JSON.parse(s.out.join("")), { supported: true });
  for (const args of [[], ["bogus"], ["check", "extra"], ["status", "--scheduled"], ["check", "--nope"]]) {
    const u = harness(async () => done);
    assert.equal(await runAutoLatestCli(args, u.tools), 2, args.join(" "));
  }
});
