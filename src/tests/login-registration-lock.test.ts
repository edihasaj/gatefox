import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withLoginRegistrationLock } from "../login-registration-lock.js";
import { withPrivateFileLock } from "../private-file-lock.js";

test("a registration already in progress finishes before consolidation can retire its startup file", async () => {
  const state = await mkdtemp(join(tmpdir(), "gateway-login-race-"));
  let started!: () => void; let release!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const registration = withLoginRegistrationLock(state, async () => {
    events.push("registration"); started(); await released;
    await writeFile(join(state, "registration-fixture"), "completed", { mode: 0o600 });
    events.push("registered");
  });
  await began;
  const consolidation = withPrivateFileLock(join(state, "service-login"), async () => {
    assert.equal(await readFile(join(state, "registration-fixture"), "utf8"), "completed");
    events.push("consolidation");
  });
  try { await delay(50); assert.deepEqual(events, ["registration"]); }
  finally { release(); await Promise.all([registration, consolidation]); }
  assert.deepEqual(events, ["registration", "registered", "consolidation"]);
});
