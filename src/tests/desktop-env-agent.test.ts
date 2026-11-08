import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { macDesktop, planDesktopUnregister, type LaunchctlExec } from "../mac-desktop.js";
import { envAgentLabel, envAgentPlist, envAgentScript, envAgentScriptPath, readGuiDesktopEnv, writeEnvAgent } from "../desktop-env-agent.js";
import { prepareDesktop } from "../desktop-launch.js";
import { writePrivateJson } from "../config.js";
import { uninstallGateway, type UninstallDeps } from "../uninstall.js";
import { kindFor, collectServicePlan } from "../mac-consolidate.js";
import { validateServicePlan } from "../service-plan.js";
import { classifyCommand } from "../versions.js";
import { readTelemetry } from "../telemetry.js";
import { PATH_KEY, FORCE, inDesktopHome, desktopFixture, type DesktopFixture as Fixture } from "./desktop-fixture.js";

const mac = { skip: process.platform !== "darwin" };
const fixture = () => desktopFixture("env-agent");
const plistOf = (f: Fixture) => join(f.home, "Library/LaunchAgents", envAgentLabel + ".plist");
const scriptOf = (f: Fixture) => envAgentScriptPath(f.state);
/** An agent as registration leaves it: the script for `wrapper`, and the plist that runs the script. */
const seedAgent = async (f: Fixture, wrapper: string) => { await writeFile(scriptOf(f), envAgentScript(wrapper), { mode: 0o700 }); await writeFile(plistOf(f), envAgentPlist(scriptOf(f))); };
const target = () => `gui/${process.getuid!()}/${envAgentLabel}`;
const read = (path: string) => readFile(path, "utf8").then(text => text, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });

test("the agent runs one private script, not launchctl, so macOS lists it as harness-gateway-login-env", () => {
  const wrapper = "/state/desktop-wrapper-0123456789abcdef"; const script = "/state/harness-gateway-login-env";
  const text = envAgentPlist(script);
  assert.match(text, /<!-- Managed by subscription-gateway desktop-env -->/);
  assert.ok(text.includes(`<key>Label</key><string>${envAgentLabel}</string>`));
  assert.ok(text.includes(`<key>ProgramArguments</key><array><string>${script}</string></array>`), "the script is the only program argument");
  assert.equal(text.includes("launchctl"), false, "the first argument is never launchctl, which macOS would show instead");
  assert.ok(text.includes("<key>RunAtLoad</key><true/>"));
  assert.ok(text.includes("<key>LimitLoadToSessionType</key><string>Aqua</string>"));
  for (const forbidden of ["KeepAlive", "EnvironmentVariables", "node", "WorkingDirectory", "StandardOutPath"]) assert.equal(text.includes(forbidden), false, forbidden);
  assert.ok(envAgentPlist("/a&b/<x>").includes("<string>/a&amp;b/&lt;x&gt;</string>"), "the path is escaped");
  assert.equal(envAgentScriptPath("/state"), script);
  assert.equal(envAgentScript(wrapper, "/prefix/share/subscription-gateway/current/package/dist/cli.js", { command: "/gateway", args: [] }),
    `#!/bin/sh\n# Managed by subscription-gateway desktop-env\n[ -e '/state/api-mode.json' ] && exit 0\n[ -x '${wrapper}' ] && [ -f '/prefix/share/subscription-gateway/current/package/dist/cli.js' ] || exit 0\nexec '/gateway' 'desktop-preset' '--state' '/state'\n`);
});

/** The script with its preset helper swapped for a print, so a test can run it without reaching the login session. */
const withoutPreset = (script: string, wrapper: string) => script.replace(/^exec .*$/m, `exec printf %s '${wrapper.replaceAll("'", "'\\''")}'`);

test("the script sets nothing once the wrapper or the gateway release is gone", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const wrapper = join(f.state, "desktop-wrapper-0123456789abcdef"); const cli = join(f.root, "share/current/package/dist/cli.js");
    const file = join(f.root, "login-env"); await writeFile(file, withoutPreset(envAgentScript(wrapper, cli), wrapper), { mode: 0o700 });
    const sh = () => promisify(execFile)("/bin/sh", [file]).then(result => result.stdout, (error: { code: number }) => `exit ${error.code}`);
    assert.equal(await sh(), "", "neither the wrapper nor the release exists: exit 0, nothing set");
    await writeFile(wrapper, "#!/bin/sh\n", { mode: 0o700 });
    assert.equal(await sh(), "", "the wrapper alone is not enough (the gateway was uninstalled or rolled back)");
    await mkdir(join(cli, ".."), { recursive: true }); await writeFile(cli, "");
    assert.equal(await sh(), wrapper, "both exist: the variable is set");
    await chmod(wrapper, 0o600);
    assert.equal(await sh(), "", "a wrapper that cannot run sets nothing");
    await chmod(wrapper, 0o700); await rm(cli);
    assert.equal(await sh(), "", "and so does a removed release");
  });
});

test("the registered script checks the installed release's CLI", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await macDesktop("register", f.config, f.app, false, f.exec);
    const text = (await read(scriptOf(f)))!;
    assert.ok(text.includes(`[ -f '${join(f.root, "../share/subscription-gateway/current/package/dist/cli.js")}' ]`), text);
    assert.match(text, /\|\| exit 0\nexec .*'desktop-preset' '--state' /);
  });
});

test("the script quotes the wrapper path for the shell, whatever it holds", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    for (const wrapper of ["/a b/it's/$HOME/`id`/\"x\"/desktop-wrapper-0123456789abcdef", "/line\nbreak/desktop-wrapper-0123456789abcdef"].map(name => f.root + name)) {
      const file = join(f.root, "login-env"); await writeFile(file, withoutPreset(envAgentScript(wrapper, join(f.root, "cli.js")), wrapper), { mode: 0o700 });
      await mkdir(join(wrapper, ".."), { recursive: true }); await writeFile(wrapper, "#!/bin/sh\n", { mode: 0o700 }); await writeFile(join(f.root, "cli.js"), "");
      const { stdout } = await promisify(execFile)("/bin/sh", [file]);
      assert.equal(stdout, wrapper, "the shell reads back exactly the wrapper");
    }
  });
});

test("the generated plist is valid", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const file = join(f.root, "agent.plist"); await writeFile(file, envAgentPlist(scriptOf(f)));
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
    assert.equal(await read(plistOf(f)), envAgentPlist(scriptOf(f)));
    assert.equal(await read(scriptOf(f)), envAgentScript(wrapper), "the script sets the registered wrapper");
    assert.ok(wrapper.startsWith(f.state + "/desktop-wrapper-"), "the stable registered wrapper, never a release path");
    assert.equal((await lstat(plistOf(f))).mode & 0o777, 0o600);
    assert.equal((await lstat(scriptOf(f))).mode & 0o777, 0o700, "the script is private and executable");
    assert.deepEqual((await readdir(f.state)).filter(name => name.includes(".tmp")), [], "no temporary script is left");
    const program = JSON.parse((await promisify(execFile)("/usr/bin/plutil", ["-extract", "ProgramArguments", "json", "-o", "-", plistOf(f)])).stdout) as string[];
    assert.deepEqual(program, [scriptOf(f)], "ProgramArguments is only the script");
    assert.ok(f.calls.indexOf(`setenv ${PATH_KEY} ${wrapper}`) >= 0, "the session is still set directly");
    assert.ok(f.calls.includes(`enable ${target()}`) && f.calls.includes(`bootstrap gui/${process.getuid!()} ${plistOf(f)}`), "and the agent is enabled and bootstrapped");
    assert.deepEqual((await readdir(join(f.home, "Library/LaunchAgents"))).filter(name => name.includes(".tmp")), [], "no temporary file is left");
  });
});

test("the unified service's desktop component and a pending login plan write no agent: the daemon presets the variable", mac, async () => {
  for (const mode of ["restore-only", "unified plan", "pending login"] as const) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      await seedServicePath(f, mode);
      const result = await macDesktop("register", f.config, f.app, mode === "restore-only", f.exec);
      const { wrapper } = JSON.parse(await readFile(f.receipt, "utf8")) as { wrapper: string };
      assert.equal(result.envAgent, false, mode); assert.equal(result.loginEnv, "service", mode);
      assert.equal(await read(plistOf(f)), undefined, mode + ": no second background item");
      assert.equal(await read(scriptOf(f)), undefined, mode);
      assert.equal(f.calls.some(call => call.includes(envAgentLabel)), false, mode + ": launchd is not asked about the agent");
      assert.equal(f.values.get(PATH_KEY), wrapper, mode + ": the session is still set");
      assert.equal(await read(join(f.home, "Library/LaunchAgents/com.edihasaj.subscription-gateway.desktop.plist")), undefined, mode + ": the standalone desktop login agent is not written on the service path");
    });
  }
});

test("registering again changes nothing, and a new wrapper replaces only the script the agent runs", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await macDesktop("register", f.config, f.app, false, f.exec);
    const first = await lstat(plistOf(f)); const firstScript = await lstat(scriptOf(f)); const before = f.calls.length;
    await macDesktop("register", f.config, f.app, false, f.exec);
    const second = await lstat(plistOf(f));
    assert.equal(second.ino, first.ino, "an unchanged agent is not rewritten");
    assert.equal((await lstat(scriptOf(f))).ino, firstScript.ino, "nor is its script");
    assert.equal(f.calls.slice(before).some(call => call === `bootout ${target()}`), false, "and not booted out");

    // The receipt names an older wrapper and the agent names it too, so the current wrapper is a change.
    const older = join(f.state, "desktop-wrapper-89fafe006c5dc3e4");
    await writeFile(older, "#!/bin/sh\nexit 0\n"); await chmod(older, 0o700);
    await seedAgent(f, older); f.values.set(PATH_KEY, older);
    await writePrivateJson(f.receipt, { wrapper: older, registeredAt: new Date().toISOString() });
    const mark = f.calls.length;
    await macDesktop("register", f.config, f.app, false, f.exec);
    const { wrapper } = JSON.parse(await readFile(f.receipt, "utf8")) as { wrapper: string };
    assert.notEqual(wrapper, older);
    assert.equal(await read(scriptOf(f)), envAgentScript(wrapper), "the script follows the registration");
    assert.equal(await read(plistOf(f)), envAgentPlist(scriptOf(f)), "and the plist keeps naming the script");
    const calls = f.calls.slice(mark);
    assert.equal(calls.includes(`bootout ${target()}`), false, "the plist did not change, so the loaded agent is not booted out");
    assert.equal((await lstat(scriptOf(f))).mode & 0o777, 0o700);
    assert.deepEqual((await readdir(f.state)).filter(name => name.includes(".tmp")), [], "the replacement was atomic");
  });
});

test("an agent written by 0.4.5 (launchctl as the program) is replaced by the script form", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const { wrapper } = await prepareDesktop(f.config, f.app);
    const legacy = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Managed by subscription-gateway desktop-env -->\n<plist version="1.0"><dict><key>Label</key><string>${envAgentLabel}</string><key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>CODEX_CLI_PATH</string><string>${wrapper}</string></array></dict></plist>\n`;
    await writeFile(plistOf(f), legacy);
    await macDesktop("register", f.config, f.app, false, f.exec);
    const registered = JSON.parse(await readFile(f.receipt, "utf8")) as { wrapper: string };
    assert.equal(await read(plistOf(f)), envAgentPlist(scriptOf(f)));
    assert.equal(await read(scriptOf(f)), envAgentScript(registered.wrapper));
    assert.ok(f.calls.indexOf(`bootout ${target()}`) >= 0, "the old agent is booted out before the new one is bootstrapped");
    assert.ok(f.calls.indexOf(`bootout ${target()}`) < f.calls.findIndex(call => call.startsWith("bootstrap")));
  });
});

test("a script without the gateway's marker is refused and left alone", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await writeFile(scriptOf(f), "#!/bin/sh\necho someone else\n", { mode: 0o700 });
    await assert.rejects(macDesktop("register", f.config, f.app, false, f.exec), /unmanaged desktop environment script/);
    assert.equal(await read(scriptOf(f)), "#!/bin/sh\necho someone else\n");
    assert.equal(await read(plistOf(f)), undefined, "no plist names a script that is not ours");
    const service = await macDesktop("register", f.config, f.app, true, f.exec);
    assert.equal(service.envAgent, false, "the service path writes no agent, so it has nothing to refuse");
    assert.equal(await read(scriptOf(f)), "#!/bin/sh\necho someone else\n", "and leaves the script alone");
    assert.deepEqual((await failureEvents(f)).events, []);
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
    assert.equal(await read(scriptOf(f)), undefined, "and the script is out of the state directory");
    const trashed = (await readdir(join(f.home, ".Trash"))).filter(name => name.startsWith(envAgentLabel + "."));
    assert.equal(trashed.length, 1, "in the Trash");
    assert.equal((await readdir(join(f.home, ".Trash"))).filter(name => name.startsWith("harness-gateway-login-env.")).length, 1, "with its script");
    assert.equal((await planDesktopUnregister(f.config, f.exec)).envAgent, "absent");
  });
});

test("unregister leaves a script that is not the gateway's where it is", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await macDesktop("register", f.config, f.app, false, f.exec);
    await writeFile(scriptOf(f), "#!/bin/sh\necho someone else\n", { mode: 0o700 });
    await macDesktop("unregister", f.config, f.app, false, f.exec);
    assert.equal(await read(plistOf(f)), undefined, "the agent plist is removed");
    assert.equal(await read(scriptOf(f)), "#!/bin/sh\necho someone else\n", "the foreign script is untouched");
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
    const deps: UninstallDeps = { macService: none, macNative: none, macSsh: none, macTunnel: none, withdrawNativeProvider: async () => "absent",
      macDesktop: (action, config) => macDesktop(action, config, undefined, false, f.exec),
      planDesktopUnregister: (config, _exec, options) => planDesktopUnregister(config, f.exec, options) };
    try { await uninstallGateway(f.config, deps); } finally { Object.defineProperty(process, "platform", savedPlatform); }
    assert.equal(await read(plistOf(f)), undefined, "the agent is gone from LaunchAgents");
    assert.equal(await read(scriptOf(f)), undefined, "and so is its script");
    assert.ok(f.calls.includes(`bootout ${target()}`));
    assert.equal((await readdir(join(f.home, ".Trash"))).some(name => name.startsWith(envAgentLabel + ".")), true, "and in the Trash");
  });
});

/** A `launchctl print gui/<uid>` answer: a header, the environment block, and other blocks that must not be read. */
const guiPrint = (environment: string[]) => ["gui/501 = {", "\ttype = login", "\tenvironment = {", ...environment.map(line => `\t\t${line}`), "\t}",
  "\tdefault environment = {", "\t\tCODEX_CLI_PATH => /wrong/default", "\t}", "\tservices = {", "\t\tCODEX_CLI_PATH => /wrong/service", "\t}", "}"].join("\n");
/** Session seam: `print gui/<uid>` answers `printed` (or fails), while `getenv` answers what an SSH session would see. */
const sessionExec = (f: Fixture, printed: string | undefined, getenvValue = "", forceGetenv = ""): LaunchctlExec => async (file, args) => {
  f.calls.push(args.join(" "));
  if (args[0] === "print" && args[1] === `gui/${process.getuid!()}`) { if (printed === undefined) throw new Error("print failed"); return { stdout: printed }; }
  if (args[0] === "getenv") return { stdout: args[1] === PATH_KEY ? getenvValue : forceGetenv };
  return { stdout: "" };
};

test("status reads CODEX_CLI_PATH from the GUI domain even when getenv, over SSH, sees nothing", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const { wrapper } = await prepareDesktop(f.config, f.app);
    await writePrivateJson(f.receipt, { wrapper, registeredAt: new Date().toISOString() });
    await seedAgent(f, wrapper);
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
    await seedAgent(f, join(f.state, "desktop-wrapper-89fafe006c5dc3e4"));
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).envAgent, false, "its script sets an older wrapper");
    await seedAgent(f, wrapper);
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).envAgent, true);
    await rm(scriptOf(f));
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).envAgent, false, "the plist names a script that is gone");
    await seedAgent(f, wrapper);
    await writePrivateJson(f.receipt, {});
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).envAgent, false, "no registered wrapper");
  });
});

test("status reads FORCE_CLI presence from the GUI domain too, keeping no value", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const { wrapper } = await prepareDesktop(f.config, f.app);
    await writePrivateJson(f.receipt, { wrapper, registeredAt: new Date().toISOString() });
    const shapes: Array<[string[], boolean, boolean]> = [
      [[`${PATH_KEY} => ${wrapper}`, `${FORCE} => 1`], true, true],
      [[`${PATH_KEY} => ${wrapper}`, `${FORCE} => secret-looking-value`], true, false],
      [[`${PATH_KEY} => ${wrapper}`, `${FORCE} => `], false, false],
      [[`${PATH_KEY} => ${wrapper}`], false, false],
    ];
    for (const [environment, set, legacy] of shapes) {
      f.calls.length = 0;
      // getenv, as an SSH session would see it, claims the opposite so only the GUI domain can be the source.
      const status = await macDesktop("status", f.config, f.app, false, sessionExec(f, guiPrint(environment), "", set ? "" : "1"));
      assert.equal(status.forceCliSet, set, environment.join(" | "));
      assert.equal(status.legacyForceCli, legacy, environment.join(" | "));
      assert.equal(JSON.stringify(status).includes("secret-looking-value"), false, "the value is never reported");
      assert.equal(f.calls.some(call => call.startsWith("getenv")), false, "getenv is not asked while print answers");
    }
    f.calls.length = 0;
    const fallback = await macDesktop("status", f.config, f.app, false, sessionExec(f, undefined, wrapper, "1"));
    assert.deepEqual([fallback.forceCliSet, fallback.legacyForceCli, fallback.activeForFutureLaunches], [true, true, true], "a failing print falls back to getenv for both");
    assert.deepEqual(f.calls.filter(call => call.startsWith("getenv")), [`getenv ${PATH_KEY}`, `getenv ${FORCE}`]);
  });
});

test("the real shape of launchctl print gui/501 on a Mac whose wrapper path holds spaces is read as it is", async () => {
  const wrapper = "/Users/dev/Library/Application Support/Subscription Gateway/state/desktop-wrapper-e9f368da4bc321f7";
  const never = async (): Promise<string> => assert.fail("print answered, so getenv is not asked");
  const print = (environment: string[]) => ["gui/501 = {", "\ttype = login", "\tenvironment = {", ...environment, "\t}", "\tdefault environment = {", "\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin", "\t}", "}"].join("\n");
  const studio = [`\t\t${PATH_KEY} => ${wrapper}`, "\t\tSSH_AUTH_SOCK => /var/run/com.apple.launchd.qSydomYmzg/Listeners"];
  const read = (lines: string[]) => readGuiDesktopEnv(async () => ({ stdout: print(lines) }), never);
  assert.deepEqual(await read(studio), { cliPath: wrapper, forceCliSet: false, forceCli1: false }, "the path with spaces, and no FORCE_CLI");
  assert.deepEqual(await read([...studio, `\t\t${FORCE} => 1`]), { cliPath: wrapper, forceCliSet: true, forceCli1: true });
  assert.deepEqual(await read([...studio, `\t\t${FORCE} => anything`]), { cliPath: wrapper, forceCliSet: true, forceCli1: false });
  assert.deepEqual(await read([studio[1]!]), { cliPath: "", forceCliSet: false, forceCli1: false }, "an environment without the key reads as unset");
});

test("the GUI environment parser reads two keys from the first environment block only", async () => {
  const never = async (): Promise<string> => assert.fail("no fallback");
  const exec: LaunchctlExec = async () => ({ stdout: guiPrint([`${PATH_KEY} => /a b/c`, `${FORCE} => 1`, "OTHER => z"]) });
  assert.deepEqual(await readGuiDesktopEnv(exec, never), { cliPath: "/a b/c", forceCliSet: true, forceCli1: true });
  const crlf: LaunchctlExec = async () => ({ stdout: "x = {\r\n\tenvironment = {\r\n\t\tCODEX_CLI_PATH => /p\r\n\t}\r\n}" });
  assert.deepEqual(await readGuiDesktopEnv(crlf, never), { cliPath: "/p", forceCliSet: false, forceCli1: false });
  const broken: LaunchctlExec = async () => { throw new Error("nope"); };
  assert.deepEqual(await readGuiDesktopEnv(broken, async name => name === PATH_KEY ? "from getenv" : "2"), { cliPath: "from getenv", forceCliSet: true, forceCli1: false });
  await assert.rejects(readGuiDesktopEnv(broken, async () => { throw new Error("getenv failed"); }), /getenv failed/);
});

// The agent is a safeguard where the unified service sets the variable: its failure is reported, never thrown.
const secretText = "SECRET_ERROR_TEXT /Users/someone/private/path";
const servicePaths = ["restore-only", "unified plan", "pending login"] as const;
async function seedServicePath(f: Fixture, mode: (typeof servicePaths)[number]) {
  const plan = { version: 1, config: f.config, components: [{ id: "inference", kind: "inference", command: f.gateway, args: [], log: join(f.state, "inference.log") }] };
  if (mode === "unified plan") await writePrivateJson(join(f.state, "service-plan.json"), plan);
  if (mode === "pending login") await writePrivateJson(join(f.state, "service-login-pending.json"), {
    version: 1, phase: "ready", config: f.config, plan, primaryLabel: "com.edihasaj.subscription-gateway", primaryPlistDigest: "a".repeat(64), removedLabels: [],
    backup: join(f.state, "service-backups", "bundle"), sources: [{ label: "com.edihasaj.subscription-gateway", digest: "b".repeat(64), mode: 0o600 }] });
}
/** The telemetry the failure left in the state directory, as text, and its parsed events. */
async function failureEvents(f: Fixture) {
  const events = (await readTelemetry(f.state, 0)).filter(event => event.event === "desktop_env_agent_failed");
  const raw = (await Promise.all((await readdir(join(f.state, "telemetry")).catch(() => [] as string[])).map(name => readFile(join(f.state, "telemetry", name), "utf8")))).join("");
  return { events, raw };
}

test("a failing removal of a leftover agent does not fail the service paths; it is reported with a fixed reason", mac, async () => {
  for (const mode of servicePaths) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      await seedServicePath(f, mode);
      const { wrapper } = await prepareDesktop(f.config, f.app); await seedAgent(f, wrapper);
      // The Trash cannot be created where a file stands, so moving the agent out fails.
      await writeFile(join(f.home, ".Trash"), secretText);
      const result = await macDesktop("register", f.config, f.app, mode === "restore-only", f.exec);
      assert.deepEqual([result.registered, result.activeForFutureLaunches, result.envAgent, result.nativeConfigUntouched], [true, true, false, true], mode);
      assert.equal(f.values.get(PATH_KEY), wrapper, mode + ": the session was still set");
      const { events, raw } = await failureEvents(f);
      assert.equal(events.length, 1, mode); assert.equal(events[0]!.reason, "other", mode);
      assert.equal(raw.includes("SECRET_ERROR_TEXT") || raw.includes("someone") || raw.includes(f.root), false, mode + ": no error text or path in telemetry");
    });
  }
});

test("an unmanaged agent plist does not fail the service paths either, and is left alone", mac, async () => {
  for (const mode of servicePaths) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      await seedServicePath(f, mode);
      await writeFile(plistOf(f), "<plist>someone else's job</plist>\n");
      const result = await macDesktop("register", f.config, f.app, mode === "restore-only", f.exec);
      assert.equal(result.envAgent, false, mode); assert.equal(result.registered, true, mode);
      assert.ok(f.calls.some(call => call.startsWith(`setenv ${PATH_KEY} `)), mode + ": the session was still set");
      assert.equal(f.calls.some(call => call.includes(envAgentLabel)), false, mode + ": the unmanaged job is not touched");
      assert.equal(await read(plistOf(f)), "<plist>someone else's job</plist>\n");
      const { events } = await failureEvents(f);
      assert.deepEqual(events.map(event => event.reason), ["unmanaged"], mode);
    });
  }
});

test("a clean service run writes nothing and reports nothing", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const agents = join(f.home, "Library/LaunchAgents");
    await chmod(agents, 0o500);
    try {
      const result = await macDesktop("register", f.config, f.app, true, f.exec);
      assert.deepEqual([result.registered, result.envAgent], [true, false], "no agent to write, so a read-only LaunchAgents folder cannot fail it");
    } finally { await chmod(agents, 0o700); }
    assert.equal((await failureEvents(f)).events.length, 0);
  });
});

test("the interactive register still fails loudly when the agent cannot be written", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const failing: LaunchctlExec = async (file, args) => { if (args[0] === "bootstrap") throw new Error("bootstrap boom"); return f.exec(file, args); };
    await assert.rejects(macDesktop("register", f.config, f.app, false, failing), /bootstrap boom/);
    await rm(plistOf(f), { force: true });
    await writeFile(plistOf(f), "<plist>someone else's job</plist>\n");
    await assert.rejects(macDesktop("register", f.config, f.app, false, f.exec), /unmanaged desktop environment LaunchAgent/);
    await assert.rejects(readdir(join(f.state, "telemetry")), { code: "ENOENT" }, "the interactive command reports no telemetry event");
  });
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
    await writeFile(join(directory, envAgentLabel + ".plist"), envAgentPlist(scriptOf(f)));
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
