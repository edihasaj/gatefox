import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// `npm test` must fail a broken test instead of hanging on it, and must leave no process behind however the run ends. These
// tests run the runner (scripts/run-tests.mjs) on small suites of their own; a nested run starts as a run of its own.
const runner = fileURLToPath(new URL("../../scripts/run-tests.mjs", import.meta.url));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exists = (path: string) => stat(path).then(() => true, () => false);
const wait = async (check: () => boolean | Promise<boolean>, ms: number) => { const started = Date.now(); while (!(await check())) { if (Date.now() - started > ms) return false; await new Promise(resolve => setTimeout(resolve, 25)); } return true; };

async function workspace() {
  const work = await mkdtemp(join(tmpdir(), "gateway-runner-suite-"));
  const environment: NodeJS.ProcessEnv = { ...process.env, RUNNER_RECORD: join(work, "record.json") }; delete environment.NODE_TEST_CONTEXT;
  const suite = async (name: string, body: string) => { const file = join(work, `${name}.test.mjs`); await writeFile(file, `import test from "node:test";\n${body}\n`); return file; };
  return { work, environment, suite, record: async () => JSON.parse(await readFile(join(work, "record.json"), "utf8")) as { tmpdir: string; pids: number[] } };
}
/** Runs the runner on `files`; settles with how it ended. */
async function run(environment: NodeJS.ProcessEnv, files: string[], extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [runner, ...files], { env: { ...environment, ...extra }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += String(chunk); });
  const started = Date.now(); const [code, signal] = await once(child, "exit") as [number | null, string | null];
  return { code, signal, stderr, elapsed: Date.now() - started };
}

test("a test that never ends fails the run at the backstop, though a handle it left open would keep the process alive", { timeout: 60000 }, async () => {
  const w = await workspace();
  try {
    const file = await w.suite("hangs", `test("never ends", () => { setInterval(() => {}, 1000); return new Promise(() => {}); });`);
    const result = await run(w.environment, [file], { GATEWAY_TEST_TIMEOUT_MS: "1500" });
    assert.notEqual(result.code, 0, "the run failed"); assert.ok(result.elapsed < 20000, `and did not hang (${result.elapsed} ms)`);
  } finally { await rm(w.work, { recursive: true, force: true }); }
});

test("a test file whose tests passed exits though a fixture handle is still open", { timeout: 60000 }, async () => {
  const w = await workspace();
  try {
    const file = await w.suite("open-handle", `test("passes", () => { setInterval(() => {}, 1000); });`);
    const result = await run(w.environment, [file]);
    assert.equal(result.code, 0); assert.ok(result.elapsed < 20000, `it did not wait for the handle (${result.elapsed} ms)`);
  } finally { await rm(w.work, { recursive: true, force: true }); }
});

test("a signal stops the runner with 128 plus the signal, kills every process of the run, even one that ignores it, and removes the folder", { skip: process.platform === "win32", timeout: 90000 }, async () => {
  const signals = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const;
  for (const [name, number] of Object.entries(signals)) {
    for (const stubborn of [false, true]) {
      const w = await workspace();
      let child: ChildProcess | undefined; let started: { tmpdir: string; pids: number[] } | undefined; let passed = false;
      try {
        // The test records its own pid and a helper's, and then waits for ever. A stubborn one ignores the signal it is sent.
        const file = await w.suite("waits", `import { spawn } from "node:child_process"; import { renameSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os";
${stubborn ? `process.on("${name}", () => {});` : ""}
test("waits", () => { const helper = spawn(process.execPath, ["-e", ${JSON.stringify(stubborn ? `process.on("${name}", () => {}); setInterval(() => {}, 1000)` : "setInterval(() => {}, 1000)")}], { stdio: "ignore" });
  writeFileSync(process.env.RUNNER_RECORD + ".part", JSON.stringify({ tmpdir: tmpdir(), pids: [process.pid, helper.pid] })); renameSync(process.env.RUNNER_RECORD + ".part", process.env.RUNNER_RECORD); return new Promise(() => {}); });`);
        child = spawn(process.execPath, [runner, file], { env: { ...w.environment, GATEWAY_TEST_KILL_GRACE_MS: "1500" }, stdio: "ignore" });
        const exited = once(child, "exit") as Promise<[number | null, string | null]>;
        assert.ok(await wait(() => exists(join(w.work, "record.json")), 20000), `${name}: the test started`);
        started = await w.record(); const { tmpdir: folder, pids } = started;
        child.kill(name as NodeJS.Signals);
        const [code] = await exited;
        assert.equal(code, 128 + number, `${name}${stubborn ? " (ignored by the test)" : ""}: the runner's exit code`);
        for (const pid of pids) assert.ok(await wait(() => !alive(pid), 3000), `${name}${stubborn ? " (ignored)" : ""}: process ${pid} of the run is gone`);
        assert.equal(await exists(folder), false, `${name}: the temp folder is removed`);
        passed = true;
      } finally {
        // A failed assertion above must not leave the run it started: stop it, whatever it was doing, and its folder.
        if (!passed) {
          if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
          for (const pid of started?.pids ?? []) { try { process.kill(pid, "SIGKILL"); } catch { /* Gone already. */ } }
          if (started) await rm(started.tmpdir, { recursive: true, force: true });
        }
        await rm(w.work, { recursive: true, force: true });
      }
    }
  }
});

test("a runner with nothing compiled says to build first instead of printing a stack", { timeout: 20000 }, async () => {
  const w = await workspace();
  try {
    // The runner finds the compiled tests next to itself: a copy in a folder with no dist has none.
    await mkdir(join(w.work, "scripts")); await copyFile(runner, join(w.work, "scripts", "run-tests.mjs"));
    const child = spawn(process.execPath, [join(w.work, "scripts", "run-tests.mjs")], { env: w.environment, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += String(chunk); });
    const [code] = await once(child, "exit");
    assert.equal(code, 2); assert.match(stderr, /run npm run build first/); assert.doesNotMatch(stderr, /ENOENT|at /);
  } finally { await rm(w.work, { recursive: true, force: true }); }
});
