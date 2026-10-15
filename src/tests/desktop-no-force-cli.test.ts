import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { launchctlRunner, macDesktop, type LaunchctlExec } from "../mac-desktop.js";
import { desktopEnvironment, launchDesktop, prepareDesktop } from "../desktop-launch.js";
import { writePrivateJson } from "../config.js";

const mac = { skip: process.platform !== "darwin" };
const FORCE = "CODEX_APP_SERVER_FORCE_CLI"; const PATH_KEY = "CODEX_CLI_PATH";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-no-force-cli-"));
  const home = join(root, "home"); const app = join(root, "ChatGPT.app"); const state = join(root, "state");
  const codex = join(app, "Contents/Resources/codex-cli/bin/codex");
  await mkdir(join(home, "Library/LaunchAgents"), { recursive: true, mode: 0o700 });
  await mkdir(join(app, "Contents/MacOS"), { recursive: true }); await mkdir(join(app, "Contents/Resources/codex-cli/bin"), { recursive: true });
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(join(app, "Contents/MacOS/ChatGPT"), ""); await writeFile(codex, "#!/bin/sh\necho native \"$@\"\n"); await chmod(codex, 0o700);
  const gateway = join(root, "gateway"); await writeFile(gateway, "#!/bin/sh\nexit 0\n"); await chmod(gateway, 0o700);
  const config = join(root, "gateway.json");
  await writePrivateJson(config, { version: 1, port: 3457, stateDirectory: state, providers: [{ id: "api", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "GATEWAY_NO_FORCE_CLI_KEY", models: { fixture: "upstream" } }] });
  const values = new Map<string, string>(); const calls: string[] = [];
  // Records every launchctl call against a simulated GUI session; nothing here reaches /bin/launchctl.
  const exec: LaunchctlExec = async (file, args) => {
    assert.equal(file, "/bin/launchctl"); calls.push(args.join(" "));
    if (args[0] === "getenv") {
      const value = values.get(args[1]!); if (value === undefined) throw new Error("Command failed: /bin/launchctl getenv " + args[1]);
      return { stdout: value };
    }
    if (args[0] === "setenv") values.set(args[1]!, args[2]!);
    if (args[0] === "unsetenv") values.delete(args[1]!);
    if (args[0] === "print") throw new Error("Could not find service");
    return { stdout: "" };
  };
  const receipt = join(state, "desktop-registration.json");
  return { root, home, app, state, config, gateway, values, calls, exec, receipt };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function inHome<T>(f: Fixture, run: () => Promise<T>): Promise<T> {
  const saved = { HOME: process.env.HOME, installed: process.env.GATEWAY_INSTALLED, command: process.env.GATEWAY_COMMAND };
  process.env.HOME = f.home; process.env.GATEWAY_INSTALLED = "1"; process.env.GATEWAY_COMMAND = f.gateway;
  try { return await run(); } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.installed === undefined) delete process.env.GATEWAY_INSTALLED; else process.env.GATEWAY_INSTALLED = saved.installed;
    if (saved.command === undefined) delete process.env.GATEWAY_COMMAND; else process.env.GATEWAY_COMMAND = saved.command;
    await rm(f.root, { recursive: true, force: true });
  }
}
test("registration sets only CODEX_CLI_PATH and leaves the native app-server mode alone", mac, async () => {
  const f = await fixture();
  await inHome(f, async () => {
    const result = await macDesktop("register", f.config, f.app, true, f.exec);
    assert.equal(result.registered, true);
    assert.equal(f.calls.some(call => call.startsWith(`setenv ${FORCE}`)), false, "FORCE_CLI must never be set");
    const wrapper = (JSON.parse(await readFile(f.receipt, "utf8")) as { wrapper: string }).wrapper;
    assert.ok(f.calls.includes(`setenv ${PATH_KEY} ${wrapper}`), "CODEX_CLI_PATH remains the adapter hook");
    assert.equal(f.values.get(PATH_KEY), wrapper);
  });
});

/** The pair an older gateway exported: our receipt names the wrapper and the login session still holds it. */
async function legacyPair(f: Fixture, current: "same" | "older") {
  const { wrapper } = await prepareDesktop(f.config, f.app);
  const registered = current === "same" ? wrapper : join(f.state, "desktop-wrapper-0123456789abcdef");
  await writePrivateJson(f.receipt, { wrapper: registered, registeredAt: new Date().toISOString() });
  f.values.set(PATH_KEY, registered); f.values.set(FORCE, "1");
  return { wrapper, registered };
}

test("registration clears a FORCE_CLI left by an older gateway, including a restore-only re-register", mac, async () => {
  for (const current of ["same", "older"] as const) {
    const f = await fixture();
    await inHome(f, async () => {
      const { wrapper } = await legacyPair(f, current);
      const result = await macDesktop("register", f.config, f.app, true, f.exec);
      assert.equal(result.registered, true);
      assert.ok(f.calls.includes(`unsetenv ${FORCE}`), "the legacy hook is removed before the early return");
      assert.equal(f.values.has(FORCE), false);
      assert.equal(f.calls.some(call => call.startsWith(`setenv ${FORCE}`)), false);
      assert.equal(f.values.get(PATH_KEY), wrapper, "CODEX_CLI_PATH still points at the current wrapper");
    });
  }
});

test("registration clears our FORCE_CLI when the session already names the current wrapper but the receipt an older one", mac, async () => {
  const f = await fixture();
  await inHome(f, async () => {
    const { wrapper } = await prepareDesktop(f.config, f.app);
    await writePrivateJson(f.receipt, { wrapper: join(f.state, "desktop-wrapper-0123456789abcdef"), registeredAt: new Date().toISOString() });
    f.values.set(PATH_KEY, wrapper); f.values.set(FORCE, "1");
    const result = await macDesktop("register", f.config, f.app, true, f.exec);
    assert.equal(result.registered, true);
    assert.ok(f.calls.includes(`unsetenv ${FORCE}`), "the current wrapper proves the pair");
    assert.equal(f.calls.some(call => call.startsWith(`setenv ${FORCE}`)), false);
    assert.equal(f.values.has(FORCE), false);
    assert.equal(f.values.get(PATH_KEY), wrapper);
  });
});

test("registration refuses a FORCE_CLI=1 it cannot prove it set", mac, async () => {
  const unproven: Array<[string, (f: Fixture, wrapper: string) => Promise<void>]> = [
    ["no receipt and no CODEX_CLI_PATH", async () => undefined],
    ["a receipt but no CODEX_CLI_PATH", async (f, wrapper) => { await writePrivateJson(f.receipt, { wrapper }); }],
    ["CODEX_CLI_PATH of the current wrapper but no receipt", async (f, wrapper) => { f.values.set(PATH_KEY, wrapper); }],
  ];
  for (const [name, seed] of unproven) {
    const f = await fixture();
    await inHome(f, async () => {
      const { wrapper } = await prepareDesktop(f.config, f.app);
      await seed(f, wrapper); f.values.set(FORCE, "1");
      await assert.rejects(macDesktop("register", f.config, f.app, true, f.exec), /Another desktop CLI mode is active; it was not replaced/, name);
      assert.equal(f.calls.some(call => call.includes(FORCE) && !call.startsWith("getenv ")), false, name + ": no setenv or unsetenv");
      assert.equal(f.values.get(FORCE), "1", name);
    });
  }
});

test("the standalone register path clears our FORCE_CLI, writes the login agent and bootstraps it", mac, async () => {
  const f = await fixture();
  await inHome(f, async () => {
    await legacyPair(f, "older");
    const result = await macDesktop("register", f.config, f.app, false, f.exec);
    assert.equal(result.registered, true); assert.equal(result.freshAppLaunchRequired, true);
    const label = "com.edihasaj.subscription-gateway.desktop"; const domain = `gui/${process.getuid!()}`;
    const plist = join(f.home, "Library/LaunchAgents", label + ".plist");
    assert.ok(f.calls.includes(`unsetenv ${FORCE}`)); assert.equal(f.calls.some(call => call.startsWith(`setenv ${FORCE}`)), false);
    assert.ok(f.calls.includes(`enable ${domain}/${label}`), "the seam sees enable");
    assert.ok(f.calls.includes(`bootstrap ${domain} ${plist}`), "the seam sees bootstrap of the plist under the fake HOME");
    assert.match(await readFile(plist, "utf8"), /Managed by subscription-gateway desktop/);
    assert.equal(f.values.has(FORCE), false);
  });
});

test("registration refuses a FORCE_CLI set by something else and never touches it", mac, async () => {
  const f = await fixture();
  await inHome(f, async () => {
    f.values.set(FORCE, "other");
    await assert.rejects(macDesktop("register", f.config, f.app, true, f.exec), /Another desktop CLI mode is active; it was not replaced/);
    assert.equal(f.calls.some(call => call.includes(FORCE) && !call.startsWith("getenv ")), false, "no setenv or unsetenv for a foreign value");
    assert.equal(f.values.get(FORCE), "other");
  });
});

test("status reports the legacy FORCE_CLI hook separately from the desktop registration", mac, async () => {
  const f = await fixture();
  await inHome(f, async () => {
    const { wrapper } = await prepareDesktop(f.config, f.app);
    await writePrivateJson(f.receipt, { wrapper, registeredAt: new Date().toISOString() });
    f.values.set(PATH_KEY, wrapper);
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).legacyForceCli, false, "nothing set");
    f.values.set(FORCE, "1");
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).legacyForceCli, true);
    f.values.set(FORCE, "other");
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).legacyForceCli, false, "a foreign value is not ours to clear");
    f.values.set(FORCE, "1"); f.values.set(PATH_KEY, "/somewhere/else");
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).legacyForceCli, false, "a 1 beside a foreign CLI path is not ours");
    f.values.delete(PATH_KEY); await writePrivateJson(f.receipt, {});
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).legacyForceCli, false, "a 1 without a receipt is not ours");
  });
});

test("unregistration clears our FORCE_CLI and leaves a foreign value", mac, async () => {
  for (const [legacy, cleared] of [["1", true], ["other", false]] as const) {
    const f = await fixture();
    await inHome(f, async () => {
      const { wrapper } = await prepareDesktop(f.config, f.app);
      await writePrivateJson(f.receipt, { wrapper, registeredAt: new Date().toISOString() });
      f.values.set(PATH_KEY, wrapper); f.values.set(FORCE, legacy);
      const result = await macDesktop("unregister", f.config, f.app, false, f.exec);
      assert.equal(result.registered, false);
      assert.ok(f.calls.includes(`unsetenv ${PATH_KEY}`));
      assert.equal(f.calls.includes(`unsetenv ${FORCE}`), cleared);
      assert.equal(f.values.get(FORCE), cleared ? undefined : legacy);
    });
  }
});

test("the desktop launch environment uses CODEX_CLI_PATH alone", () => {
  const base: NodeJS.ProcessEnv = { PATH: "/usr/bin", CODEX_API_KEY: "a", OPENAI_API_KEY: "b", OPENAI_BASE_URL: "http://c" };
  const env = desktopEnvironment(base, "/tmp/wrapper", "/tmp/gateway.json");
  assert.equal(env[FORCE], undefined);
  assert.equal(env.CODEX_CLI_PATH, "/tmp/wrapper"); assert.equal(env.GATEWAY_CONFIG, "/tmp/gateway.json");
  assert.equal(env.CODEX_API_KEY, undefined); assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(base.CODEX_CLI_PATH, undefined, "the base environment is not mutated"); assert.equal(base[FORCE], undefined);
  assert.equal(desktopEnvironment({ [PATH_KEY]: "/tmp/wrapper", [FORCE]: "1" }, "/tmp/wrapper", "/tmp/gateway.json")[FORCE], undefined, "our inherited legacy pair is dropped");
  assert.equal(desktopEnvironment({ [PATH_KEY]: "/s/desktop-wrapper-0123456789abcdef", [FORCE]: "1" }, "/tmp/wrapper", "/tmp/gateway.json")[FORCE], undefined, "an older wrapper counts as ours");
  assert.equal(desktopEnvironment({ [FORCE]: "1" }, "/tmp/wrapper", "/tmp/gateway.json")[FORCE], "1", "a 1 without our wrapper is the user's");
  assert.equal(desktopEnvironment({ [PATH_KEY]: "/opt/other-cli", [FORCE]: "1" }, "/tmp/wrapper", "/tmp/gateway.json")[FORCE], "1", "a 1 beside a foreign CLI path is the user's");
  assert.equal(desktopEnvironment({ [FORCE]: "other" }, "/tmp/wrapper", "/tmp/gateway.json", "/tmp/native")[FORCE], "other", "a foreign value survives");
  assert.equal(desktopEnvironment({}, "/tmp/wrapper", "/tmp/gateway.json", "/tmp/native/../other").CODEX_HOME, "/tmp/other", "native home is resolved");
});

test("launchDesktop starts the app with CODEX_CLI_PATH and no FORCE_CLI", mac, async () => {
  const cases: Array<[string, (wrapper: string) => NodeJS.ProcessEnv, string | undefined]> = [
    ["clean terminal", () => ({}), undefined],
    ["our inherited pair", wrapper => ({ [PATH_KEY]: wrapper, [FORCE]: "1" }), undefined],
    ["a foreign value", () => ({ [FORCE]: "other" }), "other"],
    ["a 1 the user exported", () => ({ [PATH_KEY]: "/opt/other-cli", [FORCE]: "1" }), "1"],
  ];
  for (const [name, inherited, expected] of cases) {
    const f = await fixture();
    await inHome(f, async () => {
      const { binary, wrapper } = await prepareDesktop(f.config, f.app);
      const saved = { ...process.env };
      delete process.env[FORCE]; delete process.env[PATH_KEY]; Object.assign(process.env, inherited(wrapper));
      let seen: NodeJS.ProcessEnv | undefined; let spawned: string | undefined;
      try {
        const result = await launchDesktop(f.config, undefined, f.app, {
          processes: () => "/bin/zsh\n", wait: async () => undefined,
          fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
          spawn: ((file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
            spawned = file; seen = options.env;
            return Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, unref() {} });
          }) as unknown as typeof import("node:child_process").spawn,
        });
        assert.equal(result.launched, true, name);
      } finally { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved); }
      assert.equal(spawned, binary, name); assert.ok(seen, name);
      assert.equal(seen![PATH_KEY], wrapper, name + ": the adapter hook is the wrapper");
      assert.equal(seen![FORCE], expected, name);
    });
  }
});

test("the default launchctl runner bounds every call with a timeout", async () => {
  const seen: Array<[string, string[], { timeout: number }]> = [];
  const run = launchctlRunner(async (file, args, options) => { seen.push([file, args, options]); return { stdout: "value\n" }; });
  assert.deepEqual(await run("/bin/launchctl", ["getenv", PATH_KEY]), { stdout: "value\n" });
  assert.deepEqual(seen, [["/bin/launchctl", ["getenv", PATH_KEY], { timeout: 10000 }]]);
});
