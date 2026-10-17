import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { healthIntervalMs, startHealthSchedule } from "../health-schedule.js";
import { shortFolder } from "./short-folder.js";

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

/** A timer bank the test drives itself: nothing fires until the tick is pulled. */
function fakeTimers() {
  const armed: Array<{ tick: () => void; ms: number; cancelled: boolean }> = [];
  return {
    set(tick: () => void, ms: number) { const entry = { tick, ms, cancelled: false }; armed.push(entry); return () => { entry.cancelled = true; }; },
    fire(index = 0) { armed[index]!.tick(); },
    get count() { return armed.length; },
    get ms() { return armed[0]!.ms; },
  };
}

/** One schedule with a counting run and a switch for the URL's presence. */
function harness(extra: { exists?: (path: string) => Promise<boolean>; timers?: ReturnType<typeof fakeTimers> } = {}) {
  const calls: Array<{ resolve: () => void; done: Promise<void> }> = [];
  const seen: string[] = [];
  const stop = startHealthSchedule({
    stateDirectory: "/state",
    timers: extra.timers ?? fakeTimers(),
    exists: extra.exists ?? (async path => { seen.push(path); return true; }),
    run: () => new Promise<void>(resolve => calls.push({ resolve: () => resolve(), done: settle() })),
  });
  return { calls, seen, stop };
}

test("the first tick waits a full interval, and nothing starts at once", async () => {
  const timers = fakeTimers();
  const { calls } = harness({ timers });
  assert.equal(timers.count, 1);
  assert.equal(timers.ms, healthIntervalMs);
  assert.equal(healthIntervalMs, 10 * 60_000);
  assert.equal(calls.length, 0);
  timers.fire();
  await settle();
  assert.equal(calls.length, 1);
});

test("an unfinished tick is skipped, and the next one goes after", async () => {
  const timers = fakeTimers();
  const { calls } = harness({ timers });
  timers.fire();
  await settle();
  timers.fire();
  timers.fire();
  assert.equal(calls.length, 1, "overlap started anyway");
  calls[0]!.resolve();
  await calls[0]!.done;
  timers.fire();
  await settle();
  assert.equal(calls.length, 2);
});

test("no monitor URL means no health run, but the timer keeps checking", async () => {
  const timers = fakeTimers();
  const paths: string[] = [];
  const { calls } = harness({ timers, exists: async path => { paths.push(path); return false; } });
  timers.fire();
  await settle();
  assert.equal(calls.length, 0);
  assert.deepEqual(paths, ["/state/alert-push-url"]);
});

test("a refusing URL check never stops the heartbeat", async () => {
  const timers = fakeTimers();
  const { calls } = harness({ timers, exists: async () => { throw new Error("EIO"); } });
  timers.fire();
  await settle();
  assert.equal(calls.length, 0);
  timers.fire();
  await settle();
  assert.equal(calls.length, 0);
});

test("a rejected run is swallowed and the next tick still works", async () => {
  const timers = fakeTimers();
  let first = true;
  const calls: number[] = [];
  const stop = startHealthSchedule({ stateDirectory: "/state", timers, exists: async () => true, run: async () => {
    calls.push(calls.length);
    if (first) { first = false; throw new Error("probe exploded"); }
  } });
  timers.fire();
  await settle();
  timers.fire();
  await settle();
  assert.deepEqual(calls, [0, 1]);
  stop();
});

test("stopping cancels the timer and refuses late ticks", async () => {
  const timers = fakeTimers();
  const { calls, stop } = harness({ timers });
  stop();
  timers.fire();
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(timers.count, 1);
});

test("the real timer never holds the process open", async () => {
  let unrefed = 0;
  let ms = 0;
  let cleared = false;
  const original = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  try {
    globalThis.setInterval = ((tick: () => void, interval: number) => { ms = interval; void tick; return { unref() { unrefed++; }, ref() {} } as unknown as NodeJS.Timeout; }) as typeof setInterval;
    globalThis.clearInterval = (() => { cleared = true; }) as typeof clearInterval;
    const stop = startHealthSchedule({ stateDirectory: "/state", exists: async () => false, run: async () => {} });
    assert.equal(unrefed, 1);
    assert.equal(ms, healthIntervalMs);
    stop();
    assert.equal(cleared, true);
  } finally {
    globalThis.setInterval = original;
    globalThis.clearInterval = originalClear;
  }
});

test("a tick that is still running when the schedule stops cannot hold the process open", { skip: process.platform === "win32" }, async () => {
  // The harness is a process of its own: the only honest way to ask whether anything still
  // keeps an event loop alive. It starts one real smoke-shaped check, stops the schedule a
  // moment later, and is expected to leave with it.
  const folder = await shortFolder("gw-stop-");
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await writeFile(join(folder.directory, "check.mjs"), [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const child = spawn('/bin/sleep', ['120'], { stdio: 'ignore', detached: true });",
    "// launchSmoke hands the check the real arguments; the run folder is the one it was given.",
    "const at = process.argv.indexOf('--root');",
    "writeFileSync(process.argv[at + 1] + '/sleep.pid', String(child.pid));",
    "process.on('SIGTERM', () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { } process.exit(1); });",
    "await new Promise(() => { });",
    "",
  ].join("\n"));
  const module = (name: string) => JSON.stringify(join(dist, name).replace(/\\/g, "/"));
  await writeFile(join(folder.directory, "harness.mjs"), [
    `import { startHealthSchedule } from ${module("health-schedule.js")};`,
    `import { launchSmoke } from ${module("health-smoke.js")};`,
    "const root = process.argv[2];",
    "const stop = startHealthSchedule({",
    "  stateDirectory: root, intervalMs: 40, exists: async () => true,",
    "  run: signal => launchSmoke({ runtime: process.execPath, script: root + '/check.mjs', gateway: '/g', packageRoot: '/p', codex: '/c',",
    "    root, timeoutMs: 600000, graceMs: 3000, env: process.env, signal }),",
    "});",
    "// The schedule only ticks while the timer says so; a stop mid-flight must end what it started.",
    "const timer = setInterval(() => {}, 50);",
    "setTimeout(() => { clearInterval(timer); stop(); }, 400);",
    "process.on('beforeExit', () => process.stderr.write('idle\\n'));",
    "",
  ].join("\n"));
  const child = spawn(process.execPath, [join(folder.directory, "harness.mjs"), folder.directory], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  // The suite's own per-test timeout is far longer than this; the shortness is the assertion.
  const exited = await Promise.race([
    new Promise<number | null>(resolve => child.once("close", code => resolve(code))),
    new Promise<null>(resolve => setTimeout(() => resolve(null), 3000)),
  ]);
  if (exited === null) child.kill("SIGKILL");
  assert.notEqual(exited, null, "a stopped schedule kept the process alive: " + stderr);
  assert.match(stderr, /idle/);
  // And the child that check started left with it, rather than running on as an orphan.
  const pid = Number(await readFile(join(folder.directory, "sleep.pid"), "utf8").catch(() => "0"));
  assert.ok(pid > 0, "the harness never started its check child");
  const end = Date.now() + 3000;
  let gone = false;
  while (Date.now() < end) {
    try { process.kill(pid, 0); } catch { gone = true; break; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(gone, `the smoke's child (pid ${pid}) outlived the schedule that started it`);
  await folder.remove();
});
