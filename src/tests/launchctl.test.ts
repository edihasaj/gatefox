import test from "node:test";
import assert from "node:assert/strict";
import { bootoutJob, isNoSuchProcess } from "../launchctl.js";

const failure = (stderr: string, code = 3) => Object.assign(new Error(`Command failed: /bin/launchctl bootout\n${stderr}`), { code, stderr });

test("a job launchd no longer has counts as already stopped, and any other failure still throws", async () => {
  assert.equal(isNoSuchProcess(failure("Boot-out failed: 3: No such process")), true);
  assert.equal(isNoSuchProcess(failure("Boot-out failed: 5: Input/output error", 5)), false);
  assert.equal(isNoSuchProcess(undefined), false);
  assert.equal(await bootoutJob("gui/501/x", async () => { throw failure("Boot-out failed: 3: No such process"); }), "already_stopped");
  assert.equal(await bootoutJob("gui/501/x", async () => undefined), "stopped");
  await assert.rejects(bootoutJob("gui/501/x", async () => { throw failure("Boot-out failed: 5: Input/output error", 5); }), /Input\/output error/);
});

test("service install and uninstall stop jobs only through the ESRCH-tolerant helper", async () => {
  const { readFile } = await import("node:fs/promises"); const { fileURLToPath } = await import("node:url");
  const source = await readFile(fileURLToPath(new URL("../../src/mac-service.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /\["bootout"/);
  assert.equal(source.match(/bootoutJob\(target\)/g)?.length, 2);
});
