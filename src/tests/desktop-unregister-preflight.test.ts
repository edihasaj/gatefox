import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { macDesktop, ownWrapper, planDesktopUnregister } from "../mac-desktop.js";
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

test("the plan refuses a registration the unified service owns, and so does unregister", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await legacyPair(f);
    // One plan is enough to pin the guard: the unified service's plan and its pending login promotion are two
    // files read by the same check, before the session is asked anything.
    await writePrivateJson(join(f.state, "service-plan.json"), { version: 1, config: f.config, components: [{ id: "inference", kind: "inference", command: f.gateway, args: [], log: join(f.state, "inference.log") }] });
    for (const [what, step] of [
      ["the plan", () => planDesktopUnregister(f.config, f.exec)],
      ["unregister", () => macDesktop("unregister", f.config, f.app, false, f.exec)],
    ] as const) {
      await assert.rejects(step(), /owned by the unified service or its pending login plan/, what);
    }
    assert.deepEqual(f.calls, [], "ownership was settled from the state directory alone");
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
