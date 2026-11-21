import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resetGeminiScratchSweepForTests, sweepGeminiScratch } from "../providers/gemini-scratch-sweep.js";
import { adapter, alive, harness, turn, until, user, type Harness } from "./gemini-live-harness.js";

const child = fileURLToPath(new URL("./gemini-exit-child.js", import.meta.url));
const exists = (path: string) => readdir(path).then(() => true, () => false);

/** Runs the exit child to its `process.exit(17)` and resolves with the exit code; the fake CLI it started is what is left to look for. */
function exitMidway(mode: "login" | "start", home: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [child, mode, home], { stdio: "ignore", env: process.env });
    proc.once("error", reject); proc.once("exit", code => resolve(code));
  });
}
async function nothingLeft(h: Harness): Promise<void> {
  const pids = await h.pids();
  assert.equal(pids.length, 1, "the fake CLI was started");
  for (const pid of pids) assert.equal(alive(pid), false, "the CLI process group was killed by the exit hook, not left running");
  assert.deepEqual(await h.liveDirs(), [], "the scratch folder, with the copied credential in it, was removed");
}

test("a gateway that exits during a Gemini sign-in leaves no CLI and no scratch folder", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    process.env.GATEWAY_TEST_GEMINI_LOGIN = "norefresh"; // the sign-in never completes, so the CLI is still running at the exit
    assert.equal(await exitMidway("login", join(h.directory, "login-home")), 17);
    await nothingLeft(h);
  } finally { await h.restore(); }
});

test("a gateway that exits while a Gemini session is still starting leaves no CLI and no scratch folder", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    process.env.GATEWAY_TEST_GEMINI_HANG = "1"; // the CLI never answers `initialize`: the session is registered nowhere yet
    assert.equal(await exitMidway("start", h.home), 17);
    await nothingLeft(h);
  } finally { await h.restore(); }
});

/** A pid that has just ended, and a process that stays alive until the returned function is called. */
async function deadPid(): Promise<number> {
  const proc = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise(resolve => proc.once("exit", resolve));
  return proc.pid!;
}

test("a scratch root whose owner is gone is swept, and nothing else is", { timeout: 40000 }, async () => {
  const h = await harness();
  const waiting = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const root = await mkdtemp(join(h.directory, "sweep-"));
    const make = async (name: string, owner?: Record<string, unknown>) => {
      const path = join(root, name); await mkdir(join(path, "home/.gemini"), { recursive: true });
      await writeFile(join(path, "home/.gemini/oauth_creds.json"), "{}");
      if (owner) await writeFile(join(path, "owner.json"), JSON.stringify(owner));
      return path;
    };
    const gone = await deadPid();
    const stale = [await make("gateway-gemini-live-gone", { pid: gone }), await make("gateway-gemini-login-gone", { pid: gone }),
      // A live process that is not the one that wrote the record: the pid was reused.
      await make("gateway-gemini-live-reused", { pid: waiting.pid, startedAtMs: 1 })];
    const kept = [await make("gateway-gemini-live-noowner"), await make("gateway-gemini-live-mine", { pid: process.pid }),
      await make("gateway-gemini-live-other", { pid: waiting.pid }), await make("not-a-gateway-root", { pid: gone })];
    assert.equal(await sweepGeminiScratch(root), stale.length);
    for (const path of stale) assert.equal(await exists(path), false, `${path} was removed`);
    for (const path of kept) assert.equal(await exists(path), true, `${path} was kept`);
  } finally { waiting.kill("SIGKILL"); await h.restore(); }
});

test("the next session start sweeps what a killed gateway left, and its own folder records its owner", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const stale = join(h.scratch, "gateway-gemini-live-killed"); await mkdir(join(stale, "home/.gemini"), { recursive: true });
    await writeFile(join(stale, "home/.gemini/oauth_creds.json"), "{}"); await writeFile(join(stale, "owner.json"), JSON.stringify({ pid: await deadPid() }));
    resetGeminiScratchSweepForTests();
    await turn(adapter(), [user("start [plain]")]);
    assert.ok(await until(async () => !await exists(stale)), "the dead owner's folder was removed");
    const [live] = await h.liveDirs();
    assert.equal(JSON.parse(await readFile(join(h.scratch, live, "owner.json"), "utf8")).pid, process.pid, "the live session's folder names its owner");
  } finally { await h.restore(); }
});
