import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { macDesktop, ownWrapper, planDesktopUnregister, type LaunchctlExec } from "../mac-desktop.js";
import { withLoginRegistrationLock } from "../login-registration-lock.js";
import { prepareDesktop } from "../desktop-launch.js";
import { writePrivateJson } from "../config.js";
import { FORCE, inDesktopHome, PATH_KEY, desktopFixture, type DesktopFixture as Fixture } from "./desktop-fixture.js";

const mac = { skip: process.platform !== "darwin" };
const fixture = () => desktopFixture("unregister-preflight");
const label = "com.edihasaj.subscription-gateway.desktop";
const plist = (f: Fixture) => join(f.home, "Library/LaunchAgents", label + ".plist");

/** The receipt and session pair an older gateway exported, with this registration's wrapper still in place. */
async function legacyPair(f: Fixture) {
  const { wrapper } = await prepareDesktop(f.config, f.app);
  await writePrivateJson(f.receipt, { wrapper, registeredAt: new Date().toISOString() });
  f.values.set(PATH_KEY, wrapper); f.values.set(FORCE, "1");
  return wrapper;
}

/** The unified service's plan, as `gateway service install` leaves it in the state directory. */
async function servicePlanFile(f: Fixture) {
  await writePrivateJson(join(f.state, "service-plan.json"), { version: 1, config: f.config, components: [{ id: "inference", kind: "inference", command: f.gateway, args: [], log: join(f.state, "inference.log") }] });
}
/**
 * A login promotion staged for the next login. Unlike the service plan, it outlives `gateway service uninstall`,
 * so it keeps ownership of the registration for every caller.
 */
async function pendingLoginFile(f: Fixture) {
  const plan = { version: 1, config: f.config, components: [{ id: "inference", kind: "inference", command: f.gateway, args: [], log: join(f.state, "inference.log") }] };
  await writePrivateJson(join(f.state, "service-login-pending.json"), {
    version: 1, phase: "ready", config: f.config, plan,
    primaryLabel: "com.edihasaj.subscription-gateway", primaryPlistDigest: "a".repeat(64), removedLabels: [],
    backup: join(f.state, "service-backups", "bundle"),
    sources: [{ label: "com.edihasaj.subscription-gateway", digest: "b".repeat(64), mode: 0o600 }],
  });
}
/**
 * The launchctl calls made since `from`, so a step can be proven to have read the session without touching it.
 * A fixture's earlier steps (a register, for instance) leave their own calls behind, so pass the offset.
 */
const writes = (f: Fixture, from = 0) => f.calls.slice(from).filter(call => !call.startsWith("getenv "));

test("the unregister plan reads the registration, the plist, and the session, and writes nothing", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const wrapper = await legacyPair(f);
    const before = await readFile(f.receipt, "utf8");
    const plan = await planDesktopUnregister(f.config, f.exec);
    assert.equal(plan.unregisterReady, true);
    assert.equal(plan.loginAgent, "absent", "nothing registered a login agent here");
    assert.equal(plan.cliPathOurs, true);
    assert.equal(plan.receiptNamesWrapper, true);
    assert.ok(!("legacyForceCliKept" in plan), "the receipt proves the pair, so unregister would clear both");
    assert.deepEqual(writes(f), [], "the plan is reads only");
    assert.equal(await readFile(f.receipt, "utf8"), before, "the receipt is untouched");
    const json = JSON.stringify(plan);
    assert.equal(json.includes(wrapper), false, "no path leaves the plan");
    assert.equal(json.includes("getenv"), false, "and neither does a variable value");
  });
});

/**
 * This is the refusal `gateway uninstall` runs the plan for: an unmanaged plist must stop the whole thing before
 * a single session read, let alone a removal.
 */
test("the plan refuses an unmanaged desktop LaunchAgent before it reads the session", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const wrapper = await legacyPair(f);
    await writeFile(plist(f), "<plist><dict><Label><string>somebody else</string></Label></dict></plist>\n");
    const before = await readFile(plist(f), "utf8");
    await assert.rejects(planDesktopUnregister(f.config, f.exec), /Refusing to change an unmanaged desktop LaunchAgent/);
    await assert.rejects(macDesktop("unregister", f.config, f.app, false, f.exec), /Refusing to change an unmanaged desktop LaunchAgent/);
    assert.deepEqual(f.calls, [], "the refusal answers before launchctl is even asked");
    assert.equal(await readFile(plist(f), "utf8"), before, "the foreign plist is left where it was");
    assert.equal(f.values.get(PATH_KEY), wrapper, "the session still holds the path it did");
    assert.equal((JSON.parse(await readFile(f.receipt, "utf8")) as { wrapper: string }).wrapper, wrapper, "and the receipt still names it");
  });
});

/**
 * The gap a plan cannot close on its own: between the plan and the writes, a plist can take the LaunchAgent's place.
 * unregister reads the marker again before it unsets anything, so the swap is refused with the session and the
 * receipt exactly as they were, and the file that arrived is left where it is rather than moved to the Trash.
 */
test("unregister re-reads the marker before its first write, so a plist swapped in after the plan is refused", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await macDesktop("register", f.config, f.app, false, f.exec);
    const managed = await readFile(plist(f), "utf8");
    assert.match(managed, /Managed by subscription-gateway desktop/, "register left a plist we own");
    await legacyPair(f);
    const foreign = "<plist><dict><Label><string>somebody else</string></Label></dict></plist>\n";
    let swapped = false;
    // The arrival is timed to the plan's first session read, which is the last moment a swap still costs nothing.
    const exec: LaunchctlExec = async (file, args) => {
      if (!swapped && args[0] === "getenv" && args[1] === PATH_KEY) { swapped = true; await writeFile(plist(f), foreign); }
      return f.exec(file, args);
    };
    const beforeReceipt = await readFile(f.receipt, "utf8");
    const beforeCalls = f.calls.length;
    await assert.rejects(macDesktop("unregister", f.config, f.app, false, exec), /Refusing to change an unmanaged/, "the swap lands after the plan read the managed file");
    assert.ok(swapped, "and the seam really did replace it");
    assert.equal(writes(f, beforeCalls).some(call => call.startsWith("unsetenv")), false, "not one session write reached launchctl");
    assert.equal(await readFile(f.receipt, "utf8"), beforeReceipt, "the receipt is untouched");
    assert.equal(await readFile(plist(f), "utf8"), foreign, "the foreign plist is still in LaunchAgents, not in the Trash");
  });
});

test("the plan refuses a registration the unified service owns, and so does unregister", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await legacyPair(f);
    // One file is enough to pin the guard here: the service plan and its pending login promotion answer the same
    // check, before the session is asked anything. The next test covers the one caller that may skip the plan.
    await servicePlanFile(f);
    for (const [what, step] of [
      ["the plan", () => planDesktopUnregister(f.config, f.exec)],
      ["unregister", () => macDesktop("unregister", f.config, f.app, false, f.exec)],
    ] as const) {
      await assert.rejects(step(), /owned by the unified service or its pending login plan/, what);
    }
    assert.deepEqual(f.calls, [], "ownership was settled from the state directory alone");
  });
});

/**
 * The one case the plain refusal gets wrong: `gateway uninstall` plans first and runs the service uninstall
 * second, and that service step moves this very file to the Trash. serviceRemovedFirst is how the uninstaller
 * says so; a standalone unregister never passes it and keeps refusing.
 */
test("the plan skips the service-plan refusal only for the uninstaller that removes it next", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await legacyPair(f);
    await servicePlanFile(f);
    await assert.rejects(planDesktopUnregister(f.config, f.exec), /owned by the unified service or its pending login plan/, "without the flag, the plan still refuses");
    await assert.rejects(macDesktop("unregister", f.config, f.app, false, f.exec), /owned by the unified service or its pending login plan/, "and so does a standalone unregister");
    assert.deepEqual(f.calls, [], "both refusals settled ownership from the state directory alone");
    const beforePlan = f.calls.length;
    const plan = await planDesktopUnregister(f.config, f.exec, { serviceRemovedFirst: true });
    assert.equal(plan.unregisterReady, true, "the uninstaller is allowed to plan past a service plan it is about to remove");
    assert.equal(plan.cliPathOurs, true, "and it reads the same session the plain plan would have");
    assert.deepEqual(writes(f, beforePlan), [], "the flag does not make the plan write anything");
    // A pending login promotion survives the service uninstall, so it keeps its refusal even with the flag.
    await pendingLoginFile(f);
    await assert.rejects(planDesktopUnregister(f.config, f.exec, { serviceRemovedFirst: true }), /owned by the unified service or its pending login plan/, "the pending login plan still owns the registration");
    await assert.rejects(macDesktop("unregister", f.config, f.app, false, f.exec), /owned by the unified service or its pending login plan/, "and for unregister too");
  });
});

test("the plan reads FORCE_CLI only once the path proves itself ours, and says what unregister would keep", mac, async () => {
  for (const [name, seed, expected] of [
    ["a receipt naming a wrapper", async (f: Fixture) => legacyPair(f), false],
    ["our wrapper with no receipt", async (f: Fixture) => {
      const stale = join(f.state, "desktop-wrapper-98fedcba01234567");
      f.values.set(PATH_KEY, stale); f.values.set(FORCE, "1"); return stale;
    }, true],
  ] as const) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      await seed(f);
      const plan = await planDesktopUnregister(f.config, f.exec);
      assert.equal(plan.cliPathOurs, true, name);
      assert.equal(plan.legacyForceCliKept === true, expected, name);
      assert.deepEqual(writes(f), [], name + ": the plan still wrote nothing");
      const result = await macDesktop("unregister", f.config, f.app, false, f.exec);
      assert.equal(result.legacyForceCliKept === true, expected, name + ": unregister then does what the plan said");
      assert.ok(f.calls.includes(`unsetenv ${PATH_KEY}`), name);
      assert.equal(f.calls.includes(`unsetenv ${FORCE}`), !expected, name + ": the unproven 1 is kept, the proven one cleared");
    });
  }
});

test("a path the shared wrapper rule refuses is foreign to the plan, and FORCE_CLI is never read for it", mac, async () => {
  for (const [what, path] of [
    ["a trailing separator", (f: Fixture) => join(f.state, "desktop-wrapper-456789abcdef0123") + "/"],
    // Built by hand: joining a path collapses the `..` and leaves a plain path inside the state directory.
    ["a path that climbs back", (f: Fixture) => `${f.state}/sub/../desktop-wrapper-456789abcdef0123`],
    ["a name in a subdirectory", (f: Fixture) => join(f.state, "sub", "desktop-wrapper-456789abcdef0123")],
    ["the same name elsewhere", () => "/opt/desktop-wrapper-456789abcdef0123"],
  ] as const) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      await legacyPair(f);
      const foreign = path(f); f.values.set(PATH_KEY, foreign);
      assert.equal(await ownWrapper(f.state, foreign), false, what + ": the shared rule that registration uses calls it foreign");
      const plan = await planDesktopUnregister(f.config, f.exec);
      assert.equal(plan.cliPathOurs, false, what + ": so does the plan");
      assert.deepEqual(f.calls, [`getenv ${PATH_KEY}`], what + ": only the path was read, never the value beside it");
      assert.equal(JSON.stringify(plan).includes(foreign), false, what + ": the refused path is never reported");
      const afterPlan = f.calls.length;
      assert.equal((await macDesktop("unregister", f.config, f.app, false, f.exec)).registered, false, what);
      assert.equal(writes(f, afterPlan).includes(`unsetenv ${FORCE}`), false, what + ": unregister keeps the same answer");
      assert.equal(f.values.get(PATH_KEY), foreign, what);
      assert.equal(f.values.get(FORCE), "1", what + ": neither step touched the value");
    });
  }
});

/**
 * A receipt that is not JSON fails both steps with a parse error and nothing else: `gateway uninstall` turns
 * that into "Invalid JSON data", which is why the failure must not be smothered into a silent "no receipt".
 */
test("a receipt that is not JSON stops the plan and unregister before either writes", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const wrapper = await legacyPair(f);
    const broken = '<html>a receipt that never was JSON</html>';
    await writeFile(f.receipt, broken);
    for (const [what, step] of [
      ["the plan", () => planDesktopUnregister(f.config, f.exec)],
      ["unregister", () => macDesktop("unregister", f.config, f.app, false, f.exec)],
    ] as const) {
      await assert.rejects(step(), (error: unknown) => {
        assert.ok(error instanceof SyntaxError, what + ": the parse failure reaches the caller as a SyntaxError");
        return true;
      }, what);
      assert.equal(await readFile(f.receipt, "utf8"), broken, what + ": the receipt is never rewritten");
      assert.equal(f.values.get(PATH_KEY), wrapper, what + ": nor is the session");
      assert.deepEqual(writes(f), [], what + ": nothing was written");
    }
  });
});

/**
 * The shapes JSON.parse accepts and a registration never writes. Each must fail the plan by name, not read as the
 * absent receipt unregister itself writes: "no registration" would let unregister clear a session the gateway never
 * set, and a malformed wrapper is no proof of anything.
 */
test("a receipt that parses into something other than a registration fails the plan before it reads the session", mac, async () => {
  for (const shape of ["null", "[]", '{"wrapper":5}'] as const) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      const wrapper = await legacyPair(f);
      await writeFile(f.receipt, shape);
      await assert.rejects(planDesktopUnregister(f.config, f.exec), /Desktop registration receipt is invalid/, shape);
      assert.deepEqual(f.calls, [], shape + ": the refusal answered before launchctl was even asked");
      assert.equal(await readFile(f.receipt, "utf8"), shape, shape + ": the file is left exactly as it was found");
      assert.equal(f.values.get(PATH_KEY), wrapper, shape + ": and the session still holds the path it did");
    });
  }
});

test("the plan reports a login agent we wrote, and unregister is the step that moves it", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await macDesktop("register", f.config, f.app, false, f.exec);
    assert.match(await readFile(plist(f), "utf8"), /Managed by subscription-gateway desktop/);
    const afterRegister = f.calls.length;
    const plan = await planDesktopUnregister(f.config, f.exec);
    assert.equal(plan.loginAgent, "managed");
    assert.deepEqual(writes(f, afterRegister), [], "reading the plan still writes nothing");
    assert.equal((await macDesktop("unregister", f.config, f.app, false, f.exec)).registered, false);
    assert.ok(f.calls.includes(`bootout gui/${process.getuid!()}/${label}`), "the login agent is booted out");
    await assert.rejects(readFile(plist(f), "utf8"), { code: "ENOENT" }, "and its plist is out of LaunchAgents");
  });
});
/**
 * Every desktop write takes the login-registration lock, and so does the next-login consolidation. The plan takes it
 * too, so it never describes a session that is being changed underneath it: while another holder is inside the lock,
 * the plan has not even read the session, and it starts only once the lock is released.
 */
test("the plan waits for a registration or consolidation that already holds the lock", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await legacyPair(f);
    let started!: () => void; let release!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const holder = withLoginRegistrationLock(f.state, async () => { started(); await released; });
    await began;
    const plan = planDesktopUnregister(f.config, f.exec);
    try {
      await delay(150);
      assert.deepEqual(f.calls, [], "the waiting plan read nothing from the session");
    } finally {
      release();
      await holder;
    }
    assert.equal((await plan).unregisterReady, true, "released, it plans the same session the holder left alone");
    assert.deepEqual(f.calls, [`getenv ${PATH_KEY}`, `getenv ${FORCE}`], "and only then asks the session, reads first");
  });
});
