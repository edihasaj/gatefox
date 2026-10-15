import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { macDesktop, type LaunchctlExec } from "../mac-desktop.js";
import { prepareDesktop } from "../desktop-launch.js";
import { writePrivateJson } from "../config.js";

const mac = { skip: process.platform !== "darwin" };
const FORCE = "CODEX_APP_SERVER_FORCE_CLI"; const PATH_KEY = "CODEX_CLI_PATH";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-own-wrapper-"));
  const home = join(root, "home"); const app = join(root, "ChatGPT.app"); const state = join(root, "state");
  const codex = join(app, "Contents/Resources/codex-cli/bin/codex");
  await mkdir(join(home, "Library/LaunchAgents"), { recursive: true, mode: 0o700 });
  await mkdir(join(app, "Contents/MacOS"), { recursive: true }); await mkdir(join(app, "Contents/Resources/codex-cli/bin"), { recursive: true });
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(join(app, "Contents/MacOS/ChatGPT"), ""); await writeFile(codex, "#!/bin/sh\necho native \"$@\"\n"); await chmod(codex, 0o700);
  const gateway = join(root, "gateway"); await writeFile(gateway, "#!/bin/sh\nexit 0\n"); await chmod(gateway, 0o700);
  const config = join(root, "gateway.json");
  await writePrivateJson(config, { version: 1, port: 3457, stateDirectory: state, providers: [{ id: "api", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "GATEWAY_OWN_WRAPPER_KEY", models: { fixture: "upstream" } }] });
  const values = new Map<string, string>(); const calls: string[] = [];
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

/** Session holds an older wrapper in our state dir; the receipt names a different one and FORCE_CLI=1 is still set. */
async function staleOwnPair(f: Fixture) {
  const { wrapper } = await prepareDesktop(f.config, f.app);
  await writePrivateJson(f.receipt, { wrapper, registeredAt: new Date().toISOString() });
  const stale = join(f.state, "desktop-wrapper-89fafe006c5dc3e4");
  f.values.set(PATH_KEY, stale); f.values.set(FORCE, "1");
  return wrapper;
}

test("registration replaces an older gateway wrapper the receipt no longer names and clears its FORCE_CLI", mac, async () => {
  for (const restoreOnly of [true, false]) {
    const f = await fixture();
    await inHome(f, async () => {
      const wrapper = await staleOwnPair(f);
      const result = await macDesktop("register", f.config, f.app, restoreOnly, f.exec);
      assert.equal(result.registered, true, `restoreOnly=${restoreOnly}`);
      assert.equal(f.values.get(PATH_KEY), wrapper, `restoreOnly=${restoreOnly}: the current wrapper replaces the stale one`);
      assert.equal(f.values.has(FORCE), false, `restoreOnly=${restoreOnly}: the proven legacy hook is cleared`);
      assert.ok(f.calls.includes(`unsetenv ${FORCE}`));
      assert.equal(f.calls.some(call => call.startsWith(`setenv ${FORCE}`)), false);
    });
  }
});

test("registration refuses a CODEX_CLI_PATH that only looks like one of our wrappers", mac, async () => {
  for (const restoreOnly of [true, false]) {
    for (const [name, foreign] of [
      ["another directory", async (f: Fixture) => join(f.root, "other", "desktop-wrapper-0123456789abcdef")],
      ["a suffix in the state directory", async (f: Fixture) => join(f.state, "desktop-wrapper-0123456789abcdef.sh")],
      ["a short hash in the state directory", async (f: Fixture) => join(f.state, "desktop-wrapper-0123")],
      ["a prefix in the state directory", async (f: Fixture) => join(f.state, "notdesktop-wrapper-0123456789abcdef")],
    ] as const) {
      const f = await fixture();
      await inHome(f, async () => {
        await staleOwnPair(f);
        const path = await foreign(f); f.values.set(PATH_KEY, path);
        await assert.rejects(macDesktop("register", f.config, f.app, restoreOnly, f.exec), /Another desktop CLI override is active; it was not replaced/, `${name} restoreOnly=${restoreOnly}`);
        assert.equal(f.values.get(PATH_KEY), path, `${name}: the foreign path is never replaced`);
        assert.equal(f.values.get(FORCE), "1", `${name}: no proof, so the FORCE_CLI value is untouched`);
        assert.equal(f.calls.some(call => call.includes(PATH_KEY) && !call.startsWith("getenv ")), false, `${name}: no setenv or unsetenv for CODEX_CLI_PATH`);
        assert.equal(f.calls.some(call => call.includes(FORCE) && !call.startsWith("getenv ")), false, `${name}: no setenv or unsetenv for FORCE_CLI`);
      });
    }
  }
});

test("unregistration clears an older gateway wrapper the receipt no longer names", mac, async () => {
  const f = await fixture();
  await inHome(f, async () => {
    await staleOwnPair(f);
    const result = await macDesktop("unregister", f.config, f.app, false, f.exec);
    assert.equal(result.registered, false);
    assert.ok(f.calls.includes(`unsetenv ${PATH_KEY}`)); assert.ok(f.calls.includes(`unsetenv ${FORCE}`));
    assert.equal(f.values.has(PATH_KEY), false); assert.equal(f.values.has(FORCE), false);
  });
});

test("status reports an older gateway wrapper as ours", mac, async () => {
  const f = await fixture();
  await inHome(f, async () => {
    const wrapper = await staleOwnPair(f);
    const status = await macDesktop("status", f.config, f.app, false, f.exec);
    assert.equal(status.registered, true); assert.equal(status.activeForFutureLaunches, true, "a wrapper in our state dir is still ours");
    assert.equal(status.legacyForceCli, true, `wrapper=${wrapper}`);
    f.values.set(PATH_KEY, join(f.state, "desktop-wrapper-0123"));
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).activeForFutureLaunches, false, "a look-alike is not ours");
  });
});
