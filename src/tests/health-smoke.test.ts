import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchSmoke, runSmoke, smokeEnvironment, smokeRoot, smokeScript, type SmokeDeps, type SmokeLaunch } from "../health-smoke.js";
import { smokeKillGraceMs, smokeTimeoutMs, type AppInfo } from "../health-types.js";
import { shortFolder } from "./short-folder.js";

const at = Date.parse("2026-10-16T09:00:00.000Z");
const app: AppInfo = { state: "found", path: "/Apps/ChatGPT.app", enginePath: "/Apps/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", bundle: "26.10", engine: "0.99.1" };
const targets = { gateway: "/install/current/package/dist/cli.js", packageRoot: "/install/current/package" };

/** runSmoke with the filesystem and the child process replaced, and everything it saw captured. */
async function probe(answer: () => Promise<"pass" | "fail" | "unavailable">, extra: Partial<SmokeDeps> = {}) {
  const launches: SmokeLaunch[] = [];
  const roots: string[] = [];
  let dropped: string | undefined;
  const outcome = await runSmoke(app, "/state", {
    now: () => at,
    exists: async () => true,
    targets: async () => targets,
    makeRoot: async path => { roots.push(path); },
    dropRoot: async path => { dropped = path; },
    run: async launch => { launches.push(launch); return { result: await answer() } as never; },
    ...extra,
  });
  return { outcome, launches, roots, dropped };
}

test("the script and the run folder are where the package puts them", () => {
  assert.match(smokeScript(`file:///install/current/package/dist/${"health-smoke.js"}`), /\/install\/current\/package\/scripts\/e2e-fast-mode\.mjs$/);
  assert.equal(smokeRoot("/state", at), "/state/health/smoke-" + at);
});

test("the check sees only PATH, HOME, TMPDIR and LANG", () => {
  const env = smokeEnvironment({ PATH: "/bin", HOME: "/h", TMPDIR: "/t", LANG: "en", OPENAI_API_KEY: "secret", PROXY_AUTHORIZATION: "bearer x" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH", "TMPDIR"]);
});

test("a pass reaches the runner with the installed paths and a fresh private root", async () => {
  const { outcome, launches, roots, dropped } = await probe(async () => "pass");
  assert.deepEqual(outcome, { result: "pass" });
  assert.equal(launches.length, 1);
  const launch = launches[0]!;
  assert.equal(launch.gateway, targets.gateway);
  assert.equal(launch.packageRoot, targets.packageRoot);
  assert.equal(launch.codex, app.enginePath);
  assert.match(launch.script, /scripts\/e2e-fast-mode\.mjs$/);
  assert.equal(launch.timeoutMs, smokeTimeoutMs);
  assert.equal(smokeTimeoutMs, 10 * 60_000);
  assert.equal(launch.runtime, process.execPath);
  assert.deepEqual(roots, [smokeRoot("/state", at)]);
  assert.equal(dropped, roots[0]);
});

test("a failing answer reads as fail, and a throw as unavailable", async () => {
  assert.equal((await probe(async () => "fail")).outcome.result, "fail");
  const outcome = await runSmoke(app, "/state", { now: () => at, exists: async () => true, targets: async () => targets,
    makeRoot: async () => {}, dropRoot: async () => {}, run: async () => { throw new Error("child refused to start"); } });
  assert.deepEqual(outcome, { result: "unavailable" });
});

test("no app, no script, or no installed release leaves the answer unavailable", async () => {
  const absent = await runSmoke({ ...app, state: "absent", enginePath: "" }, "/state", { now: () => at, run: async () => { throw new Error("must not run"); } });
  assert.deepEqual(absent, { result: "unavailable" });
  const noScript = await probe(async () => "pass", { exists: async path => !path.endsWith("e2e-fast-mode.mjs") });
  assert.deepEqual(noScript.outcome, { result: "unavailable" });
  assert.equal(noScript.launches.length, 0);
  const noInstall = await probe(async () => "pass", { targets: async () => undefined });
  assert.deepEqual(noInstall.outcome, { result: "unavailable" });
  const targetsThrow = await probe(async () => "pass", { targets: async () => { throw new Error("no install scope"); } });
  assert.deepEqual(targetsThrow.outcome, { result: "unavailable" });
});

test("the run folder is dropped even when the check itself fails", async () => {
  const { roots, dropped } = await probe(async () => { throw new Error("spawn EACCES"); });
  assert.equal(dropped, roots[0]);
});

test("the real root is made private and removed afterwards", async () => {
  const folder = await shortFolder("gw-smoke-");
  const directory = folder.directory;
  let root = "";
  const outcome = await runSmoke(app, directory, { now: () => at, exists: async () => true, targets: async () => targets,
    run: async launch => {
      root = launch.root;
      assert.ok(root.startsWith(join(directory, "health", "smoke-")));
      const during = await stat(root);
      assert.equal(during.mode & 0o777, 0o700, "the check must not run in a group-readable folder");
      return { result: "pass" };
    } });
  assert.deepEqual(outcome, { result: "pass" });
  await assert.rejects(() => stat(root), (error: unknown) => (error as { code?: string }).code === "ENOENT");
  await folder.remove();
});

/**
 * launchSmoke against a script of our own, in a folder of our own. The fake takes the same
 * arguments as the packaged check and ignores all but the one it is told to demonstrate.
 */
async function fakeSmoke(body: string) {
  const folder = await shortFolder("gw-launch-");
  const script = join(folder.directory, "check.mjs");
  await writeFile(script, `import { spawn } from "node:child_process";\nconst out = (line) => process.stdout.write(line);\nconst nl = String.fromCharCode(10);\n${body}\n`);
  const launch: SmokeLaunch = {
    runtime: process.execPath, script, gateway: "/g", packageRoot: "/p", codex: "/c",
    root: join(folder.directory, "run"), timeoutMs: 30_000, graceMs: 2_000, env: smokeEnvironment(),
  };
  return { folder, launch };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const untilSettled = async (check: () => Promise<boolean>, ms = 4_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await new Promise(resolve => setTimeout(resolve, 25)); }
  return false;
};
async function untilGone(pid: number, ms = 5_000) {
  const end = Date.now() + ms;
  while (alive(pid)) { if (Date.now() > end) return false; await new Promise(resolve => setTimeout(resolve, 25)); }
  return true;
}

test("a check that passes is a pass, and one that fails names its phase", async () => {
  const good = await fakeSmoke(`out(JSON.stringify({ phase: "verification", passed: true }) + nl);`);
  assert.deepEqual(await launchSmoke(good.launch), { result: "pass" });
  await good.folder.remove();
  // The failing row says where it stopped, and that is the only thing read out of it.
  const bad = await fakeSmoke(`out(JSON.stringify({ phase: "verification", passed: false, failedPhase: "stdio-fast" }) + nl); process.exit(1);`);
  assert.deepEqual(await launchSmoke(bad.launch), { result: "fail", phase: "stdio-fast" });
  await bad.folder.remove();
  // A failure row whose phase is not a phase name still fails, as `unknown`.
  const odd = await fakeSmoke(`out(JSON.stringify({ passed: false, failedPhase: "TypeError: /x/y.mjs:3:1" }) + nl); process.exit(1);`);
  assert.deepEqual(await launchSmoke(odd.launch), { result: "fail", phase: "unknown" });
  await odd.folder.remove();
});

test("a timed-out check stops its whole group, not only the script", { skip: process.platform === "win32" }, async () => {
  const { folder, launch } = await fakeSmoke([
    // Runs past the timeout, and takes its own child down when it is asked, like the real check.
    "const child = spawn(\"/bin/sleep\", [\"60\"], { stdio: \"ignore\", detached: true });",
    "await import(\"node:fs/promises\").then(fs => fs.writeFile(process.env.FAKE_PID_FILE, String(child.pid)));",
    "process.on(\"SIGTERM\", () => { try { process.kill(-child.pid, \"SIGKILL\"); } catch { } process.exit(1); });",
    "await new Promise(() => { });",
  ].join("\n"));
  const pidFile = join(folder.directory, "child.pid");
  launch.timeoutMs = 400;
  launch.env = { ...launch.env, FAKE_PID_FILE: pidFile };
  const answer = await launchSmoke(launch);
  assert.deepEqual(answer, { result: "fail", phase: "timeout" });
  const started = Number(await readFile(pidFile, "utf8"));
  assert.ok(started > 0);
  assert.ok(await untilGone(started), "the check's own child outlived the timeout: only the script was killed");
  await folder.remove();
});

test("an aborted check stops its group and answers nothing at all", { skip: process.platform === "win32" }, async () => {
  const controller = new AbortController();
  const { folder, launch } = await fakeSmoke([
    "const child = spawn(\"/bin/sleep\", [\"60\"], { stdio: \"ignore\", detached: true });",
    "await import(\"node:fs/promises\").then(fs => fs.writeFile(process.env.FAKE_PID_FILE, String(child.pid)));",
    "process.on(\"SIGTERM\", () => { try { process.kill(-child.pid, \"SIGKILL\"); } catch { } process.exit(1); });",
    "await new Promise(() => { });",
  ].join("\n"));
  const pidFile = join(folder.directory, "child.pid");
  launch.env = { ...launch.env, FAKE_PID_FILE: pidFile };
  launch.signal = controller.signal;
  const answer = launchSmoke(launch);
  // Let the check get as far as starting its own child, then stop the service under it.
  await untilSettled(async () => (await readFile(pidFile, "utf8").catch(() => "")).length > 0);
  controller.abort();
  assert.deepEqual(await answer, { result: "unavailable" }, "an aborted run answers nothing, so nothing is recorded");
  assert.ok(await untilGone(Number(await readFile(pidFile, "utf8"))), "the abort left the check's child running");
  await folder.remove();
});

test("the signal reaches the runner through runSmoke, and the folder still goes", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  let dropped: string | undefined;
  const outcome = await runSmoke(app, "/state", {
    now: () => at, exists: async () => true, targets: async () => targets,
    makeRoot: async () => {}, dropRoot: async path => { dropped = path; },
    graceMs: smokeKillGraceMs, signal: controller.signal,
    run: async launch => { seen = launch.signal; return { result: "unavailable" as const }; },
  });
  assert.equal(seen, controller.signal);
  assert.deepEqual(outcome, { result: "unavailable" });
  assert.equal(dropped, smokeRoot("/state", at));
});

// The check's own child sits in the check's group and ignores SIGTERM, as the engine's git does while it is waiting on the network.
const stubbornChild = [
  "const child = spawn(\"/bin/sh\", [\"-c\", \"trap '' TERM; exec sleep 60\"], { stdio: \"ignore\" });",
  "await import(\"node:fs/promises\").then(fs => fs.writeFile(process.env.FAKE_PID_FILE, process.pid + \" \" + child.pid));",
];
const pids = async (file: string) => (await readFile(file, "utf8")).split(" ").map(Number);

test("a check that ignores SIGTERM is killed after the grace, with the child in its group", { skip: process.platform === "win32" }, async () => {
  const { folder, launch } = await fakeSmoke([...stubbornChild, "process.on(\"SIGTERM\", () => { });", "await new Promise(() => { });"].join("\n"));
  const pidFile = join(folder.directory, "pids");
  launch.timeoutMs = 300; launch.graceMs = 400;
  launch.env = { ...launch.env, FAKE_PID_FILE: pidFile };
  const started = Date.now();
  assert.deepEqual(await launchSmoke(launch), { result: "fail", phase: "timeout" });
  assert.ok(Date.now() - started >= 600, "SIGKILL must wait for the grace, not replace the polite ask");
  const [script, child] = await pids(pidFile);
  assert.ok(await untilGone(script!), "the check ignored SIGTERM and SIGKILL did not follow");
  assert.ok(await untilGone(child!), "SIGKILL left the check's child running");
  await folder.remove();
});

test("a check that exits on SIGTERM still has its group swept of what it left behind", { skip: process.platform === "win32" }, async () => {
  const { folder, launch } = await fakeSmoke([...stubbornChild, "process.on(\"SIGTERM\", () => process.exit(1));", "await new Promise(() => { });"].join("\n"));
  const pidFile = join(folder.directory, "pids");
  launch.timeoutMs = 300; launch.graceMs = 30_000;
  launch.env = { ...launch.env, FAKE_PID_FILE: pidFile };
  const started = Date.now();
  assert.deepEqual(await launchSmoke(launch), { result: "fail", phase: "timeout" });
  assert.ok(Date.now() - started < 10_000, "the answer waited for the grace");
  const [, child] = await pids(pidFile);
  assert.ok(await untilGone(child!), "the child that ignores SIGTERM outlived the check");
  await folder.remove();
});

test("a run asked to stop before it starts starts nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const { folder, launch } = await fakeSmoke(`await import("node:fs/promises").then(fs => fs.writeFile(process.env.FAKE_PID_FILE, "started"));`);
  const marker = join(folder.directory, "started");
  launch.env = { ...launch.env, FAKE_PID_FILE: marker }; launch.signal = controller.signal;
  assert.deepEqual(await launchSmoke(launch), { result: "unavailable" });
  await new Promise(resolve => setTimeout(resolve, 300));
  await assert.rejects(() => stat(marker), (error: unknown) => (error as { code?: string }).code === "ENOENT");
  await folder.remove();
  // runSmoke does not even make the folder or look for the install.
  const made: string[] = [];
  let looked = false;
  const outcome = await runSmoke(app, "/state", {
    now: () => at, exists: async () => true, targets: async () => { looked = true; return targets; },
    makeRoot: async path => { made.push(path); }, dropRoot: async () => {}, signal: controller.signal,
    run: async () => { throw new Error("must not run"); },
  });
  assert.deepEqual(outcome, { result: "unavailable" });
  assert.deepEqual(made, []);
  assert.equal(looked, false);
});
