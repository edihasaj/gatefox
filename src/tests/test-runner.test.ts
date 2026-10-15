import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

/** Starts the runner on one suite, waits until the suite has written its record, and returns what it needs to stop the run and check it. */
async function startedRun(w: Awaited<ReturnType<typeof workspace>>, file: string, extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [runner, file], { env: { ...w.environment, GATEWAY_TEST_KILL_GRACE_MS: "1500", ...extra }, stdio: "ignore" });
  const exited = once(child, "exit") as Promise<[number | null, string | null]>;
  assert.ok(await wait(() => exists(join(w.work, "record.json")), 60000), "the suite started");
  return { child, exited, started: await w.record() };
}
/** Stops what a failed assertion left behind: the run, the processes it started and its folder. */
async function cleanUp(child: ChildProcess | undefined, started: { tmpdir: string; pids: number[] } | undefined) {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
  for (const pid of started?.pids ?? []) { try { process.kill(pid, "SIGKILL"); } catch { /* Gone already. */ } }
  if (started) await rm(started.tmpdir, { recursive: true, force: true });
}

test("a signal also stops the Copilot CLI a test started, though it runs in a process group of its own and ignores the signal and the end of its input", { skip: process.platform === "win32", timeout: 90000 }, async () => {
  const w = await workspace(); let child: ChildProcess | undefined; let started: { tmpdir: string; pids: number[] } | undefined; let passed = false;
  try {
    // A `copilot` that answers the handshake like the real one, ignores SIGTERM, and outlives its input: only a SIGKILL ends it.
    const dist = (name: string) => JSON.stringify(new URL(`../providers/${name}.js`, import.meta.url).href);
    const bin = join(w.work, "bin"); await mkdir(bin);
    await writeFile(join(bin, "cli.mjs"), `import { copilotFrames } from ${dist("copilot-rpc")}; process.on("SIGTERM", () => {});
const send = value => { const body = JSON.stringify(value); process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body); };
for await (const message of copilotFrames(process.stdin)) {
  if (message.method === "connect") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 3 } });
  else if (message.method === "auth.getStatus") send({ jsonrpc: "2.0", id: message.id, result: { isAuthenticated: true } });
}
setInterval(() => {}, 1000);\n`);
    await writeFile(join(bin, "copilot"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(bin, "cli.mjs"))}\n`); await chmod(join(bin, "copilot"), 0o700);
    const file = await (async () => { const target = join(w.work, "holds.test.mjs");
      await writeFile(target, `import test from "node:test"; import { renameSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os";
import { openCopilot } from ${dist("copilot-client")};
test("holds a CLI", async () => { const client = await openCopilot({ id: "held", type: "copilot-subscription", models: {} });
  writeFileSync(process.env.RUNNER_RECORD + ".part", JSON.stringify({ tmpdir: tmpdir(), pids: [process.pid, client.rpc.pid] })); renameSync(process.env.RUNNER_RECORD + ".part", process.env.RUNNER_RECORD); return new Promise(() => {}); });\n`);
      return target; })();
    const run = await startedRun(w, file, { PATH: bin + delimiter + process.env.PATH }); child = run.child; started = run.started;
    const [leader, cli] = started.pids; assert.ok(alive(cli), "the CLI is running in its own group");
    child.kill("SIGTERM");
    const [code] = await run.exited; assert.equal(code, 128 + 15, "the runner's exit code");
    assert.ok(await wait(() => !alive(leader), 60000), "the test process is gone");
    assert.ok(await wait(() => !alive(cli), 60000), "and so is the CLI it started");
    assert.equal(await exists(started.tmpdir), false, "and the temp folder");
    passed = true;
  } finally { if (!passed) await cleanUp(child, started); await rm(w.work, { recursive: true, force: true }); }
});

test("a leader that cannot be stopped is killed after the grace, and the runner still exits with 128 plus the signal", { skip: process.platform === "win32", timeout: 90000 }, async () => {
  const w = await workspace(); let child: ChildProcess | undefined; let started: { tmpdir: string; pids: number[] } | undefined; let passed = false;
  try {
    // The test process stops its own leader (the `node --test` process it belongs to): a stopped process takes no signal but SIGKILL.
    const file = await w.suite("stops-its-leader", `import { renameSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os";
test("stops its leader", () => { writeFileSync(process.env.RUNNER_RECORD + ".part", JSON.stringify({ tmpdir: tmpdir(), pids: [process.pid, process.ppid] })); renameSync(process.env.RUNNER_RECORD + ".part", process.env.RUNNER_RECORD);
  process.kill(process.ppid, "SIGSTOP"); return new Promise(() => {}); });`);
    const run = await startedRun(w, file); child = run.child; started = run.started;
    child.kill("SIGINT");
    // Without the escalation the runner waits for ever for the stopped leader: this test then ends by its timeout.
    const [code] = await run.exited; assert.equal(code, 128 + 2, "the runner's exit code");
    for (const pid of started.pids) assert.ok(await wait(() => !alive(pid), 60000), `process ${pid} of the run is gone`);
    assert.equal(await exists(started.tmpdir), false, "the temp folder is removed");
    passed = true;
  } finally { if (!passed) await cleanUp(child, started); await rm(w.work, { recursive: true, force: true }); }
});

test("a stopped run removes the stale execution sockets its folder links to, and leaves live ones and everything else alone", { skip: process.platform === "win32", timeout: 90000 }, async () => {
  const w = await workspace(); let child: ChildProcess | undefined; let started: { tmpdir: string; pids: number[] } | undefined; let passed = false;
  const rendezvous = join(realpathSync("/tmp"), `codex-daemon-${process.getuid!()}`);
  const name = () => createHash("sha256").update(randomUUID()).digest("hex");
  const stale = join(rendezvous, name()); const live = join(rendezvous, name()); const unlinked = join(rendezvous, name()); const elsewhere = join(w.work, "elsewhere.sock");
  let server: Server | undefined; let other: Server | undefined;
  try {
    // The folder the SDK uses is made by it, private; it exists on a machine that ran any execution-host test.
    await mkdir(rendezvous, { recursive: true, mode: 0o700 });
    server = createServer(socket => socket.end()); await new Promise<void>(resolve => server!.listen(live, resolve));
    other = createServer(); await new Promise<void>(resolve => other!.listen(elsewhere, resolve));
    // A socket nobody listens on any more: the process that made it is killed.
    for (const path of [stale, unlinked]) {
      const maker = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"))`], { stdio: "ignore" });
      await once(maker, "exit");
    }
    assert.ok(await exists(stale) && await exists(unlinked), "the stale sockets exist");
    // The suite links to the stale one, the live one, and a socket elsewhere, and waits for ever.
    const file = await w.suite("links", `import { renameSync, symlinkSync, writeFileSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
test("links", () => { for (const [index, target] of JSON.parse(process.env.RUNNER_LINKS).entries()) symlinkSync(target, join(tmpdir(), "link-" + index));
  writeFileSync(process.env.RUNNER_RECORD + ".part", JSON.stringify({ tmpdir: tmpdir(), pids: [process.pid] })); renameSync(process.env.RUNNER_RECORD + ".part", process.env.RUNNER_RECORD); return new Promise(() => {}); });`);
    const run = await startedRun(w, file, { RUNNER_LINKS: JSON.stringify([stale, live, elsewhere]) }); child = run.child; started = run.started;
    child.kill("SIGTERM"); const [code] = await run.exited; assert.equal(code, 128 + 15);
    assert.equal(await exists(stale), false, "the stale socket the run linked to is removed");
    assert.equal(await exists(live), true, "a socket that is listening is kept");
    assert.equal(await exists(unlinked), true, "a stale socket the run did not link to is kept");
    assert.equal(await exists(elsewhere), true, "so is one outside the folder the SDK uses");
    assert.equal(await new Promise(resolve => connect(live).once("connect", () => resolve(true)).once("error", () => resolve(false))), true, "and it still accepts connections");
    assert.equal(await exists(started.tmpdir), false, "the temp folder is removed");
    passed = true;
  } finally {
    if (!passed) await cleanUp(child, started);
    server?.close(); other?.close();
    for (const path of [stale, live, unlinked]) await rm(path, { force: true });
    await rm(w.work, { recursive: true, force: true });
  }
});
