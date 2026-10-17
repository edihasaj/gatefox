import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostFailureReason } from "../execution-host.js";
import { sdkVersionTimeoutMs, validateExecutionSdk } from "../execution-host-engine.js";

/** A stand-in SDK whose `--version` answers after `delayMs` (a timer: macOS's first-run check of a new binary, not CPU work). */
async function standIn(directory: string, name: string, delayMs: number, version = "codex-cli 0.162.0-alpha.17.2"): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, `#!${process.execPath}\nsetTimeout(()=>{console.log(${JSON.stringify(version)});process.exit(0);},${delayMs});\n`, { mode: 0o700 });
  return path;
}

test("the SDK version check outlasts macOS's first run of a newly installed engine (sdk_invalid at the 0.4.4 switch)", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gw-sdk-version-"));
  try {
    assert.ok(sdkVersionTimeoutMs >= 15_000, "a first run measured at 2.9 s on an M5 Pro has room on a slower, busier Mac");
    // Over the earlier 5 s limit: that start failed as sdk_invalid and only the retry a second later passed.
    await validateExecutionSdk(await standIn(directory, "slow-first-run", 5500));
    const wrong = await validateExecutionSdk(await standIn(directory, "other-version", 0, "codex-cli 0.200.0")).then(() => undefined, error => error);
    assert.match(String(wrong?.message), /pinned Codex SDK version/, "a different version still fails at once");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an SDK check failure keeps its fixed reason", () => {
  assert.equal(hostFailureReason(new Error("Execution host SDK version check failed")), "sdk_invalid");
});
