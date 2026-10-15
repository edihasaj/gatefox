import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { copyFile, chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, connect, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shortFolder } from "./short-folder.js";

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
    await mkdir(join(w.work, "scripts")); for (const name of ["run-tests.mjs", "stale-sockets.mjs", "group-gone.mjs"]) await copyFile(join(dirname(runner), name), join(w.work, "scripts", name));
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

for (const [name, number] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]] as const) test(`${name} also stops the Copilot CLI a test started, though it runs in a process group of its own and ignores the signal and the end of its input`, { skip: process.platform === "win32", timeout: 90000 }, async () => {
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
    child.kill(name);
    const [code] = await run.exited; assert.equal(code, 128 + number, "the runner's exit code");
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
  // A stale socket whose name is not a 64-character hash, a plain file whose name is one, and a symbolic link whose name is one, to a
  // socket nobody listens on: none of them is the SDK's socket. (Where a connection to a plain file is refused, as it is on Linux,
  // only the check of the file's type keeps it; on macOS only the symbolic link shows that check.)
  const oddName = join(rendezvous, `not-a-hash-${randomUUID()}`); const plain = join(rendezvous, name()); const linked = join(rendezvous, name());
  // A stale socket with a hash for a name, but not in the SDK's folder.
  const outside = join(w.work, name());
  let server: Server | undefined;
  try {
    // The folder the SDK uses is made by it, private; it exists on a machine that ran any execution-host test.
    await mkdir(rendezvous, { recursive: true, mode: 0o700 });
    server = createServer(socket => socket.end()); await new Promise<void>(resolve => server!.listen(live, resolve));
    // A socket nobody listens on any more: the process that made it is killed.
    await writeFile(plain, "not a socket");
    for (const path of [stale, unlinked, elsewhere, oddName, outside]) {
      const maker = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"))`], { stdio: "ignore" });
      await once(maker, "exit");
    }
    assert.ok(await exists(stale) && await exists(unlinked) && await exists(elsewhere) && await exists(oddName), "the stale sockets exist");
    await symlink(elsewhere, linked);
    // The suite links to the stale one, the live one, and a socket elsewhere, and waits for ever.
    const file = await w.suite("links", `import { renameSync, symlinkSync, writeFileSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
test("links", () => { for (const [index, target] of JSON.parse(process.env.RUNNER_LINKS).entries()) symlinkSync(target, join(tmpdir(), "link-" + index));
  writeFileSync(process.env.RUNNER_RECORD + ".part", JSON.stringify({ tmpdir: tmpdir(), pids: [process.pid] })); renameSync(process.env.RUNNER_RECORD + ".part", process.env.RUNNER_RECORD); return new Promise(() => {}); });`);
    const run = await startedRun(w, file, { RUNNER_LINKS: JSON.stringify([stale, live, elsewhere, oddName, plain, linked, outside]) }); child = run.child; started = run.started;
    child.kill("SIGTERM"); const [code] = await run.exited; assert.equal(code, 128 + 15);
    assert.equal(await exists(stale), false, "the stale socket the run linked to is removed");
    assert.equal(await exists(live), true, "a socket that is listening is kept");
    assert.equal(await exists(unlinked), true, "a stale socket the run did not link to is kept");
    assert.equal(await exists(elsewhere), true, "so is a stale one outside the folder the SDK uses, though the run linked to it");
    assert.equal(await exists(outside), true, "and a stale one with a hash for a name outside the folder");
    assert.equal(await exists(oddName), true, "a stale socket in that folder whose name is not a hash is kept");
    assert.equal(await exists(plain), true, "and so is a file with a hash for a name that is not a socket");
    assert.equal(await lstat(linked).then(() => true, () => false), true, "and a link with a hash for a name, though what it points to is a stale socket");
    assert.equal(await new Promise(resolve => connect(live).once("connect", () => resolve(true)).once("error", () => resolve(false))), true, "and it still accepts connections");
    assert.equal(await exists(started.tmpdir), false, "the temp folder is removed");
    passed = true;
  } finally {
    if (!passed) await cleanUp(child, started);
    server?.close();
    for (const path of [stale, live, unlinked, oddName, plain, linked]) await rm(path, { force: true });
    await rm(w.work, { recursive: true, force: true });
  }
});

test("a stopped run with a real execution host leaves no socket or folder behind, and nothing of it reaches the real home folder", { skip: process.platform === "win32", timeout: 90000 }, async () => {
  const w = await workspace(); let child: ChildProcess | undefined; let started: { tmpdir: string; pids: number[] } | undefined; let passed = false; let physical: string | undefined;
  try {
    // The suite starts an execution host the way the gateway does (the pinned SDK's version check is answered by a stand-in), which makes
    // its folder under the home folder, a control socket in the SDK's fixed folder, and a link to it, and then waits for ever.
    const host = JSON.stringify(new URL("../execution-host.js", import.meta.url).href);
    const file = await w.suite("host", `import { mkdirSync, readlinkSync, renameSync, writeFileSync } from "node:fs"; import { homedir, tmpdir } from "node:os"; import { join } from "node:path";
import { executionHostHome, startExecutionHost } from ${host};
test("holds a host", async () => {
  const directory = join(tmpdir(), "host"); mkdirSync(directory, { mode: 0o700 }); const codex = join(directory, "codex"); const nativeHome = join(directory, "native"); mkdirSync(nativeHome, { mode: 0o700 });
  writeFileSync(codex, "#!/bin/sh\\necho codex-cli 0.162.0-alpha.17.2\\n", { mode: 0o700 }); const configPath = join(directory, "gateway.json");
  await startExecutionHost({ config: { version: 1, port: 3457, stateDirectory: join(directory, "state"), providers: [], clientOnly: true }, configPath, nativeHome, codex });
  const hostHome = executionHostHome(configPath, nativeHome); const link = join(hostHome, "host.sock");
  writeFileSync(process.env.RUNNER_RECORD + ".part", JSON.stringify({ tmpdir: tmpdir(), pids: [process.pid], home: homedir(), hostHome, link, target: readlinkSync(link) })); renameSync(process.env.RUNNER_RECORD + ".part", process.env.RUNNER_RECORD);
  return new Promise(() => {});
});`);
    const run = await startedRun(w, file); child = run.child; started = run.started;
    const seen = await w.record() as unknown as { tmpdir: string; home: string; hostHome: string; link: string; target: string };
    physical = seen.target;
    assert.equal(seen.home, join(seen.tmpdir, "home"), "the suite's home folder is inside the run's folder");
    assert.ok(seen.hostHome.startsWith(seen.home + "/"), "so the host's folder is inside it");
    assert.ok(await exists(seen.link) && await exists(seen.target), "the host's control socket exists while the run is going");
    child.kill("SIGTERM"); const [code] = await run.exited; assert.equal(code, 128 + 15, "the runner's exit code");
    assert.equal(await exists(seen.target), false, "the control socket in the SDK's folder is gone");
    assert.equal(await exists(seen.tmpdir), false, "and the run's folder, with the host's folder and its link");
    const real = join(homedir(), ".local", "state", "gw-exec", basename(seen.hostHome));
    assert.equal(await exists(real), false, "and nothing of the host was made in this process's home folder");
    passed = true;
  } finally {
    if (!passed) await cleanUp(child, started);
    // What this test's own host made, if the runner did not remove it: only the socket the test itself recorded.
    if (physical) await rm(physical, { force: true });
    await rm(w.work, { recursive: true, force: true });
  }
});

test("the runner removes only a socket this user made, and only under a name the SDK gives its sockets", async () => {
  const { ownSocket, sdkSocketName } = await import(new URL("../../scripts/stale-sockets.mjs", import.meta.url).href) as { ownSocket(info: unknown, uid: number): boolean; sdkSocketName(name: string): boolean };
  const status = (kind: "socket" | "file", uid: number) => ({ isSocket: () => kind === "socket", uid });
  assert.equal(ownSocket(status("socket", 501), 501), true);
  assert.equal(ownSocket(status("socket", 0), 501), false, "a socket of another user is kept");
  assert.equal(ownSocket(status("file", 501), 501), false, "so is a file that is not a socket");
  assert.equal(sdkSocketName("a".repeat(64)), true); assert.equal(sdkSocketName(createHash("sha256").update("x").digest("hex")), true);
  for (const name of ["a".repeat(63), "a".repeat(65), "A".repeat(64), `${"a".repeat(63)}g`, `${"a".repeat(64)}.lock`, `x${"a".repeat(64)}`, "", `${"a".repeat(64)}\n`]) assert.equal(sdkSocketName(name), false, JSON.stringify(name));
});

test("the runner waits for a killed process group to be gone before it looks at the sockets of the run", { skip: process.platform === "win32", timeout: 60000 }, async () => {
  const { groupGone } = await import(new URL("../../scripts/group-gone.mjs", import.meta.url).href) as { groupGone(leader: number, ms: number): Promise<boolean> };
  const leader = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); const pid = leader.pid!;
  try {
    assert.equal(await groupGone(pid, 200), false, "a group that is running is not gone, and the wait ends at its limit");
    let killed = false; const waiting = groupGone(pid, 30000).then(gone => ({ gone, afterKill: killed }));
    await new Promise(resolve => setTimeout(resolve, 100)); killed = true; process.kill(-pid, "SIGKILL");
    assert.deepEqual(await waiting, { gone: true, afterKill: true }, "it settles once the group is gone, not before");
    assert.equal(await groupGone(pid, 200), true, "and a group that is gone is gone at once");
  } finally { try { process.kill(-pid, "SIGKILL"); } catch { /* Gone already. */ } }
});

test("a socket is stale when nothing listens on it, also when its owner was killed just after answering, and never while something listens", { skip: process.platform === "win32", timeout: 60000 }, async () => {
  const { isStale } = await import(new URL("../../scripts/stale-sockets.mjs", import.meta.url).href) as { isStale(path: string, ms?: number): Promise<boolean> };
  const folder = await shortFolder("gw-stale-");
  try {
    const maker = (path: string, body: string) => spawn(process.execPath, ["-e", `const server = require("node:net").createServer(${body}); server.listen(${JSON.stringify(path)}, () => process.stdout.write("up"));`], { stdio: ["ignore", "pipe", "ignore"] });
    const ready = async (child: ChildProcess) => { await once(child.stdout!, "data"); };
    // Nothing listens: the maker was killed as soon as it listened.
    const dead = join(folder.directory, "dead.sock"); const killed = maker(dead, "() => {}"); await ready(killed); killed.kill("SIGKILL"); await once(killed, "exit");
    assert.equal(await isStale(dead, 3000), true, "a socket nobody listens on is stale");
    // The owner is killed by its first connection, which is answered: the first question finds a listener, the next one a stale socket.
    const dying = join(folder.directory, "dying.sock"); const second = maker(dying, `() => process.kill(process.pid, "SIGKILL")`); await ready(second); const gone = once(second, "exit");
    assert.equal(await isStale(dying, 30000), true, "a listener that is gone a moment later is asked again, and found stale");
    await gone;
    // Something that keeps listening is never stale, and the question ends at its limit.
    const serving = join(folder.directory, "serving.sock"); const server = createServer(socket => socket.end()); await new Promise<void>(resolve => server.listen(serving, resolve));
    try { assert.equal(await isStale(serving, 300), false, "a socket that is served is not stale"); } finally { server.close(); }
    // A path that is no socket cannot be asked: it is kept.
    const plain = join(folder.directory, "plain"); await writeFile(plain, "x");
    assert.equal(await isStale(plain, 300), false, "a file that is no socket is not stale");
  } finally { await folder.remove(); }
});

test("a stopped run waits for a test process to finish its exit handlers, which stop what it started, instead of killing it when the leader has left", { skip: process.platform === "win32", timeout: 90000 }, async () => {
  const w = await workspace(); let child: ChildProcess | undefined; let started: { tmpdir: string; pids: number[] } | undefined; let passed = false;
  try {
    // The leader leaves at once when it is signalled. The test process takes 2 s in an exit handler, and then records that it finished.
    const marker = join(w.work, "finished");
    const file = await w.suite("slow-exit", `import { renameSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os";
process.on("exit", () => { const end = Date.now() + 2000; while (Date.now() < end) { /* Busy. */ } writeFileSync(${JSON.stringify(marker)}, "x"); });
test("waits", () => { writeFileSync(process.env.RUNNER_RECORD + ".part", JSON.stringify({ tmpdir: tmpdir(), pids: [process.pid] })); renameSync(process.env.RUNNER_RECORD + ".part", process.env.RUNNER_RECORD); return new Promise(() => {}); });`);
    const run = await startedRun(w, file, { GATEWAY_TEST_KILL_GRACE_MS: "60000" }); child = run.child; started = run.started;
    child.kill("SIGTERM"); const [code] = await run.exited; assert.equal(code, 128 + 15, "the runner's exit code");
    assert.equal(await exists(marker), true, "the test process finished its exit handler before the runner ended the run");
    assert.equal(alive(started.pids[0]), false, "and it is gone");
    passed = true;
  } finally { if (!passed) await cleanUp(child, started); await rm(w.work, { recursive: true, force: true }); }
});
