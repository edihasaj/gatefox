import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { macDesktop, type LaunchctlExec } from "../mac-desktop.js";
import { desktopEnvironment, prepareDesktop } from "../desktop-launch.js";
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

test("registration clears a FORCE_CLI left by an older gateway, including a restore-only re-register", mac, async () => {
  const f = await fixture();
  await inHome(f, async () => {
    f.values.set(FORCE, "1");
    const result = await macDesktop("register", f.config, f.app, true, f.exec);
    assert.equal(result.registered, true);
    assert.ok(f.calls.includes(`unsetenv ${FORCE}`), "the legacy hook is removed before the early return");
    assert.equal(f.values.has(FORCE), false);
    assert.equal(f.calls.some(call => call.startsWith(`setenv ${FORCE}`)), false);
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
  assert.equal(desktopEnvironment({ [FORCE]: "1" }, "/tmp/wrapper", "/tmp/gateway.json")[FORCE], undefined, "an inherited legacy value is dropped");
  assert.equal(desktopEnvironment({ [FORCE]: "other" }, "/tmp/wrapper", "/tmp/gateway.json", "/tmp/native")[FORCE], "other", "a foreign value survives");
  assert.equal(desktopEnvironment({}, "/tmp/wrapper", "/tmp/gateway.json", "/tmp/native/../other").CODEX_HOME, "/tmp/other", "native home is resolved");
});
