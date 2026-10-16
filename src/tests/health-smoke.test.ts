import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSmoke, smokeEnvironment, smokeRoot, smokeScript, type SmokeDeps, type SmokeLaunch } from "../health-smoke.js";
import { smokeTimeoutMs, type AppInfo } from "../health-types.js";

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
  const directory = await mkdtemp(join(tmpdir(), "gw-smoke-"));
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
});
