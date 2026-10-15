import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { macTunnel } from "../mac-tunnel.js";
import { pendingLoginConsolidationPath } from "../mac-login-consolidate.js";
import { withLoginRegistrationLock } from "../login-registration-lock.js";
import { withPrivateFileLock } from "../private-file-lock.js";
import { readServicePlan, servicePlanPath, type ServicePlan } from "../service-plan.js";
import { writePrivateJson } from "../config.js";
import { darwin, fixture, homeIn, ids, noBackups, noSsh, none, remoteLookup, remove } from "./mac-tunnel-remove-fixtures.js";

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
  // No machine registers a tunnel named after this process, so the registration fallback cannot touch a real one.
  const id = `zz-test-${process.pid}`;
  const plan: ServicePlan = { ...f.plan, components: f.plan.components.map(component =>
    component.id === "tunnel-spark" ? { ...component, id: `tunnel-${id}`, log: join(f.state, `tunnel-${id}.log`) } : component) };
  await writePrivateJson(servicePlanPath(f.state), plan);
  try {
    // The plan is hidden first, so the command takes the registration path and waits for the login lock.
    const path = servicePlanPath(f.state);
    await rename(path, path + ".hidden");
    await darwin(async () => homeIn(f.root, async () => {
      let removal!: Promise<Record<string, unknown>>; let outcome!: ReturnType<typeof settle>; let waited!: number;
      // This holder keeps the plan lock from here on, so once it frees the login lock the uninstall waits for the plan.
      await withPrivateFileLock(path, async () => {
        await withLoginRegistrationLock(f.state, async () => {
          removal = macTunnel("uninstall", { id }, f.state, none, seams()); outcome = settle(removal);
          await delay(150); assert.equal(outcome.done, false, "the uninstall waits for the login lock");
          await rename(path + ".hidden", path);
          // Read back under the login lock: the uninstall cannot reach its plan check until this holder releases it.
          assert.ok(await readServicePlan(f.state), "the plan is back before the login lock is released");
        });
        await delay(150);
        assert.equal(outcome.done, false, "the uninstall now waits for the plan lock this holder keeps");
        const began = Date.now();
        await withLoginRegistrationLock(f.state, async () => {});
        waited = Date.now() - began;
      });
      assert.ok(waited < 1000, `the login lock was free while the uninstall waited for the plan lock (took ${waited} ms)`);
      assert.equal((await removal).removed, true);
    }));
    assert.deepEqual(ids((await readServicePlan(f.state))!), ids(plan).filter(componentId => componentId !== `tunnel-${id}`));
  } finally { await f.stop(); }
});

/** The plan can also move away again in the moment between the uninstall seeing it under the login lock and reading it once that lock is gone. */
test("a unified plan that appeared and moved again before its re-read is refused, never treated as a separate tunnel", async () => {
  const f = await fixture(ok);
  // No machine registers a tunnel named after this process, so the registration fallback cannot touch a real one.
  const id = `zz-test-${process.pid}`;
  const plan: ServicePlan = { ...f.plan, components: f.plan.components.map(component =>
    component.id === "tunnel-spark" ? { ...component, id: `tunnel-${id}`, log: join(f.state, `tunnel-${id}.log`) } : component) };
  await writePrivateJson(servicePlanPath(f.state), plan);
  try {
    // Hidden at the start, so the command takes the registration path and waits for the login lock.
    const path = servicePlanPath(f.state);
    await rename(path, path + ".hidden");
    await darwin(async () => homeIn(f.root, async () => {
      let removal!: Promise<unknown>; let outcome!: ReturnType<typeof settle>;
      await withLoginRegistrationLock(f.state, async () => {
        // The seam runs once the uninstall has seen the plan under this lock and let that lock go: the plan moves away there.
        removal = macTunnel("uninstall", { id }, f.state, none, { ...seams(), planAppeared: async () => { await rename(path, path + ".hidden"); } });
        outcome = settle(removal);
        await delay(150);
        assert.equal(outcome.done, false, "the uninstall waits for the login lock");
        await rename(path + ".hidden", path);
        assert.ok(await readServicePlan(f.state), "the plan is back before the login lock is released");
      });
      await assert.rejects(removal, /^Error: Gateway service plan changed; repeat the tunnel removal$/);
    }));
    assert.equal(await readServicePlan(f.state), undefined, "no plan was written back");
    assert.deepEqual(JSON.parse(await readFile(path + ".hidden", "utf8")), plan, "the plan the other command moved is untouched");
    await noBackups(f.state);
  } finally { await f.stop(); }
});

/** The login lock is what moves the plan: `gateway service uninstall` trashes it and `service consolidate --next-login`
 * stages a plan under it, both without the plan lock. A unified-plan removal must wait for that lock too. */
test("a removal that only held the plan lock would overwrite a plan the login-lock holder moved to Trash", async () => {
  const f = await fixture(ok);
  try {
    await darwin(async () => {
      let removal!: Promise<unknown>; let outcome!: ReturnType<typeof settle>;
      await withLoginRegistrationLock(f.state, async () => {
        removal = macTunnel("uninstall", { id: "spark" }, f.state, none, seams()); outcome = settle(removal);
        await delay(200);
        assert.equal(outcome.done, false, "the uninstall waits for the login lock the plan writer holds");
        await rename(servicePlanPath(f.state), join(f.root, "service-plan.in-trash.json"));
      });
      await assert.rejects(removal, /^Error: Gateway service plan changed; repeat the tunnel removal$/);
    });
    assert.equal(await readServicePlan(f.state), undefined, "the removed plan was not written back from a stale copy");
    await noBackups(f.state);
  } finally { await f.stop(); }
});

test("a consolidation staged under the login lock while the removal waits is refused instead of overwritten", async () => {
  const f = await fixture(ok);
  try {
    await darwin(async () => {
      let removal!: Promise<unknown>; let outcome!: ReturnType<typeof settle>;
      await withLoginRegistrationLock(f.state, async () => {
        removal = macTunnel("uninstall", { id: "spark" }, f.state, none, seams()); outcome = settle(removal);
        await delay(200);
        assert.equal(outcome.done, false, "the uninstall waits for the login lock the staging command holds");
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

/** Here the plan lock is the one the removal holds: only the login lock fails, so the registration is named. */
test("a login lock still held after five seconds fails the removal as registration busy", async () => {
  const f = await fixture(ok);
  try {
    let release!: () => void;
    const held = withLoginRegistrationLock(f.state, () => new Promise<void>(done => { release = done; }));
    await delay(100);
    assert.ok(existsSync(join(f.state, "service-login.lock")), "this test holds the login lock");
    const began = Date.now();
    // The plan lock gets a timeout it never needs: the wait that ends here is the login lock's own five seconds.
    await assert.rejects(remove(f.state, "spark", none, { resolveSsh: noSsh, lockTimeoutMs: 60_000 }),
      /^Error: Gateway service registration is busy; the tunnel was not removed$/);
    assert.ok(Date.now() - began >= 5000, "the removal waited the whole five seconds");
    release(); await held;
    assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
    await noBackups(f.state);
  } finally { await f.stop(); }
});

test("a login lock file that cannot be opened fails the removal as a registration lock error", async () => {
  const f = await fixture(ok);
  try {
    // A directory where the lock file belongs. The shared guard rejects an invalid lock, which carries no errno, so the message names none.
    await mkdir(join(f.state, "service-login.lock"), { recursive: true, mode: 0o700 });
    await assert.rejects(remove(f.state, "spark"), /^Error: Cannot lock the gateway service registration; the tunnel was not removed$/);
    assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
    await noBackups(f.state);
  } finally { await f.stop(); }
});
