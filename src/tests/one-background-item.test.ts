import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { macDesktop, presetDesktopEnv, type LaunchctlExec } from "../mac-desktop.js";
import { envAgentLabel, envAgentPlist, envAgentScript, envAgentScriptPath } from "../desktop-env-agent.js";
import { prepareDesktop } from "../desktop-launch.js";
import { writePrivateJson } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { PATH_KEY, inDesktopHome, desktopFixture, type DesktopFixture as Fixture } from "./desktop-fixture.js";

const mac = { skip: process.platform !== "darwin" };
const fixture = () => desktopFixture("one-item");
const plistOf = (f: Fixture) => join(f.home, "Library/LaunchAgents", envAgentLabel + ".plist");
const read = (path: string) => readFile(path, "utf8").then(text => text, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
/** A registration the daemon may preset: the receipt names a real, executable wrapper, and the release runtime exists. */
async function registered(f: Fixture) {
  const { wrapper } = await prepareDesktop(f.config, f.app);
  await writePrivateJson(f.receipt, { wrapper, registeredAt: new Date().toISOString() });
  const runtime = join(f.root, "share/dist/cli.js"); await mkdir(join(runtime, ".."), { recursive: true }); await writeFile(runtime, "");
  return { wrapper, runtime };
}
/** Every launchctl call that is not a read: the session writes, in order. */
const writes = (f: Fixture) => f.calls.filter(call => !/^(getenv|print)\b/.test(call));
const presetEvents = async (f: Fixture) => { await flushTelemetry(); return (await readTelemetry(f.state, 0)).filter(event => event.event === "desktop_env_preset_failed"); };

test("the preset sets the registered wrapper once, as the first and only launchctl write", mac, async () => {
  for (const current of [undefined, ""] as const) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      const { wrapper, runtime } = await registered(f);
      if (current !== undefined) f.values.set(PATH_KEY, current);
      assert.equal(await presetDesktopEnv(f.state, f.exec, runtime), "set", JSON.stringify(current));
      assert.deepEqual(writes(f), [`setenv ${PATH_KEY} ${wrapper}`]);
      assert.equal(f.values.get(PATH_KEY), wrapper);
    });
  }
});

test("the preset replaces an older wrapper of ours and never a foreign value", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const { wrapper, runtime } = await registered(f);
    const older = join(f.state, "desktop-wrapper-89fafe006c5dc3e4"); await writeFile(older, "#!/bin/sh\n", { mode: 0o700 });
    f.values.set(PATH_KEY, older);
    assert.equal(await presetDesktopEnv(f.state, f.exec, runtime), "set");
    assert.equal(f.values.get(PATH_KEY), wrapper, "our own older value is replaced");
    f.calls.length = 0; f.values.set(PATH_KEY, "/opt/someone/else/codex");
    assert.equal(await presetDesktopEnv(f.state, f.exec, runtime), "skipped");
    assert.deepEqual(writes(f), [], "a foreign override is not touched");
    assert.equal(f.values.get(PATH_KEY), "/opt/someone/else/codex");
    assert.equal((await presetEvents(f)).length, 0, "and it is not a failure");
  });
});

test("the preset does nothing without a receipt, an executable own wrapper, or the release runtime", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    assert.equal(await presetDesktopEnv(f.state, f.exec, join(f.root, "none")), "skipped", "no receipt");
    const { wrapper, runtime } = await registered(f);
    await rm(runtime);
    assert.equal(await presetDesktopEnv(f.state, f.exec, runtime), "skipped", "the release runtime is gone");
    await writeFile(runtime, "");
    await chmod(wrapper, 0o600);
    assert.equal(await presetDesktopEnv(f.state, f.exec, runtime), "skipped", "the wrapper cannot run");
    await chmod(wrapper, 0o700); await rm(wrapper);
    assert.equal(await presetDesktopEnv(f.state, f.exec, runtime), "skipped", "the wrapper is missing");
    for (const foreign of [join(f.root, "elsewhere/desktop-wrapper-0123456789abcdef"), join(f.state, "not-a-wrapper")]) {
      await mkdir(join(foreign, ".."), { recursive: true }); await writeFile(foreign, "#!/bin/sh\n", { mode: 0o700 });
      await writePrivateJson(f.receipt, { wrapper: foreign });
      assert.equal(await presetDesktopEnv(f.state, f.exec, runtime), "skipped", "a wrapper that is not this gateway's own");
    }
    assert.deepEqual(writes(f), [], "no launchctl write in any of these");
    assert.equal(f.calls.length, 0, "and the session is not even read");
  });
});

test("a failing preset records one fixed reason, never the value or a path, and never throws", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const { runtime } = await registered(f);
    configureTelemetry(f.state, "service");
    const secret = "SECRET_ERROR_TEXT /Users/someone/private/path";
    const failSet: LaunchctlExec = async (file, args) => { if (args[0] === "setenv") throw new Error(secret); return f.exec(file, args); };
    assert.equal(await presetDesktopEnv(f.state, failSet, runtime), "failed");
    const unreadable: LaunchctlExec = async () => { throw new Error(secret); };
    assert.equal(await presetDesktopEnv(f.state, unreadable, runtime), "failed");
    assert.deepEqual((await presetEvents(f)).map(event => event.reason), ["setenv", "read"]);
    const raw = (await Promise.all((await readdir(join(f.state, "telemetry"))).map(name => readFile(join(f.state, "telemetry", name), "utf8")))).join("");
    assert.equal(raw.includes("SECRET_ERROR_TEXT") || raw.includes("someone") || raw.includes(f.root) || raw.includes("desktop-wrapper"), false);
  });
});

const seedPlan = (f: Fixture) => writePrivateJson(join(f.state, "service-plan.json"),
  { version: 1, config: f.config, components: [{ id: "inference", kind: "inference", command: f.gateway, args: [], log: join(f.state, "inference.log") }] });
const seedAgent = async (f: Fixture, wrapper: string) => { await writeFile(envAgentScriptPath(f.state), envAgentScript(wrapper), { mode: 0o700 }); await writeFile(plistOf(f), envAgentPlist(envAgentScriptPath(f.state))); };

test("a unified register removes the agent 0.4.7 left, once, and writes none", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await seedPlan(f);
    const { wrapper } = await prepareDesktop(f.config, f.app); await seedAgent(f, wrapper);
    const result = await macDesktop("register", f.config, f.app, true, f.exec);
    assert.deepEqual([result.envAgent, result.loginEnv, result.envAgentRemoved], [false, "service", true]);
    assert.ok(f.calls.includes(`bootout gui/${process.getuid!()}/${envAgentLabel}`), "booted out");
    assert.equal(await read(plistOf(f)), undefined, "plist gone");
    assert.equal(await read(envAgentScriptPath(f.state)), undefined, "script gone");
    assert.equal(f.calls.some(call => call.startsWith("bootstrap") || call.startsWith("enable")), false, "no agent is written or loaded");
    const again = await macDesktop("register", f.config, f.app, true, f.exec);
    assert.equal(again.envAgentRemoved, undefined, "the next start has nothing left to remove");
  });
});

test("a unified register leaves an unmanaged plist at the agent's label alone and only reports it", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await seedPlan(f);
    await writeFile(plistOf(f), "<plist>someone else's job</plist>\n");
    const result = await macDesktop("register", f.config, f.app, true, f.exec);
    assert.deepEqual([result.registered, result.envAgent, result.loginEnv], [true, false, "service"], "no refusal on the service path");
    assert.equal(await read(plistOf(f)), "<plist>someone else's job</plist>\n");
    assert.equal(f.calls.some(call => call.includes(envAgentLabel)), false);
    await flushTelemetry();
    assert.deepEqual((await readTelemetry(f.state, 0)).filter(event => event.event === "desktop_env_agent_failed").map(event => event.reason), ["unmanaged"]);
  });
});

test("a standalone register still writes the agent, and status says which setter a Mac has", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const result = await macDesktop("register", f.config, f.app, false, f.exec);
    const { wrapper } = JSON.parse(await readFile(f.receipt, "utf8")) as { wrapper: string };
    assert.deepEqual([result.envAgent, result.loginEnv], [true, "agent"]);
    assert.equal(await read(plistOf(f)), envAgentPlist(envAgentScriptPath(f.state)));
    assert.equal(await read(envAgentScriptPath(f.state)), envAgentScript(wrapper));
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).loginEnv, "agent");
    await rm(plistOf(f));
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).loginEnv, "none");
    await seedPlan(f);
    const status = await macDesktop("status", f.config, f.app, false, f.exec);
    assert.deepEqual([status.loginEnv, status.envAgent], ["service", false], "with a unified service the daemon sets it");
  });
});

test("under the test runner the default launchctl refuses, so a registered fixture never reaches the real session", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const { runtime } = await registered(f);
    configureTelemetry(f.state, "service");
    assert.ok(process.env.NODE_TEST_CONTEXT !== undefined, "this file runs under node:test");
    // No exec seam: the default would be the real login session, which a test must never reach.
    assert.equal(await presetDesktopEnv(f.state, undefined, runtime), "failed");
    assert.deepEqual(f.calls, [], "nothing went through the fixture either");
    assert.deepEqual((await presetEvents(f)).map(event => event.reason), ["read"]);
  });
});
