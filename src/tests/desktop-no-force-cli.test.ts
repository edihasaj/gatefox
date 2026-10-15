import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { launchctlRunner, macDesktop } from "../mac-desktop.js";
import { desktopEnvironment, launchDesktop, prepareDesktop } from "../desktop-launch.js";
import { writePrivateJson } from "../config.js";
import { FORCE, inDesktopHome, PATH_KEY, desktopFixture, type DesktopFixture as Fixture } from "./desktop-fixture.js";

const mac = { skip: process.platform !== "darwin" };
const fixture = () => desktopFixture("no-force-cli");

test("registration sets only CODEX_CLI_PATH and leaves the native app-server mode alone", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
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
    await inDesktopHome(f, async () => {
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
  await inDesktopHome(f, async () => {
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
  const unproven: Array<[string, (f: Fixture, wrapper: string) => Promise<void>, RegExp]> = [
    ["no receipt and no CODEX_CLI_PATH", async () => undefined, /CODEX_APP_SERVER_FORCE_CLI is set to the legacy value and nothing proves the gateway set it\. Run `launchctl unsetenv CODEX_APP_SERVER_FORCE_CLI`, then register again\./],
    ["a receipt but no CODEX_CLI_PATH", async (f, wrapper) => { await writePrivateJson(f.receipt, { wrapper }); }, /CODEX_APP_SERVER_FORCE_CLI is set to the legacy value and nothing proves the gateway set it\. Run `launchctl unsetenv CODEX_APP_SERVER_FORCE_CLI`, then register again\./],
    ["a wrapper path but nothing naming a wrapper in the receipt", async (f, wrapper) => { f.values.set(PATH_KEY, wrapper); }, /no registration receipt proves the gateway set it/],
  ];
  for (const [name, seed, refusal] of unproven) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      const { wrapper } = await prepareDesktop(f.config, f.app);
      await seed(f, wrapper); f.values.set(FORCE, "1");
      await assert.rejects(macDesktop("register", f.config, f.app, true, f.exec), refusal, name);
      assert.equal(f.calls.some(call => call.includes(FORCE) && !call.startsWith("getenv ")), false, name + ": no setenv or unsetenv");
      assert.equal(f.values.get(FORCE), "1", name);
    });
  }
});

/**
 * The pair an older gateway exported, with the receipt gone: `CODEX_CLI_PATH` is still a wrapper of ours, but
 * nothing proves the gateway exported FORCE_CLI=1. Registration says so, status calls the wrapper stale rather
 * than ours to clear, and unregistration clears the path it owns and leaves the value.
 */
async function noReceiptPair(f: Fixture, receipt: "empty" | "missing") {
  const stale = join(f.state, "desktop-wrapper-98fedcba01234567");
  if (receipt === "empty") await writePrivateJson(f.receipt, {});
  f.values.set(PATH_KEY, stale); f.values.set(FORCE, "1");
  return stale;
}

test("registration refuses a FORCE_CLI=1 beside our own older wrapper when no receipt names a wrapper", mac, async () => {
  for (const receipt of ["empty", "missing"] as const) {
    for (const restoreOnly of [true, false]) {
      const name = `receipt=${receipt} restoreOnly=${restoreOnly}`;
      const f = await fixture();
      await inDesktopHome(f, async () => {
        const stale = await noReceiptPair(f, receipt);
        await assert.rejects(macDesktop("register", f.config, f.app, restoreOnly, f.exec),
          /CODEX_APP_SERVER_FORCE_CLI is set to the legacy value beside a gateway wrapper, but no registration receipt proves the gateway set it\. If it came from the gateway, run `launchctl unsetenv CODEX_APP_SERVER_FORCE_CLI` and register again\./, name);
        assert.equal(f.values.get(PATH_KEY), stale, name + ": the wrapper path is untouched");
        assert.equal(f.values.get(FORCE), "1", name + ": the value is untouched");
        assert.equal(f.calls.some(call => (call.includes(PATH_KEY) || call.includes(FORCE)) && !call.startsWith("getenv ")), false, name + ": no setenv or unsetenv");
      });
    }
  }
});

/**
 * Unregister clears an own wrapper path even with no receipt, and the unproven 1 stays beside it. The next
 * register has to say which value it is refusing and how to clear it, because that is now the only blocker.
 */
test("registration after such an unregistration names FORCE_CLI and gives the remedy", mac, async () => {
  for (const receipt of ["empty", "missing"] as const) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      const stale = await noReceiptPair(f, receipt);
      const result = await macDesktop("unregister", f.config, f.app, false, f.exec);
      assert.equal(result.registered, false, receipt);
      assert.equal(result.legacyForceCliKept, true, receipt + ": the 1 stayed beside the path we cleared");
      assert.equal(f.values.has(PATH_KEY), false, receipt + ": " + stale + " is no longer the session path");
      assert.equal(f.values.get(FORCE), "1", receipt + ": the unproven value is untouched");
      await assert.rejects(macDesktop("register", f.config, f.app, true, f.exec),
        /CODEX_APP_SERVER_FORCE_CLI is set to the legacy value and nothing proves the gateway set it\. Run `launchctl unsetenv CODEX_APP_SERVER_FORCE_CLI`, then register again\./,
        receipt + ": the refusal names the value and the remedy, never a foreign one");
      assert.equal(f.calls.includes(`unsetenv ${FORCE}`), false, receipt + ": the refusal alone clears nothing more");
      assert.equal(f.values.get(FORCE), "1", receipt + ": register still has not touched the value");
      f.values.delete(FORCE);
      assert.equal((await macDesktop("register", f.config, f.app, true, f.exec)).registered, true, receipt + ": following the remedy unblocks registration");
    });
  }
});

test("status of our own older wrapper without a receipt names it stale and never ours to clear", mac, async () => {
  for (const receipt of ["empty", "missing"] as const) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      const stale = await noReceiptPair(f, receipt);
      const status = await macDesktop("status", f.config, f.app, false, f.exec);
      assert.equal(status.registered, false, receipt);
      assert.equal(status.activeForFutureLaunches, false, receipt);
      assert.equal(status.staleWrapper, true, receipt + ": " + stale + " is a wrapper of ours");
      assert.equal(status.legacyForceCli, false, receipt + ": nothing proves the 1 is ours");
      assert.equal(f.values.get(FORCE), "1", receipt + ": status writes nothing");
      assert.equal(f.values.get(PATH_KEY), stale, receipt);
    });
  }
});

test("unregistration clears our own older wrapper without a receipt but leaves its FORCE_CLI", mac, async () => {
  for (const receipt of ["empty", "missing"] as const) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      await noReceiptPair(f, receipt);
      const result = await macDesktop("unregister", f.config, f.app, false, f.exec);
      assert.equal(result.registered, false, receipt);
      assert.ok(f.calls.includes(`unsetenv ${PATH_KEY}`), receipt + ": an own wrapper path is ours to clear");
      assert.equal(f.calls.includes(`unsetenv ${FORCE}`), false, receipt + ": no receipt names a wrapper, so the 1 stays");
      assert.equal(f.values.has(PATH_KEY), false, receipt);
      assert.equal(f.values.get(FORCE), "1", receipt);
    });
  }
});

test("the standalone register path clears our FORCE_CLI, writes the login agent and bootstraps it", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
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
  await inDesktopHome(f, async () => {
    f.values.set(FORCE, "other");
    await assert.rejects(macDesktop("register", f.config, f.app, true, f.exec), /Another desktop CLI mode is active; it was not replaced/);
    assert.equal(f.calls.some(call => call.includes(FORCE) && !call.startsWith("getenv ")), false, "no setenv or unsetenv for a foreign value");
    assert.equal(f.values.get(FORCE), "other");
  });
});

test("registration refuses a foreign FORCE_CLI value even beside a proven gateway pair", mac, async () => {
  for (const restoreOnly of [true, false]) {
    for (const foreign of ["other", "0"]) {
      const name = `restoreOnly=${restoreOnly} value=${foreign}`;
      const f = await fixture();
      await inDesktopHome(f, async () => {
        const { wrapper } = await legacyPair(f, "same"); f.values.set(FORCE, foreign);
        await assert.rejects(macDesktop("register", f.config, f.app, restoreOnly, f.exec), /Another desktop CLI mode is active; it was not replaced/, name);
        assert.equal(f.calls.some(call => call.includes(FORCE) && !call.startsWith("getenv ")), false, name + ": no setenv or unsetenv");
        assert.equal(f.values.get(FORCE), foreign, name);
        assert.equal(f.values.get(PATH_KEY), wrapper, name + ": the proven CLI path is unchanged");
      });
    }
  }
});

test("registration refuses a FORCE_CLI=0 beside our own older wrapper when there is no receipt", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const stale = await noReceiptPair(f, "missing"); f.values.set(FORCE, "0");
    await assert.rejects(macDesktop("register", f.config, f.app, true, f.exec), (error: unknown) => {
      assert.match((error as Error).message, /^Another desktop CLI mode is active; it was not replaced$/, "a value other than 1 gets the nameless refusal, even beside a wrapper of ours");
      return true;
    });
    assert.equal(f.values.get(PATH_KEY), stale, "the own wrapper path is untouched");
    assert.equal(f.values.get(FORCE), "0", "the foreign value is untouched");
    assert.equal(f.calls.some(call => (call.includes(PATH_KEY) || call.includes(FORCE)) && !call.startsWith("getenv ")), false, "no setenv or unsetenv");
  });
});

test("unregistration leaves a FORCE_CLI=1 it cannot prove it set", mac, async () => {
  const unproven: Array<[string, (f: Fixture, wrapper: string) => Promise<void>]> = [
    ["a receipt wrapper beside a foreign CODEX_CLI_PATH", async (f, wrapper) => {
      await writePrivateJson(f.receipt, { wrapper, registeredAt: new Date().toISOString() }); f.values.set(PATH_KEY, "/opt/other-cli");
    }],
    ["an empty receipt and no CODEX_CLI_PATH", async f => { await writePrivateJson(f.receipt, {}); }],
  ];
  for (const [name, seed] of unproven) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      const { wrapper } = await prepareDesktop(f.config, f.app);
      await seed(f, wrapper); f.values.set(FORCE, "1"); const cliPath = f.values.get(PATH_KEY);
      const result = await macDesktop("unregister", f.config, f.app, false, f.exec);
      assert.equal(result.registered, false, name);
      assert.equal(f.calls.some(call => call.includes(FORCE) && !call.startsWith("getenv ")), false, name + ": no setenv or unsetenv");
      assert.equal(f.calls.includes(`unsetenv ${PATH_KEY}`), false, name + ": a foreign CLI path is not ours");
      assert.equal(f.values.get(FORCE), "1", name); assert.equal(f.values.get(PATH_KEY), cliPath, name);
    });
  }
});

test("status reports the legacy FORCE_CLI hook separately from the desktop registration", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
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

/** forceCliSet is the presence half of status: any non-empty value, ours or not, is reported without echoing it. */
test("status reports whether FORCE_CLI is set without ever reporting its value", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const { wrapper } = await prepareDesktop(f.config, f.app);
    await writePrivateJson(f.receipt, { wrapper, registeredAt: new Date().toISOString() });
    f.values.set(PATH_KEY, wrapper);
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).forceCliSet, false, "an unset variable is not set");
    for (const value of ["1", "other"]) {
      f.values.set(FORCE, value);
      const status = await macDesktop("status", f.config, f.app, false, f.exec);
      assert.equal(status.forceCliSet, true, JSON.stringify(value) + ": any non-empty value counts as set");
      assert.equal(status.legacyForceCli, value === "1", JSON.stringify(value) + ": only the legacy 1 is ours to clear");
      assert.equal(JSON.stringify(status).includes("other"), false, "the output never carries the value");
      assert.equal(f.calls.some(call => call.includes("other")), false, "the value never reaches a launchctl call");
    }
    // launchctl getenv exits 0 with empty stdout for an unset name, so an empty value reads as not set.
    f.values.set(FORCE, "");
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).forceCliSet, false, "an empty value is not set");
    f.values.set(FORCE, "1");
    f.values.set(PATH_KEY, "/opt/other-cli");
    const foreign = await macDesktop("status", f.config, f.app, false, f.exec);
    assert.equal(foreign.forceCliSet, true, "presence is not ownership: a foreign CLI path still leaves the value set");
    assert.equal(foreign.legacyForceCli, false, "and the 1 beside it is still not ours");
  });
});

/**
 * A real `launchctl getenv` prints the value plus exactly one newline. The fixture mirrors that, and status must
 * strip exactly that terminator: leaving it on would break every wrapper comparison, and trimming further would
 * turn a whitespace-only value into an unset one.
 */
test("the single trailing newline from getenv is stripped and a whitespace FORCE_CLI counts as set", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const { wrapper } = await prepareDesktop(f.config, f.app);
    await writePrivateJson(f.receipt, { wrapper, registeredAt: new Date().toISOString() });
    f.values.set(PATH_KEY, wrapper);
    assert.equal((await f.exec("/bin/launchctl", ["getenv", PATH_KEY])).stdout, wrapper + "\n", "the fixture answers like launchctl: the value plus exactly one newline");
    assert.equal((await macDesktop("status", f.config, f.app, false, f.exec)).activeForFutureLaunches, true, "the stripped value equals the receipt's wrapper");
    f.values.set(FORCE, " ");
    const blank = await macDesktop("status", f.config, f.app, false, f.exec);
    assert.equal(blank.forceCliSet, true, "a whitespace-only value is set, not the empty answer for an unset name");
    assert.equal(blank.legacyForceCli, false, "and it is not the legacy 1");
  });
});

test("unregistration clears our FORCE_CLI and leaves a foreign value", mac, async () => {
  for (const [legacy, cleared] of [["1", true], ["other", false]] as const) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      const { wrapper } = await prepareDesktop(f.config, f.app);
      await writePrivateJson(f.receipt, { wrapper, registeredAt: new Date().toISOString() });
      f.values.set(PATH_KEY, wrapper); f.values.set(FORCE, legacy);
      const result = await macDesktop("unregister", f.config, f.app, false, f.exec);
      assert.equal(result.registered, false);
      assert.ok(!("legacyForceCliKept" in result), legacy + ": the receipt proved the pair, so nothing was kept");
      assert.ok(f.calls.includes(`unsetenv ${PATH_KEY}`));
      assert.equal(f.calls.includes(`unsetenv ${FORCE}`), cleared);
      assert.equal(f.values.get(FORCE), cleared ? undefined : legacy);
    });
  }
});

test("registration still refuses a foreign CODEX_CLI_PATH and never replaces it", mac, async () => {
  for (const restoreOnly of [true, false]) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      f.values.set(PATH_KEY, "/opt/other-cli");
      await assert.rejects(macDesktop("register", f.config, f.app, restoreOnly, f.exec), /Another desktop CLI override is active/);
      assert.equal(f.calls.some(call => call.startsWith(`setenv ${PATH_KEY}`) || call.startsWith(`unsetenv ${PATH_KEY}`)), false, `restoreOnly=${restoreOnly}`);
      assert.equal(f.values.get(PATH_KEY), "/opt/other-cli");
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
  // Only an exact gateway wrapper name counts as ours: look-alike paths belong to the user.
  for (const lookalike of ["/opt/notdesktop-wrapper-0123456789abcdef", "/s/desktop-wrapper-0123456789abcdef.sh", "/s/desktop-wrapper-0123", "/opt/my-desktop-wrapper-tool"]) {
    assert.equal(desktopEnvironment({ [PATH_KEY]: lookalike, [FORCE]: "1" }, "/tmp/wrapper", "/tmp/gateway.json")[FORCE], "1", `a 1 beside ${lookalike} is the user's`);
  }
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
    await inDesktopHome(f, async () => {
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

test("a failing getenv propagates through every action instead of reading as unset", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const failing = async (file: string, args: string[]): Promise<{ stdout: string }> => {
      if (args[0] === "getenv") { f.calls.push(args.join(" ")); throw new Error("spawn failed"); }
      return f.exec(file, args);
    };
    await assert.rejects(macDesktop("status", f.config, f.app, false, failing), /spawn failed/, "status propagates rather than reporting forceCliSet:false");
    await assert.rejects(macDesktop("register", f.config, f.app, true, failing), /spawn failed/, "register propagates rather than treating an unread session as clean");
    await assert.rejects(macDesktop("unregister", f.config, f.app, false, failing), /spawn failed/, "unregister propagates rather than skipping what it owns");
    assert.equal(f.calls.some(call => call.startsWith("setenv")), false, "no setenv before the probe could answer");
    assert.equal(f.calls.some(call => call.startsWith("unsetenv")), false, "no unsetenv before the probe could answer");
    assert.equal(f.calls.some(call => call.startsWith("bootout")), false, "no bootout before the probe could answer");
  });
});

test("the default launchctl runner bounds every call with a timeout", async () => {
  const seen: Array<[string, string[], { timeout: number }]> = [];
  const run = launchctlRunner(async (file, args, options) => { seen.push([file, args, options]); return { stdout: "value\n" }; });
  assert.deepEqual(await run("/bin/launchctl", ["getenv", PATH_KEY]), { stdout: "value\n" });
  assert.deepEqual(seen, [["/bin/launchctl", ["getenv", PATH_KEY], { timeout: 10000 }]]);
});
