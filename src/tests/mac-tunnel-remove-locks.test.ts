import test from "node:test";
import assert from "node:assert/strict";
import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { macTunnel } from "../mac-tunnel.js";
import { pendingLoginConsolidationPath } from "../mac-login-consolidate.js";
import { withLoginRegistrationLock } from "../login-registration-lock.js";
import { withPrivateFileLock } from "../private-file-lock.js";
import { readServicePlan, servicePlanPath, type ServicePlan } from "../service-plan.js";
import { writePrivateJson } from "../config.js";
import { darwin, fixture, ids, noBackups, noSsh, none, remoteLookup } from "./mac-tunnel-remove-fixtures.js";

const ok = { active: 0, status: "ok" };
const seams = (lockTimeoutMs = 5000) => ({ resolveSsh: noSsh, lookup: remoteLookup, lockTimeoutMs });
const settle = (promise: Promise<unknown>) => { const outcome = { done: false, error: undefined as unknown }; promise.then(() => { outcome.done = true; }, error => { outcome.done = true; outcome.error = error; }); return outcome; };

test("a tunnel uninstall waiting for the plan lock never holds the login lock the plan-lock holder needs next", async () => {
  const f = await fixture(ok);
  try {
    await darwin(async () => {
      let removal!: Promise<Record<string, unknown>>; let outcome!: ReturnType<typeof settle>;
      // The uninstall waits up to 3 seconds for the plan lock. A holder that then needs the login lock (the order
      // shared-executors, shared-native and shared-disable use) must get it at once, not after the uninstall gives up.
      const waited = await withPrivateFileLock(servicePlanPath(f.state), async () => {
        removal = macTunnel("uninstall", { id: "spark" }, f.state, none, seams(3000)); outcome = settle(removal);
        await delay(300);
        assert.equal(outcome.done, false, "the uninstall is waiting for the plan lock");
        const began = Date.now();
        await withLoginRegistrationLock(f.state, async () => {});
        assert.equal(outcome.done, false, "the uninstall is still waiting while the holder takes the login lock");
        return Date.now() - began;
      });
      assert.ok(waited < 1000, `the login lock was free immediately (took ${waited} ms)`);
      const result = await removal;
      assert.equal(result.removed, true, "once the plan lock is free the uninstall completes instead of failing busy");
    });
    assert.deepEqual(ids((await readServicePlan(f.state))!), ["inference", "desktop", "tunnel-studio"]);
  } finally { await f.stop(); }
});

test("a login consolidation staged while the uninstall waits for the plan lock is refused under that lock", async () => {
  const f = await fixture(ok);
  try {
    await darwin(async () => {
      let removal!: Promise<unknown>; let outcome!: ReturnType<typeof settle>;
      await withPrivateFileLock(servicePlanPath(f.state), async () => {
        removal = macTunnel("uninstall", { id: "spark" }, f.state, none, seams()); outcome = settle(removal);
        await delay(150);
        assert.equal(outcome.done, false, "the uninstall passed its first pending check and waits for the plan lock");
        const staged: ServicePlan = { ...f.plan, components: f.plan.components.filter(component => component.id !== "tunnel-studio") };
        const label = "com.edihasaj.subscription-gateway";
        await writePrivateJson(pendingLoginConsolidationPath(f.state), { version: 1, phase: "ready", config: f.plan.config, plan: staged, primaryLabel: label, primaryPlistDigest: "a".repeat(64),
          removedLabels: [], backup: join(f.state, "service-backups", "login-consolidation-test.json"), sources: [{ label, digest: "b".repeat(64), mode: 0o600 }] });
      });
      await assert.rejects(removal, /^Error: Tunnel startup is staged under the unified service at next login; its separate registration was not changed$/);
    });
    assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
    await noBackups(f.state);
  } finally { await f.stop(); }
});

test("a unified plan that appears while the uninstall waits for the login lock is removed without that lock", async () => {
  const f = await fixture(ok);
  try {
    // The plan is hidden first, so the command takes the registration path and waits for the login lock.
    const path = servicePlanPath(f.state);
    await rename(path, path + ".hidden");
    await darwin(async () => {
      let removal!: Promise<Record<string, unknown>>;
      await withLoginRegistrationLock(f.state, async () => {
        removal = macTunnel("uninstall", { id: "spark" }, f.state, none, seams()); const outcome = settle(removal);
        await delay(150); assert.equal(outcome.done, false, "the uninstall waits for the login lock");
        await rename(path + ".hidden", path);
      });
      assert.equal((await removal).removed, true);
    });
    assert.deepEqual(ids((await readServicePlan(f.state))!), ids(f.plan).filter(id => id !== "tunnel-spark"));
  } finally { await f.stop(); }
});
