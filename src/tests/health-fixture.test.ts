import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shortFolder } from "./short-folder.js";

/**
 * The packaged check itself, run against a fake gateway so that no inference, network or engine session is involved. The only
 * real part is the app's signed engine, which the check verifies and asks for its version before it starts anything; without
 * the app the check cannot start at all, so there is nothing to stop and the test is skipped.
 */
const engine = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const script = join(packageRoot, "scripts", "e2e-fast-mode.mjs");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => Promise<boolean> | boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await new Promise(resolve => setTimeout(resolve, 25)); }
  return false;
}

for (const mode of ["ignores", "exits"]) test(`a stopped check takes down everything it started, with a gateway that ${mode === "exits" ? "exits on" : "ignores"} SIGTERM`,
  { skip: process.platform !== "darwin" || !existsSync(engine) || !existsSync(script) }, async () => {
    const folder = await shortFolder("gw-fix-");
    const pidFile = join(folder.directory, "pids");
    const before = new Set((await readdir("/tmp")).filter(name => name.startsWith("gw-fast-")));
    // The fake gateway is what the check spawns for `serve`. The child in its group (the engine's git, in the real check) ignores
    // SIGTERM, so only a SIGKILL of the whole group removes it; when the gateway exits on SIGTERM that sweep happens after it is
    // gone, and when it ignores SIGTERM too the sweep follows the grace.
    await writeFile(join(folder.directory, "gateway.js"), [
      "const { spawn } = require(\"node:child_process\");",
      "const { writeFileSync } = require(\"node:fs\");",
      "process.on(\"SIGTERM\", () => { if (process.env.FAKE_MODE === \"exits\") process.exit(0); });",
      "const child = spawn(\"/bin/sh\", [\"-c\", \"trap '' TERM; exec sleep 60\"], { stdio: \"ignore\" });",
      "writeFileSync(process.env.FAKE_PID_FILE + \".home\", process.env.HOME);",
      "writeFileSync(process.env.FAKE_PID_FILE, process.pid + \" \" + child.pid);",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const check = spawn(process.execPath, [script, "--gateway", join(folder.directory, "gateway.js"), "--package", packageRoot,
      "--codex", engine, "--transports", "stdio", "--root", join(folder.directory, "root")],
    { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FAKE_PID_FILE: pidFile, FAKE_MODE: mode }, stdio: "ignore" });
    let pids: number[] = [];
    try {
      assert.ok(await until(async () => (await readFile(pidFile, "utf8").catch(() => "")).includes(" "), 10_000), "the check never started its gateway");
      pids = (await readFile(pidFile, "utf8")).split(" ").map(Number);
      assert.ok(pids.every(pid => pid > 0 && alive(pid)));
      // Every child runs under a private HOME inside the run folder, so the homes it derives from HOME (gw-exec, gw-native, gw-ssh, .codex)
      // never land in the real one.
      const home = await readFile(pidFile + ".home", "utf8");
      assert.notEqual(home, process.env.HOME);
      assert.match(home, /^\/tmp\/gw-fast-[^/]+\/home$/);
      assert.equal((await stat(home)).mode & 0o777, 0o700);
      const closed = new Promise<number | null>(resolve => check.once("close", code => resolve(code)));
      check.kill("SIGTERM");
      assert.equal(await closed, 1, "the check ends with a failure, not a crash");
      assert.ok(await until(() => pids.every(pid => !alive(pid)), 5_000), "the stopped check left a process running");
      const left = (await readdir("/tmp")).filter(name => name.startsWith("gw-fast-") && !before.has(name));
      assert.deepEqual(left, [], "the check's run folder outlived it");
    } finally {
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      if (check.exitCode === null && check.signalCode === null) check.kill("SIGKILL");
      await folder.remove();
    }
  });
