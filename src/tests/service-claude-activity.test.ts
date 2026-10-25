import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { once } from "node:events";
import { claudeIdleChecker, establishedTcpClaudeIdle, isClaudeComponent, type LsofRun } from "../service-claude-activity.js";

const ran = (overrides: Partial<LsofRun> = {}): LsofRun => ({ stdout: "", stderr: "", code: 0, killed: false, ...overrides });
const errno = (code: string) => Object.assign(new Error(code), { code });
/** The exact three lines Apple's lsof writes for a mounted file system it cannot stat(); the runner account's mount is the reference case. */
const coreDeviceBlock = (user = "ghrunner", dev = "30000005") =>
  `lsof: WARNING: can't stat() devicefs file system /Users/${user}/Library/Developer/CoreDevice/DeviceFS\n` +
  `      Output information may be incomplete.\n` +
  `      assuming "dev=${dev}" from mount table\n`;
/** A kernel-socket read error lsof can also write: always a question, never noise to look past. */
const socketError = "lsof: PID 77, FD 5: proc_pidfdinfo(PROC_PIDFDSOCKETINFO);\n      too few bytes; expected 256, got 1\n";
const established = "COMMAND PID\nnode 77 edi 20u IPv4 TCP 127.0.0.1:1->127.0.0.1:2 (ESTABLISHED)\n";
/** A checker with every dependency answered by the test; `calls` records each lsof invocation. */
function checker(options: { run?: () => Promise<LsofRun> | LsofRun; signal?: (pid: number) => void; starts?: Array<number | undefined> } = {}) {
  const calls: Array<{ file: string; args: string[] }> = []; const starts = [...(options.starts ?? [])]; let last: number | undefined = 1000;
  return {
    calls,
    idle: claudeIdleChecker({
      run: async (file, args) => { calls.push({ file, args }); return await (options.run ?? (() => ran()))(); },
      signal: options.signal ?? (() => undefined),
      start: async () => { if (starts.length) last = starts.shift(); return last; },
    }),
  };
}

test("Claude components are the adapter and its private inference only", () => {
  const base = { id: "x", command: "/bin/x", args: [], log: "/tmp/x.log" };
  assert.deepEqual((["claude-adapter", "claude-inference", "inference", "desktop", "native", "tunnel"] as const).map(kind => isClaudeComponent({ ...base, kind })), [true, true, false, false, false, false]);
});

test("the lsof probe ANDs its selections: -a joins the pid and the established TCP filter", async () => {
  const { idle, calls } = checker();
  assert.equal(await idle([4242]), true);
  assert.deepEqual(calls, [{ file: "/usr/sbin/lsof", args: ["-nP", "-a", "-p", "4242", "-iTCP", "-sTCP:ESTABLISHED"] }]);
});

test("exit 0 with no output, and lsof's no-match exit 1 with no output at all, are idle", async () => {
  assert.equal(await checker({ run: () => ran({ code: 0 }) }).idle([77]), true);
  assert.equal(await checker({ run: () => ran({ code: 1 }) }).idle([77]), true);
  assert.equal(await checker({}).idle([]), true, "no Claude child, nothing to ask");
});

test("an established connection, or any output at all, keeps the restart away", async () => {
  assert.equal(await checker({ run: () => ran({ stdout: established }) }).idle([77]), false);
  assert.equal(await checker({ run: () => ran({ code: 1, stdout: "node 77\n" }) }).idle([77]), false);
  assert.equal(await checker({ run: () => ran({ stderr: "lsof: WARNING: something\n" }) }).idle([77]), false, "an unrecognised warning is not an answer");
  assert.equal(await checker({ run: () => ran({ code: 1, stderr: "lsof: WARNING: can't stat\n" }) }).idle([77]), false);
});

test("the CoreDevice mount-stat block alone is looked past: lsof still answered the TCP question", async () => {
  const warning = coreDeviceBlock();
  assert.equal(await checker({ run: () => ran({ code: 1, stderr: warning }) }).idle([77]), true, "no match, exit 1, only the mount diagnostic");
  assert.equal(await checker({ run: () => ran({ code: 0, stderr: warning }) }).idle([77]), true, "empty stdout with exit 0 is the same answer");
  assert.equal(await checker({ run: () => ran({ code: 1, stderr: warning + warning }) }).idle([77]), true, "one block per un-statable mount");
  assert.equal(await checker({ run: () => ran({ code: 1, stderr: coreDeviceBlock("edi") + coreDeviceBlock("ghrunner", "DEADBEEF") }) }).idle([77]), true, "different mounts and a hex device");
  assert.equal(await checker({ run: () => ran({ code: 1, stderr: "  \n" }) }).idle([77]), true, "blank stderr stays as blank as it always was");
});

test("the same block beside a real connection is still refused: stdout decides busy", async () => {
  assert.equal(await checker({ run: () => ran({ code: 0, stdout: established, stderr: coreDeviceBlock() }) }).idle([77]), false, "busy on a machine that prints the mount warning");
  assert.equal(await checker({ run: () => ran({ code: 0, stdout: "node 77\n", stderr: coreDeviceBlock() }) }).idle([77]), false);
});

test("anything around the block is a question: altered, shortened, mixed or extra stderr fails closed", async () => {
  const warning = coreDeviceBlock();
  const lines = warning.split("\n");
  for (const [label, stderr] of [
    ["a socket read error on its own", socketError],
    ["the block then a socket read error", warning + socketError],
    ["a socket read error then the block", socketError + warning],
    ["the block with no final newline", warning.slice(0, -1)],
    ["only the first two lines", `${lines[0]}\n${lines[1]}\n`],
    ["only the last two lines", `${lines[1]}\n${lines[2]}\n`],
    ["lines 1 and 3", `${lines[0]}\n${lines[2]}\n`],
    ["the lines reordered", `${lines[1]}\n${lines[0]}\n${lines[2]}\n`],
    ["another file system type", warning.replace("devicefs", "smbfs")],
    ["no /Users mount point", warning.replace("/Users/ghrunner/Library", "/Library")],
    ["two path components", warning.replace("/Users/ghrunner/", "/Users/gh/sub/")],
    ["a longer mount point", warning.replace("DeviceFS\n", "DeviceFSExtra\n")],
    ["a carriage return in the account", coreDeviceBlock("gh\rrunner")],
    ["a non-hex device", coreDeviceBlock("ghrunner", "3000000g")],
    ["an empty device", coreDeviceBlock("ghrunner", "")],
    ["a different continuation indent", warning.replace("      Output", "     Output")],
    ["an altered word", warning.replace("may be incomplete", "may be complete")],
    ["a capitalised prefix", warning.replace("lsof: WARNING", "lsof: warning")],
    ["an indented first line", ` ${warning}`],
    ["the block then a blank line", `${warning}\n`],
    ["two blocks split by a blank line", `${lines[0]}\n${lines[1]}\n\n${lines[2]}\n`],
    ["a tail of another warning", `${warning}lsof: no process with id 77 exists\n`],
  ] as Array<[string, string]>) {
    assert.equal(await checker({ run: () => ran({ code: 1, stderr }) }).idle([77]), false, label);
    assert.equal(await checker({ run: () => ran({ code: 0, stderr }) }).idle([77]), false, `${label} (exit 0)`);
  }
});

test("the mount diagnostic never excuses an end that is not an answer", async () => {
  const warning = coreDeviceBlock();
  for (const code of [2, 3, 127, 255, null, "ENOENT", "EACCES", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
    assert.equal(await checker({ run: () => ran({ code, stderr: warning }) }).idle([77]), false, `empty output with code ${String(code)}`);
  }
  assert.equal(await checker({ run: () => ran({ code: 1, stderr: warning, killed: true }) }).idle([77]), false, "a timed-out run is unanswered whatever its stderr");
  assert.equal(await checker({ run: () => ran({ code: null, stderr: warning, killed: true }) }).idle([77]), false);
});

test("an exit that is not a clean answer is never idle: other codes, timeouts, a missing binary, a throwing run", async () => {
  for (const code of [2, 3, 127, 255, null, "ENOENT", "EACCES", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
    assert.equal(await checker({ run: () => ran({ code }) }).idle([77]), false, `empty output with code ${String(code)}`);
  }
  assert.equal(await checker({ run: () => ran({ code: 1, killed: true }) }).idle([77]), false, "a killed (timed out) run");
  assert.equal(await checker({ run: () => ran({ code: null, killed: true }) }).idle([77]), false);
  assert.equal(await checker({ run: () => { throw errno("ENOENT"); } }).idle([77]), false);
  assert.equal(await checker({ run: () => Promise.reject(new Error("boom")) }).idle([77]), false);
});

test("a pid that is gone is skipped; one that cannot be signalled or identified fails closed", async () => {
  const { idle, calls } = checker({ signal: pid => { if (pid === 5) throw errno("ESRCH"); } });
  assert.equal(await idle([5]), true, "ESRCH: gone, owns no connection");
  assert.deepEqual(calls, [], "a gone pid is never probed");
  assert.equal(await checker({ signal: () => { throw errno("EPERM"); } }).idle([5]), false);
  assert.equal(await checker({ signal: () => { throw new Error("odd"); } }).idle([5]), false);
  assert.equal(await checker({ starts: [undefined] }).idle([5]), false, "unknown identity");
  for (const bad of [0, 1, -3, 1.5, Number.NaN]) assert.equal(await checker().idle([bad]), false, `pid ${bad}`);
});

test("a pid whose start changes during the probe was reused and is refused; one that exited meanwhile is skipped", async () => {
  assert.equal(await checker({ starts: [1000, 2000] }).idle([9]), false, "reused pid");
  assert.equal(await checker({ starts: [1000, undefined] }).idle([9]), false, "unknown identity afterwards while still signalable");
  let probes = 0;
  const exited = checker({ starts: [1000, undefined], signal: () => { if (++probes > 1) throw errno("ESRCH"); } });
  assert.equal(await exited.idle([9]), true, "exited during the probe");
});

test("the first busy child decides: later pids are not probed", async () => {
  const { idle, calls } = checker({ run: () => ran({ stdout: "node 1 ESTABLISHED\n" }) });
  assert.equal(await idle([11, 12]), false);
  assert.equal(calls.length, 1);
});

// Real lsof, real sockets: the default dependencies on a Mac, where /usr/sbin/lsof and ps exist.
test("real lsof: an idle child is idle, a child holding an established connection is not, and an unrelated one does not leak in", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
  const server: Server = createServer(socket => { socket.on("error", () => undefined); socket.resume(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const idleChild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const busyChild = spawn(process.execPath, ["-e", `const s=require('node:net').connect(${port},'127.0.0.1');s.on('error',()=>process.exit(1));s.on('connect',()=>console.log('UP'));setInterval(()=>{},1000)`], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await once(busyChild.stdout!, "data");
    // The test process itself holds the server side of an established connection, which must not make the idle child busy.
    assert.equal(await establishedTcpClaudeIdle([idleChild.pid!]), true, "an idle child, while others hold connections");
    assert.equal(await establishedTcpClaudeIdle([busyChild.pid!]), false, "an established loopback connection");
    assert.equal(await establishedTcpClaudeIdle([idleChild.pid!, busyChild.pid!]), false);
    idleChild.kill("SIGKILL"); await once(idleChild, "close");
    assert.equal(await establishedTcpClaudeIdle([idleChild.pid!]), true, "a pid that exited is skipped");
  } finally { idleChild.kill("SIGKILL"); busyChild.kill("SIGKILL"); await new Promise<void>(done => server.close(() => done())); }
});
