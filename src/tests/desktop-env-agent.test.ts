import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { macDesktop, planDesktopUnregister, type LaunchctlExec } from "../mac-desktop.js";
import { envAgentLabel, envAgentPlist, readGuiCliPath, writeEnvAgent } from "../desktop-env-agent.js";
import { prepareDesktop } from "../desktop-launch.js";
import { writePrivateJson } from "../config.js";
import { uninstallGateway, type UninstallDeps } from "../uninstall.js";
import { kindFor, collectServicePlan } from "../mac-consolidate.js";
import { validateServicePlan } from "../service-plan.js";
import { classifyCommand } from "../versions.js";
import { PATH_KEY, FORCE, inDesktopHome, desktopFixture, type DesktopFixture as Fixture } from "./desktop-fixture.js";

const mac = { skip: process.platform !== "darwin" };
const fixture = () => desktopFixture("env-agent");
const plistOf = (f: Fixture) => join(f.home, "Library/LaunchAgents", envAgentLabel + ".plist");
const target = () => `gui/${process.getuid!()}/${envAgentLabel}`;
const read = (path: string) => readFile(path, "utf8").then(text => text, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });

test("the agent is exactly one launchctl setenv at login, with no node, no KeepAlive and no other environment", async () => {
  const wrapper = "/state/desktop-wrapper-0123456789abcdef";
  const text = envAgentPlist(wrapper);
  assert.match(text, /<!-- Managed by subscription-gateway desktop-env -->/);
  assert.ok(text.includes(`<key>Label</key><string>${envAgentLabel}</string>`));
  assert.ok(text.includes(`<key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>CODEX_CLI_PATH</string><string>${wrapper}</string></array>`));
  assert.ok(text.includes("<key>RunAtLoad</key><true/>"));
  assert.ok(text.includes("<key>LimitLoadToSessionType</key><string>Aqua</string>"));
  for (const forbidden of ["KeepAlive", "EnvironmentVariables", "node", "WorkingDirectory", "StandardOutPath"]) assert.equal(text.includes(forbidden), false, forbidden);
  assert.ok(envAgentPlist("/a&b/<x>").includes("<string>/a&amp;b/&lt;x&gt;</string>"), "the path is escaped");
});

test("the generated plist is valid", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const file = join(f.root, "agent.plist"); await writeFile(file, envAgentPlist(join(f.state, "desktop-wrapper-0123456789abcdef")));
    const { stdout } = await promisify(execFile)("/usr/bin/plutil", ["-lint", file]);
    assert.match(stdout, /OK/);
  });
});

test("register writes a private agent that names the registered wrapper and loads it into the login session", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const result = await macDesktop("register", f.config, f.app, false, f.exec);
    const { wrapper } = JSON.parse(await readFile(f.receipt, "utf8")) as { wrapper: string };
    assert.equal(result.envAgent, true);
    assert.equal(await read(plistOf(f)), envAgentPlist(wrapper));
    assert.ok(wrapper.startsWith(f.state + "/desktop-wrapper-"), "the stable registered wrapper, never a release path");
    assert.equal((await lstat(plistOf(f))).mode & 0o777, 0o600);
    assert.ok(f.calls.indexOf(`setenv ${PATH_KEY} ${wrapper}`) >= 0, "the session is still set directly");
    assert.ok(f.calls.includes(`enable ${target()}`) && f.calls.includes(`bootstrap gui/${process.getuid!()} ${plistOf(f)}`), "and the agent is enabled and bootstrapped");
    assert.deepEqual((await readdir(join(f.home, "Library/LaunchAgents"))).filter(name => name.includes(".tmp")), [], "no temporary file is left");
  });
});

test("the unified service's desktop component and a pending login plan write the agent as well", mac, async () => {
  for (const mode of ["restore-only", "unified plan", "pending login"] as const) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      const plan = { version: 1, config: f.config, components: [{ id: "inference", kind: "inference", command: f.gateway, args: [], log: join(f.state, "inference.log") }] };
      if (mode === "unified plan") await writePrivateJson(join(f.state, "service-plan.json"), plan);
      if (mode === "pending login") await writePrivateJson(join(f.state, "service-login-pending.json"), {
        version: 1, phase: "ready", config: f.config, plan, primaryLabel: "com.edihasaj.subscription-gateway", primaryPlistDigest: "a".repeat(64), removedLabels: [],
        backup: join(f.state, "service-backups", "bundle"), sources: [{ label: "com.edihasaj.subscription-gateway", digest: "b".repeat(64), mode: 0o600 }] });
      const result = await macDesktop("register", f.config, f.app, mode === "restore-only", f.exec);
      const { wrapper } = JSON.parse(await readFile(f.receipt, "utf8")) as { wrapper: string };
      assert.equal(result.envAgent, true, mode);
      assert.equal(await read(plistOf(f)), envAgentPlist(wrapper), mode);
      assert.equal(await read(join(f.home, "Library/LaunchAgents/com.edihasaj.subscription-gateway.desktop.plist")), undefined, mode + ": the standalone desktop login agent is not written on the service path");
    });
  }
});

test("registering again changes nothing, and a new wrapper replaces the agent after booting the old one out", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await macDesktop("register", f.config, f.app, false, f.exec);
    const first = await lstat(plistOf(f)); const before = f.calls.length;
    await macDesktop("register", f.config, f.app, false, f.exec);
    const second = await lstat(plistOf(f));
    assert.equal(second.ino, first.ino, "an unchanged agent is not rewritten");
    assert.equal(f.calls.slice(before).some(call => call === `bootout ${target()}`), false, "and not booted out");

    // The receipt names an older wrapper and the agent names it too, so the current wrapper is a change.
    const older = join(f.state, "desktop-wrapper-89fafe006c5dc3e4");
    await writeFile(older, "#!/bin/sh\nexit 0\n"); await chmod(older, 0o700);
    await writeFile(plistOf(f), envAgentPlist(older)); f.values.set(PATH_KEY, older);
    await writePrivateJson(f.receipt, { wrapper: older, registeredAt: new Date().toISOString() });
    const mark = f.calls.length;
    await macDesktop("register", f.config, f.app, false, f.exec);
    const { wrapper } = JSON.parse(await readFile(f.receipt, "utf8")) as { wrapper: string };
    assert.notEqual(wrapper, older);
    assert.equal(await read(plistOf(f)), envAgentPlist(wrapper), "the agent follows the registration");
    const calls = f.calls.slice(mark);
    assert.ok(calls.indexOf(`bootout ${target()}`) >= 0 && calls.indexOf(`bootout ${target()}`) < calls.findIndex(call => call.startsWith("bootstrap")), "boot out, then bootstrap the new one");
  });
});

test("an agent plist that is not ours is refused before any session change", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await mkdir(join(f.home, "Library/LaunchAgents"), { recursive: true });
    await writeFile(plistOf(f), "<plist>someone else's job</plist>\n");
    await assert.rejects(macDesktop("register", f.config, f.app, false, f.exec), /unmanaged desktop environment LaunchAgent/);
    assert.deepEqual(f.calls, [], "nothing was asked of launchctl");
    await assert.rejects(planDesktopUnregister(f.config, f.exec), /unmanaged desktop environment LaunchAgent/);
    await assert.rejects(macDesktop("unregister", f.config, f.app, false, f.exec), /unmanaged desktop environment LaunchAgent/);
    assert.equal((f.calls as string[]).some(call => !call.startsWith("getenv")), false, "unregister changed nothing either");
    assert.equal(await read(plistOf(f)), "<plist>someone else's job</plist>\n");
  });
});

test("the agent never names a release path or any wrapper outside the state directory", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    for (const bad of ["/Users/me/.local/share/subscription-gateway/releases/0.4.4/package/dist/cli.js", join(f.root, "other", "desktop-wrapper-0123456789abcdef"), join(f.state, "desktop-wrapper-short")]) {
      await assert.rejects(writeEnvAgent(f.state, bad, undefined, f.exec), /only names a wrapper in the gateway state directory/);
    }
    assert.equal(await read(plistOf(f)), undefined); assert.deepEqual(f.calls, []);
  });
});

test("unregister boots the agent out and moves it to the Trash, before it clears the session", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await macDesktop("register", f.config, f.app, false, f.exec);
    const plan = await planDesktopUnregister(f.config, f.exec);
    assert.equal(plan.envAgent, "managed");
    const mark = f.calls.length;
    await macDesktop("unregister", f.config, f.app, false, f.exec);
    const calls = f.calls.slice(mark);
    assert.ok(calls.indexOf(`bootout ${target()}`) >= 0 && calls.indexOf(`bootout ${target()}`) < calls.indexOf(`unsetenv ${PATH_KEY}`), "the agent cannot set the path again after it is cleared");
    assert.equal(await read(plistOf(f)), undefined, "out of LaunchAgents");
    const trashed = (await readdir(join(f.home, ".Trash"))).filter(name => name.startsWith(envAgentLabel + "."));
    assert.equal(trashed.length, 1, "in the Trash");
    assert.equal((await planDesktopUnregister(f.config, f.exec)).envAgent, "absent");
  });
});

test("unregister of a session that never had the agent asks launchctl nothing about it", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await macDesktop("unregister", f.config, f.app, false, f.exec);
    assert.equal(f.calls.some(call => call.includes(envAgentLabel)), false);
  });
});

test("gateway uninstall removes the agent through the desktop unregister step", mac, async () => {
  const f = await fixture();
  const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  await inDesktopHome(f, async () => {
    const command = join(f.home, "bin", "gateway"); await mkdir(join(f.home, "bin"), { recursive: true });
    await writeFile(command, "#!/bin/sh\n# Managed by subscription-gateway installer\n");
    await mkdir(join(f.home, "share", "subscription-gateway"), { recursive: true });
    await writeFile(join(f.home, "share", "subscription-gateway", ".gateway-installation"), "subscription-gateway\n");
    process.env.GATEWAY_COMMAND = command;
    await macDesktop("register", f.config, f.app, false, f.exec);
    assert.ok(await read(plistOf(f)), "registered with an agent");
    const none = async () => ({});
    const deps: UninstallDeps = { macService: none, macNative: none, macSsh: none, macTunnel: none,
      macDesktop: (action, config) => macDesktop(action, config, undefined, false, f.exec),
      planDesktopUnregister: (config, _exec, options) => planDesktopUnregister(config, f.exec, options) };
    try { await uninstallGateway(f.config, deps); } finally { Object.defineProperty(process, "platform", savedPlatform); }
    assert.equal(await read(plistOf(f)), undefined, "the agent is gone from LaunchAgents");
    assert.ok(f.calls.includes(`bootout ${target()}`));
    assert.equal((await readdir(join(f.home, ".Trash"))).some(name => name.startsWith(envAgentLabel + ".")), true, "and in the Trash");
  });
});

/** A `launchctl print gui/<uid>` answer: a header, the environment block, and other blocks that must not be read. */
const guiPrint = (environment: string[]) => ["gui/501 = {", "\ttype = login", "\tenvironment = {", ...environment.map(line => `\t\t${line}`), "\t}",
  "\tdefault environment = {", "\t\tCODEX_CLI_PATH => /wrong/default", "\t}", "\tservices = {", "\t\tCODEX_CLI_PATH => /wrong/service", "\t}", "}"].join("\n");
/** Session seam: `print gui/<uid>` answers `printed` (or fails), while `getenv` answers what an SSH session would see. */
const sessionExec = (f: Fixture, printed: string | undefined, getenvValue = ""): LaunchctlExec => async (file, args) => {
  f.calls.push(args.join(" "));
  if (args[0] === "print" && args[1] === `gui/${process.getuid!()}`) { if (printed === undefined) throw new Error("print failed"); return { stdout: printed }; }
  if (args[0] === "getenv") return { stdout: args[1] === PATH_KEY ? getenvValue : "" };
  return { stdout: "" };
};

test("status reads CODEX_CLI_PATH from the GUI domain even when getenv, over SSH, sees nothing", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const { wrapper } = await prepareDesktop(f.config, f.app);
    await writePrivateJson(f.receipt, { wrapper, registeredAt: new Date().toISOString() });
    await writeFile(plistOf(f), envAgentPlist(wrapper));
    const secret = "TOKEN_SHOULD_NEVER_APPEAR_7731";
    const status = await macDesktop("status", f.config, f.app, false, sessionExec(f, guiPrint([`OTHER_KEY => ${secret}`, `${PATH_KEY} => ${wrapper}`, "ANOTHER => x"]), ""));
    assert.equal(status.activeForFutureLaunches, true);
    assert.equal(status.envAgent, true);
    assert.equal(JSON.stringify(status).includes(secret), false, "no other value is parsed or reported");
    assert.equal(f.calls.includes(`getenv ${PATH_KEY}`), false, "getenv is not asked while print answers");
    assert.equal(f.calls.some(call => !call.startsWith("print ") && !call.startsWith("getenv ")), false, "status writes nothing");
  });
});

test("status falls back to getenv only when print fails, and reads an absent key or block as unset", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const { wrapper } = await prepareDesktop(f.config, f.app);
    await writePrivateJson(f.receipt, { wrapper, registeredAt: new Date().toISOString() });
    const viaGetenv = await macDesktop("status", f.config, f.app, false, sessionExec(f, undefined, wrapper));
    assert.equal(viaGetenv.activeForFutureLaunches, true, "the fallback reads getenv");
    assert.ok(f.calls.includes(`getenv ${PATH_KEY}`));
    for (const printed of [guiPrint(["OTHER => 1"]), "gui/501 = {\n\ttype = login\n}", ""]) {
      const unset = await macDesktop("status", f.config, f.app, false, sessionExec(f, printed, wrapper));
      assert.equal(unset.activeForFutureLaunches, false, "a successful print is trusted over getenv; the key is absent");
    }
  });
});

test("status reports envAgent false for a missing agent and for one naming another wrapper", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const { wrapper } = await prepareDesktop(f.config, f.app);
    await writePrivateJson(f.receipt, { wrapper, registeredAt: new Date().toISOString() });
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).envAgent, false, "no plist");
    await writeFile(plistOf(f), envAgentPlist(join(f.state, "desktop-wrapper-89fafe006c5dc3e4")));
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).envAgent, false, "names an older wrapper");
    await writeFile(plistOf(f), envAgentPlist(wrapper));
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).envAgent, true);
    await writePrivateJson(f.receipt, {});
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).envAgent, false, "no registered wrapper");
  });
});

test("the GUI environment parser reads one key from the first environment block only", async () => {
  const exec: LaunchctlExec = async () => ({ stdout: guiPrint([`${PATH_KEY} => /a b/c`]) });
  assert.equal(await readGuiCliPath(exec, async () => assert.fail("no fallback")), "/a b/c");
  const crlf: LaunchctlExec = async () => ({ stdout: "x = {\r\n\tenvironment = {\r\n\t\tCODEX_CLI_PATH => /p\r\n\t}\r\n}" });
  assert.equal(await readGuiCliPath(crlf, async () => assert.fail("no fallback")), "/p");
  const broken: LaunchctlExec = async () => { throw new Error("nope"); };
  assert.equal(await readGuiCliPath(broken, async () => "from getenv"), "from getenv");
  await assert.rejects(readGuiCliPath(broken, async () => { throw new Error("getenv failed"); }), /getenv failed/);
});

// Every place that enumerates or migrates our LaunchAgent labels, against the new label.
test("service consolidation does not take the environment agent for a component", () => {
  const service = "com.edihasaj.subscription-gateway";
  assert.equal(kindFor(envAgentLabel), undefined);
  for (const label of [service + ".desktop-env.x", service + ".desktop-env2", service + ".tunnel.desktop-env"]) assert.equal(kindFor(label) === "tunnel", label.includes(".tunnel."));
  assert.equal(kindFor(service + ".desktop"), "desktop");
});

test("collecting a service plan skips the environment agent's plist", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const directory = join(f.home, "Library/LaunchAgents");
    await writeFile(join(directory, envAgentLabel + ".plist"), envAgentPlist(join(f.state, "desktop-wrapper-0123456789abcdef")));
    // Alone, it yields no component at all: an agent taken for one would be parsed and fail some other way.
    await assert.rejects(collectServicePlan(f.config, directory), /Invalid gateway service plan/);
  });
});

test("a service plan cannot carry the environment agent as a component", () => {
  assert.throws(() => validateServicePlan({ version: 1, config: "/c.json", components: [{ id: "desktop-env", kind: "desktop-env", command: "/bin/launchctl", args: [], log: "/l.log" }] }), /Invalid or duplicate service component/);
});

test("versions and health do not classify the agent's launchctl process as a gateway role", () => {
  const scope = { roots: ["/h/.local/share/subscription-gateway"], installed: "0.4.5" };
  assert.equal(classifyCommand("/bin/launchctl setenv CODEX_CLI_PATH /h/.local/state/gw/desktop-wrapper-0123456789abcdef", scope), undefined);
  assert.equal(classifyCommand("/bin/launchctl setenv CODEX_CLI_PATH /h/.local/share/subscription-gateway/releases/0.4.4/package/dist/cli.js", scope), undefined, "even a release path as an argument is not an entry point");
});
