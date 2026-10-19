import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { copilotParent } from "../providers/copilot-directories.js";
import { executionHostHome } from "../execution-host-storage.js";
import { shortFolder } from "./short-folder.js";

// The suite starts gateways and fixture Copilot CLIs whose folders and startup sweep live in the temp folder. `npm test` runs
// it under one private temp folder (scripts/run-tests.mjs), so no test touches the real `<TMPDIR>/harness-gateway-copilot-<uid>`.
const runner = fileURLToPath(new URL("../../scripts/run-tests.mjs", import.meta.url));
const run = promisify(execFile);
const exists = (path: string) => stat(path).then(() => true, () => false);

test("the suite runs under a private temp folder, so no test reaches the real Copilot folder", async () => {
  const given = process.env.GATEWAY_TEST_TMPDIR;
  assert.ok(given, "run the suite with `npm test`: it gives the tests a private temp folder (scripts/run-tests.mjs)");
  assert.equal(tmpdir(), given, "the temp folder is the runner's");
  assert.ok(copilotParent().startsWith(given + sep), "so the Copilot parent, whose name the gateway derives from it, is inside it");
  assert.match(given, /gwt-/);
});

test("the suite runs under a private home folder, so no test reaches the real execution-host folder", async () => {
  const given = process.env.GATEWAY_TEST_TMPDIR;
  assert.ok(given, "run the suite with `npm test`: it gives the tests a private home folder (scripts/run-tests.mjs)");
  assert.equal(homedir(), join(given, "home"), "the home folder is the runner's");
  assert.equal((await stat(homedir())).mode & 0o777, 0o700, "and private");
  assert.ok(executionHostHome("/gateway.json", "/native").startsWith(join(given, "home") + sep), "so an execution host's folder, receipts and socket links are inside the run's folder");
});

test("a short folder for a socket test is made inside the runner's folder, so nothing it holds outlives the run", async () => {
  const given = process.env.GATEWAY_TEST_TMPDIR;
  assert.ok(given, "run the suite with `npm test`");
  const folder = await shortFolder("gw-isolation-");
  try { assert.ok(folder.directory.startsWith(given + sep), "inside the runner's folder, not beside it in /tmp"); }
  finally { await folder.remove(); }
  assert.equal(await exists(folder.directory), false, "and removed by its owner");
});

test("a test process writes no diagnostic report on a signal, and no shipped file turns reports on", async () => {
  // Node's test runner starts this process with `--report-signal=SIGUSR2`, which alone turns report-on-signal on: one SIGUSR2
  // would write a report, environment values included, into the repository. scripts/test-preload.mjs turns it off.
  assert.equal(process.report.reportOnSignal, false, "no report on a signal in a test process");
  assert.ok(process.env.GATEWAY_TEST_TMPDIR, "run the suite with `npm test`");
  assert.equal(process.report.directory, process.env.GATEWAY_TEST_TMPDIR, "and any other report lands in the run's private folder");
  const root = fileURLToPath(new URL("../..", import.meta.url)); const shipped: string[] = [];
  for (const folder of ["dist", "dist/auth", "dist/providers", "dist/protocol"]) {
    for (const name of await readdir(join(root, folder))) if (name.endsWith(".js")) shipped.push(join(root, folder, name));
  }
  shipped.push(join(root, "scripts", "codex-desktop-shim"), join(root, "scripts", "e2e-fast-mode.mjs"));
  assert.ok(shipped.length > 50, "the compiled files were found");
  for (const file of shipped) assert.doesNotMatch(await readFile(file, "utf8"), /--report-|\breportOn|report\.writeReport\(/, `${file} turns diagnostic reports on`);
});

test("the test runner gives a run its own temp folder, passes the exit code on, and removes the folder after a pass and after a failure", { timeout: 60000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), "gateway-runner-test-"));
  try {
    const record = join(work, "record.json");
    // The test runner marks the processes it starts; a nested run must start as a run of its own.
    const environment: NodeJS.ProcessEnv = { ...process.env, RUNNER_RECORD: record, CODEX_HOME: join(work, "inherited-codex-home") }; delete environment.NODE_TEST_CONTEXT;
    const suite = async (name: string, body: string) => {
      const file = join(work, `${name}.test.mjs`);
      await writeFile(file, `import test from "node:test"; import assert from "node:assert/strict"; import { writeFileSync } from "node:fs"; import { homedir, tmpdir } from "node:os"; import { join } from "node:path";\n` +
        `test("${name}", () => { assert.ok(process.env.CODEX_HOME === join(homedir(), ".codex"), "native home must belong to this run"); writeFileSync(process.env.RUNNER_RECORD, JSON.stringify({ tmpdir: tmpdir(), home: homedir(), marker: process.env.GATEWAY_TEST_TMPDIR })); ${body} });\n`);
      return file;
    };
    for (const [name, body, passes] of [["passing", "", true], ["failing", "assert.fail('fixture failure');", false]] as const) {
      const file = await suite(name, body);
      const outcome = await run(process.execPath, [runner, file], { env: environment }).then(() => 0, (error: { code?: number }) => error.code ?? 1);
      assert.equal(outcome === 0, passes, `${name}: the runner's exit code follows the suite's`);
      const seen = JSON.parse(await readFile(record, "utf8")) as { tmpdir: string; home: string; marker: string };
      assert.notEqual(seen.tmpdir, tmpdir(), `${name}: the suite did not get this process's temp folder`);
      assert.equal(seen.marker, seen.tmpdir, `${name}: the marker names the folder the tests saw`);
      assert.equal(seen.home, join(seen.tmpdir, "home"), `${name}: the suite's home folder is inside the run's folder`); assert.notEqual(seen.home, homedir(), `${name}: and is not this process's`);
      assert.equal(await exists(seen.tmpdir), false, `${name}: the folder is removed afterwards`);
    }
  } finally { await rm(work, { recursive: true, force: true }); }
});
