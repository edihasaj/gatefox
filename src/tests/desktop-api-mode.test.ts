import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { writePrivateJson, loadConfig } from "../config.js";
import { prepareDesktop } from "../desktop-launch.js";
import { modelCatalog } from "../catalog.js";
import { codexSettings, gatewayProviderTable } from "../codex-config.js";
import { gatewayCommand } from "../command.js";
import { apiModeActive, apiModeCatalogPath, apiModeReceiptPath, desktopApiMode, refreshApiModeCatalog, apiModeProvider } from "../desktop-api-mode.js";
import { macDesktop, presetDesktopEnv } from "../mac-desktop.js";
import { withLoginRegistrationLock } from "../login-registration-lock.js";
import { agentRuntimeFile, envAgentLabel, envAgentPlist, envAgentScript, envAgentScriptPath } from "../desktop-env-agent.js";
import { NativeConfigWriteRejected } from "../desktop-api-mode-native.js";
import { flushTelemetry, readTelemetry } from "../telemetry.js";
import { desktopFixture, inDesktopHome, PATH_KEY, type DesktopFixture as Fixture } from "./desktop-fixture.js";

const mac = { skip: process.platform !== "darwin" };

/** A stand-in for the app's engine: a user layer, its version stamp, and every batch write it was asked to make. */
function fakeEngine(initial: Record<string, unknown> = {}) {
  const state = { config: structuredClone(initial), version: "v1", writes: [] as Array<{ edits: unknown[]; expected: string }>, closed: 0,
    failWrite: undefined as undefined | "rejected" | "uncertain", beforeWrite: undefined as undefined | (() => void) };
  const apply = (config: Record<string, unknown>, edits: Array<{ keyPath: string; value: unknown }>) => {
    for (const edit of edits) {
      const parts = edit.keyPath.split(".");
      const parents: Array<[Record<string, unknown>, string]> = [];
      let target = config;
      for (const part of parts.slice(0, -1)) { parents.push([target, part]); target = (target[part] ??= {}) as Record<string, unknown>; }
      if (edit.value === null) delete target[parts.at(-1)!]; else target[parts.at(-1)!] = structuredClone(edit.value);
      // Deleting the last key of a table removes the table with it, which is what the engine's own writer does.
      if (edit.value !== null) continue;
      for (const [parent, key] of parents.reverse()) if (!Object.keys(parent[key] as object).length) delete parent[key];
    }
  };
  const client = {
    read: async () => ({ version: state.version, config: structuredClone(state.config), file: "/home/.codex/config.toml" }),
    write: async (edits: Array<{ keyPath: string; value: unknown }>, expected: string) => {
      state.beforeWrite?.(); state.beforeWrite = undefined;
      if (expected !== state.version) throw new NativeConfigWriteRejected("Configuration was modified since last read");
      if (state.failWrite) { const failure = state.failWrite; state.failWrite = undefined; throw failure === "rejected" ? new NativeConfigWriteRejected("the engine refused the write") : new Error("the engine lost the write reply"); }
      state.writes.push({ edits, expected });
      apply(state.config, edits); state.version = `v${state.writes.length + 1}`;
    },
    close: async () => { state.closed++; },
  };
  return { state, client };
}

/** The seams `desktopApiMode` runs on: an engine, a quiet app, and a session this test controls. */
function harness(f: Fixture, engine: ReturnType<typeof fakeEngine>, over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const deps = {
    native: async () => engine.client,
    appRunning: async () => over.appRunning === true,
    nativeHome: () => join(f.root, "native-home"),
    cliPathOwner: async () => (over.cliPathOwner ?? "none") as "gateway" | "none" | "other",
    clearCliPath: async () => { calls.push("clear"); if (over.failClear) throw new Error("launchctl refused"); },
    presetEnv: async (): Promise<"set" | "skipped" | "failed"> => { calls.push("preset"); return "skipped"; },
    now: () => new Date("2026-10-25T12:00:00Z"),
  };
  return { deps, calls };
}

const setup = async (initial: Record<string, unknown> = {}, name = "api-mode") => {
  const f = await desktopFixture(name);
  const engine = fakeEngine(initial);
  return { f, engine, ...harness(f, engine) };
};

test("on writes one batch against the version it read, and records what it can undo", mac, async () => {
  const { f, engine, deps } = await setup({ model: "gpt-5.1", model_reasoning_summary: "auto" });
  await inDesktopHome(f, async () => {
    const result = await desktopApiMode("on", f.config, {}, deps);
    assert.equal(result.mode, "api");
    assert.equal(result.model, "fixture", "a native model we cannot serve gives way to the first listed row");
    const [write] = engine.state.writes;
    assert.equal(write.expected, "v1", "the batch is guarded by the version the read reported");
    assert.deepEqual(write.edits.map(e => (e as { keyPath: string }).keyPath), [`model_providers.${apiModeProvider}`, "model_provider", "model_catalog_json", "model"]);
    const provider = (write.edits[0] as { value: Record<string, unknown> }).value;
    assert.equal(provider.base_url, `http://127.0.0.1:3457/v1`);
    assert.equal(provider.wire_api, "responses");
    assert.deepEqual((provider.auth as { args: string[] }).args.slice(-2), ["--config", f.config]);
    const receipt = JSON.parse(await readFile(apiModeReceiptPath(f.state), "utf8")) as Record<string, unknown>;
    assert.deepEqual(receipt.original, { model: "gpt-5.1" }, "only the keys that were there are remembered");
    assert.equal(receipt.providerTableExisted, false);
    assert.equal(receipt.cliPathCleared, false);
    assert.equal((receipt.applied as { catalogPath: string }).catalogPath, apiModeCatalogPath(f.state));
    assert.deepEqual(JSON.parse(await readFile(apiModeCatalogPath(f.state), "utf8")), modelCatalog(await loadConfig(f.config)));
    assert.equal(engine.state.closed, 1, "the engine is always shut down");
  });
});

test("on keeps a model the app already uses when we serve it, and honours --model", mac, async () => {
  const kept = await setup({ model: "fixture" }, "api-mode-keep");
  await inDesktopHome(kept.f, async () => assert.equal((await desktopApiMode("on", kept.f.config, {}, kept.deps)).model, "fixture"));
  const picked = await setup({ model: "fixture" }, "api-mode-pick");
  await inDesktopHome(picked.f, async () => {
    assert.equal((await desktopApiMode("on", picked.f.config, { model: "fixture" }, picked.deps)).model, "fixture");
    assert.equal(picked.engine.state.writes.length, 1);
  });
});

test("on refuses a running app, a second on, a client configuration and a model we do not serve", mac, async () => {
  const running = await setup({}, "api-mode-running");
  running.deps.appRunning = async () => true;
  await inDesktopHome(running.f, async () => {
    await assert.rejects(() => desktopApiMode("on", running.f.config, {}, running.deps), /Quit ChatGPT first/);
    assert.equal(running.engine.state.writes.length, 0, "a refusal never writes");
  });
  const again = await setup({}, "api-mode-again");
  await inDesktopHome(again.f, async () => {
    await desktopApiMode("on", again.f.config, {}, again.deps);
    await assert.rejects(() => desktopApiMode("on", again.f.config, {}, again.deps), /already on/);
    assert.equal(again.engine.state.writes.length, 1, "the second call leaves the configuration alone");
  });
  const client = await desktopFixture("api-mode-client");
  await writePrivateJson(client.config, { version: 1, port: 3457, stateDirectory: client.state, clientOnly: true, providers: [] });
  await inDesktopHome(client, async () => {
    const opened = fakeEngine({});
    await assert.rejects(() => desktopApiMode("on", client.config, {}, harness(client, opened).deps), /needs a gateway running on this Mac/);
  });
  const unknown = await setup({}, "api-mode-unknown");
  await inDesktopHome(unknown.f, async () => {
    await assert.rejects(() => desktopApiMode("on", unknown.f.config, { model: "not-configured" }, unknown.deps), /not in this gateway's catalog/);
    assert.equal(unknown.engine.state.writes.length, 0);
    assert.equal(await readFile(apiModeCatalogPath(unknown.f.state), "utf8").catch(() => "gone"), "gone", "a bad model choice writes no file at all");
    assert.equal(await apiModeActive(unknown.f.state), false, "a refusal before the batch leaves no receipt");
  });
});

test("on refuses a foreign adapter override before it writes anything", mac, async () => {
  const f0 = await setup({}, "api-mode-foreign");
  f0.deps.cliPathOwner = async () => "other";
  await inDesktopHome(f0.f, async () => {
    await assert.rejects(() => desktopApiMode("on", f0.f.config, {}, f0.deps), /was not replaced/);
    assert.equal(f0.engine.state.writes.length, 0);
    assert.equal(f0.calls.length, 0, "a foreign value is never cleared");
  });
});

test("on detaches our own adapter, and puts everything back when the session refuses", mac, async () => {
  const ok = await setup({ model: "fixture" }, "api-mode-detach");
  ok.deps.cliPathOwner = async () => "gateway";
  await inDesktopHome(ok.f, async () => {
    const result = await desktopApiMode("on", ok.f.config, {}, ok.deps);
    assert.deepEqual(ok.calls, ["clear"]);
    assert.equal(result.cliPathCleared, true);
    assert.equal((await readFile(apiModeReceiptPath(ok.f.state), "utf8")).includes('"cliPathCleared": true'), true);
  });
  const bad = await setup({ model: "fixture" }, "api-mode-detach-fail");
  const originalProvider = { name: "Before API mode", base_url: "http://127.0.0.1:9/v1" };
  bad.engine.state.config.model_providers = { [apiModeProvider]: originalProvider };
  bad.deps.cliPathOwner = async () => "gateway";
  bad.deps.clearCliPath = async () => { throw new Error("launchctl said no"); };
  await inDesktopHome(bad.f, async () => {
    await assert.rejects(() => desktopApiMode("on", bad.f.config, {}, bad.deps), /launchctl said no/);
    const [first, second] = bad.engine.state.writes;
    assert.equal(first.edits.length, 4);
    assert.deepEqual(second.edits.map(e => (e as { keyPath: string }).keyPath).sort(), ["model", "model_catalog_json", "model_provider", `model_providers.${apiModeProvider}`]);
    assert.deepEqual(second.edits.find(e => (e as { keyPath: string }).keyPath === `model_providers.${apiModeProvider}`), { keyPath: `model_providers.${apiModeProvider}`, value: originalProvider, mergeStrategy: "replace" });
    assert.equal(await apiModeActive(bad.f.state), false, "the receipt is removed with the rollback");
    assert.deepEqual(bad.engine.state.config, { model: "fixture", model_providers: { [apiModeProvider]: originalProvider } }, "the engine ends where it started");
  });
});

test("a failed native write rolls the receipt away too", mac, async () => {
  const { f, engine, deps } = await setup({ model: "fixture" }, "api-mode-write-fail");
  engine.state.failWrite = "rejected";
  await inDesktopHome(f, async () => {
    await assert.rejects(() => desktopApiMode("on", f.config, {}, deps), /refused the write/);
    assert.equal(await apiModeActive(f.state), false, "the rollback retires the receipt it had written first");
    assert.deepEqual(engine.state.config, { model: "fixture" }, "nothing landed, so nothing needed undoing beyond the receipt");
    await flushTelemetry();
  });
});

test("a rejected batch does not roll back a concurrent provider table", mac, async () => {
  const { f, engine, deps } = await setup({ model: "fixture" }, "api-mode-version-conflict");
  await inDesktopHome(f, async () => {
    const concurrent = { name: "user's provider" };
    engine.state.beforeWrite = () => { engine.state.config.model_providers = { [apiModeProvider]: concurrent }; engine.state.version = "v2"; };
    await assert.rejects(() => desktopApiMode("on", f.config, {}, deps), /modified since last read/);
    assert.deepEqual(engine.state.config.model_providers, { [apiModeProvider]: concurrent }, "a batch rejected before its write never rolls back another editor's table");
    assert.equal(engine.state.writes.length, 0, "the rejected batch issued no compensating write");
    assert.equal(await apiModeActive(f.state), false, "the harmless pre-write receipt is retired");
  });
});

test("a failed uncertain rollback retains its receipt until off can recover", mac, async () => {
  const { f, engine, deps } = await setup({ model: "fixture" }, "api-mode-rollback-receipt");
  deps.cliPathOwner = async () => "gateway";
  deps.clearCliPath = async () => { engine.state.failWrite = "uncertain"; throw new Error("session clear failed"); };
  await inDesktopHome(f, async () => {
    await assert.rejects(() => desktopApiMode("on", f.config, {}, deps), /session clear failed/);
    assert.equal(await apiModeActive(f.state), true, "the receipt remains while the native configuration may still be active");
    assert.equal(engine.state.config.model_provider, apiModeProvider);
    const events = (await readTelemetry(f.state, 0)).filter(event => event.event === "desktop_api_mode");
    assert.deepEqual(events.map(event => [event.action, event.outcome, event.reason]).at(-1), ["on", "failed", "rollback"]);
    await desktopApiMode("off", f.config, {}, deps);
    assert.equal(await apiModeActive(f.state), false, "off retries the retained restoration");
    assert.deepEqual(engine.state.config, { model: "fixture" });
  });
});

test("off restores what API mode applied, keeps what the user changed, and clears what was absent", mac, async () => {
  const { f, engine, deps } = await setup({ model: "fixture", model_provider: "openai" }, "api-mode-off");
  await inDesktopHome(f, async () => {
    await desktopApiMode("on", f.config, {}, deps);
    engine.state.config.model = "user-chose-this";
    const result = await desktopApiMode("off", f.config, {}, deps);
    assert.deepEqual(result.changedSinceEnable, ["model"]);
    assert.equal(result.cliPathRestored, false, "nothing was registered, so nothing was handed back");
    const last = engine.state.writes.at(-1)!;
    assert.deepEqual(last.edits.map(e => (e as { keyPath: string }).keyPath).sort(), ["model_catalog_json", "model_provider", `model_providers.${apiModeProvider}`]);
    assert.deepEqual(engine.state.config, { model: "user-chose-this", model_provider: "openai" }, "a key the user moved is left alone and the provider table we created is gone");
    assert.equal(await apiModeActive(f.state), false);
    assert.equal(await readFile(apiModeReceiptPath(f.state), "utf8").catch(() => "gone"), "gone");
  });
});

test("off restores an original provider table and hands the desktop back only when registered", mac, async () => {
  const { f, engine, deps, calls } = await setup({ model: "fixture" }, "api-mode-off-registered");
  engine.state.config.model_providers = { [apiModeProvider]: { name: "someone else's" }, other: {} };
  deps.presetEnv = async () => { calls.push("preset"); return "set"; };
  await inDesktopHome(f, async () => {
    await desktopApiMode("on", f.config, {}, deps);
    assert.equal((JSON.parse(await readFile(apiModeReceiptPath(f.state), "utf8")) as { providerTableExisted: boolean }).providerTableExisted, true);
    await writePrivateJson(join(f.state, "desktop-registration.json"), { wrapper: join(f.state, "desktop-wrapper-abc"), registeredAt: "2026-10-25T10:00:00Z" });
    const result = await desktopApiMode("off", f.config, {}, deps);
    assert.equal(result.cliPathRestored, true);
    assert.deepEqual(calls, ["preset"]);
    const last = engine.state.writes.at(-1)!;
    assert.deepEqual(last.edits.find(e => (e as { keyPath: string }).keyPath === `model_providers.${apiModeProvider}`), { keyPath: `model_providers.${apiModeProvider}`, value: { name: "someone else's" }, mergeStrategy: "replace" });
    assert.deepEqual(engine.state.config.model_providers, { [apiModeProvider]: { name: "someone else's" }, other: {} });
  });
});

test("off reports the daemon preset result instead of claiming the path was restored", mac, async () => {
  const { f, deps } = await setup({ model: "fixture" }, "api-mode-preset-result");
  deps.presetEnv = async () => "failed";
  await inDesktopHome(f, async () => {
    await desktopApiMode("on", f.config, {}, deps);
    const result = await desktopApiMode("off", f.config, {}, deps);
    assert.equal(result.cliPathRestored, false);
    assert.equal(result.cliPathRestoreReason, "failed");
  });
});

test("off refuses a running app and an off that was never on", mac, async () => {
  const { f, deps } = await setup({}, "api-mode-off-refuse");
  await inDesktopHome(f, async () => {
    await assert.rejects(() => desktopApiMode("off", f.config, {}, deps), /not on/);
    await desktopApiMode("on", f.config, {}, deps);
    deps.appRunning = async () => true;
    await assert.rejects(() => desktopApiMode("off", f.config, {}, deps), /Quit ChatGPT first/);
    assert.equal(await apiModeActive(f.state), true, "the refusal keeps API mode on rather than half-leaving it");
  });
});

test("the adapter paths refuse while the receipt exists", mac, async () => {
  const { f, deps } = await setup({ model: "fixture" }, "api-mode-guard");
  await inDesktopHome(f, async () => {
    await desktopApiMode("on", f.config, {}, deps);
    await assert.rejects(() => macDesktop("register", f.config, f.app, false, f.exec), /API mode is on; run gateway desktop api-mode off first/);
    // The service's own restore at start reports the skip instead of failing the component.
    assert.deepEqual(await macDesktop("register", f.config, f.app, true, f.exec), { registered: false, activeForFutureLaunches: false, nativeConfigUntouched: true, skipped: "api_mode" });
    assert.equal(f.calls.some(call => call.startsWith("setenv CODEX_CLI_PATH")), false, "no restore may re-arm the adapter");
    await flushTelemetry();
    const presets = (await readTelemetry(f.state, 0)).filter(event => event.event === "desktop_api_mode" && event.action === "preset");
    assert.deepEqual(presets.map(event => event.outcome), ["skipped"], "the skip is recorded, once for the process");
  });
});

test("status says which mode the machine is in, from our own files", mac, async () => {
  const { f, engine, deps } = await setup({ model: "fixture" }, "api-mode-status");
  await inDesktopHome(f, async () => {
    assert.equal((await desktopApiMode("status", f.config, {}, deps)).mode, "neither");
    await desktopApiMode("on", f.config, {}, deps);
    const on = await desktopApiMode("status", f.config, {}, deps);
    assert.equal(on.mode, "api");
    assert.deepEqual({ receipt: on.receipt, nativeProviderMatches: on.nativeProviderMatches, catalogPresent: on.catalogPresent, registered: on.registered, appRunning: on.appRunning, cliPathOverride: on.cliPathOverride },
      { receipt: true, nativeProviderMatches: true, catalogPresent: true, registered: false, appRunning: false, cliPathOverride: "none" });
    engine.state.config.model_provider = "openai";
    assert.equal((await desktopApiMode("status", f.config, {}, deps)).nativeProviderMatches, false, "the answer is the engine's, not the receipt's");
    await desktopApiMode("off", f.config, {}, deps);
    assert.equal((await desktopApiMode("status", f.config, {}, deps)).mode, "neither");
  });
});

test("the catalog follows a configuration the running service adopts, and only while API mode is on", mac, async () => {
  const { f, deps } = await setup({ model: "fixture" }, "api-mode-catalog");
  await inDesktopHome(f, async () => {
    const config = await loadConfig(f.config);
    assert.equal(await refreshApiModeCatalog(config), false, "no receipt, no write");
    assert.equal(await readFile(apiModeCatalogPath(f.state), "utf8").catch(() => "gone"), "gone");
    await desktopApiMode("on", f.config, {}, deps);
    const before = await readFile(apiModeCatalogPath(f.state), "utf8");
    await writeFile(apiModeCatalogPath(f.state), '{"models":[]}\n');
    assert.equal(await refreshApiModeCatalog(config), true);
    assert.equal(await readFile(apiModeCatalogPath(f.state), "utf8"), before, "the applied configuration is written back");
    await rm(apiModeReceiptPath(f.state));
    assert.equal(await refreshApiModeCatalog(config), false);
  });
});

test("one event per API mode call, with fixed words only", mac, async () => {
  const { f, deps } = await setup({ model: "fixture" }, "api-mode-telemetry");
  await inDesktopHome(f, async () => {
    deps.appRunning = async () => true;
    await desktopApiMode("on", f.config, {}, deps).catch(() => undefined);
    deps.appRunning = async () => false;
    await desktopApiMode("on", f.config, {}, deps);
    await desktopApiMode("off", f.config, {}, deps);
    const events = (await readTelemetry(f.state, Date.now() - 60000)).filter(event => event.event === "desktop_api_mode");
    assert.deepEqual(events.map(event => ({ action: event.action, outcome: event.outcome, reason: event.reason })), [
      { action: "on", outcome: "refused", reason: "app_running" },
      { action: "on", outcome: "applied", reason: undefined },
      { action: "off", outcome: "applied", reason: undefined },
    ]);
  });
});

test("the shared provider builder keeps the adapter's settings exactly as they were", mac, async () => {
  const table = gatewayProviderTable("http://127.0.0.1:3457/v1", ["--config", "/state/gateway.json"]);
  assert.deepEqual(Object.keys(table), ["name", "base_url", "wire_api", "supports_websockets", "request_max_retries", "stream_idle_timeout_ms", "auth"]);
  const settings = codexSettings("alias", "/state/codex-models.json", "http://127.0.0.1:3457/v1", ["--config", "/state/gateway.json"]);
  // The adapter selects `gatefox` and registers `subscription_gateway` beside it, so chats saved before 1.8.0 resolve.
  assert.equal(settings.includes('model_provider = "gatefox"'), true);
  assert.equal(settings.includes("[model_providers.gatefox.auth]"), true);
  assert.equal(settings.includes("[model_providers.subscription_gateway.auth]"), true);
  assert.equal(table.name, "GateFox");
  assert.equal(settings.includes("stream_idle_timeout_ms = 90000"), true);
  assert.equal(settings.includes(`args = [${[...gatewayCommand().args, "token", "--config", "/state/gateway.json"].map(value => JSON.stringify(value)).join(", ")}]`), true);
});

/** A registration the daemon can preset: the receipt names a real, executable wrapper and the release runtime exists. */
async function registered(f: Fixture) {
  const { wrapper } = await prepareDesktop(f.config, f.app);
  await writePrivateJson(f.receipt, { wrapper, registeredAt: new Date().toISOString() });
  const runtime = join(f.root, "share/dist/cli.js");
  await mkdir(join(runtime, ".."), { recursive: true }); await writeFile(runtime, "");
  return { wrapper, runtime };
}

test("the login preset rechecks API mode inside the shared registration lock", mac, async () => {
  const { f } = await setup({}, "api-mode-preset-lock");
  await inDesktopHome(f, async () => {
    const { wrapper, runtime } = await registered(f);
    const script = envAgentScript(wrapper, runtime, { command: "/gateway", args: [] });
    assert.match(script, /exec '\/gateway' 'desktop-preset' '--state'/, "the login script delegates the guarded setter");
    assert.equal(script.includes("launchctl setenv"), false);
    let entered!: () => void; const holding = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
    const holder = withLoginRegistrationLock(f.state, async () => { entered(); await released; await writeFile(apiModeReceiptPath(f.state), "{}", { mode: 0o600 }); });
    await holding;
    const preset = presetDesktopEnv(f.state, f.exec, runtime);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.calls.some(call => call.startsWith("setenv")), false, "the setter waits with the transitions");
    release(); await holder;
    assert.equal(await preset, "skipped", "the receipt is checked again immediately before a setenv");
    assert.equal(f.calls.some(call => call.startsWith("setenv")), false);
  });
});

test("the standalone login script is guarded and migrated while API mode is enabled", mac, async () => {
  const { f, deps } = await setup({ model: "fixture" }, "api-mode-login-agent");
  await inDesktopHome(f, async () => {
    const { wrapper } = await registered(f); const runtime = agentRuntimeFile();
    await mkdir(join(runtime, ".."), { recursive: true }); await writeFile(runtime, "");
    const guarded = envAgentScript(wrapper); const legacy = guarded.replace(`[ -e '${join(f.state, "api-mode.json")}' ] && exit 0\n`, "");
    await writeFile(envAgentScriptPath(f.state), legacy, { mode: 0o700 });
    await writeFile(join(f.home, "Library/LaunchAgents", `${envAgentLabel}.plist`), envAgentPlist(envAgentScriptPath(f.state)));
    await desktopApiMode("on", f.config, {}, deps);
    assert.equal(await readFile(envAgentScriptPath(f.state), "utf8"), guarded, "on upgrades an owned old script");
    const probe = join(f.root, "login-env-probe");
    await writeFile(probe, guarded.replace(/^exec .*$/m, `exec printf %s '${wrapper}'`), { mode: 0o700 });
    const run = async () => (await promisify(execFile)("/bin/sh", [probe])).stdout;
    assert.equal(await run(), "", "the receipt makes a login set nothing");
    await desktopApiMode("off", f.config, {}, deps);
    assert.equal(await run(), wrapper, "without the receipt the generated script sets the wrapper");
  });
});

test("API mode validates a requested model before changing an owned login script", mac, async () => {
  const { f, deps, engine } = await setup({ model: "fixture" }, "api-mode-invalid-model-agent");
  await inDesktopHome(f, async () => {
    const { wrapper } = await registered(f); const guarded = envAgentScript(wrapper);
    const legacy = guarded.replace(`[ -e '${join(f.state, "api-mode.json")}' ] && exit 0\n`, "");
    await writeFile(envAgentScriptPath(f.state), legacy, { mode: 0o700 });
    await writeFile(join(f.home, "Library/LaunchAgents", `${envAgentLabel}.plist`), envAgentPlist(envAgentScriptPath(f.state)));
    await assert.rejects(() => desktopApiMode("on", f.config, { model: "not-configured" }, deps), /not in this gateway's catalog/);
    assert.equal(await readFile(envAgentScriptPath(f.state), "utf8"), legacy);
    assert.equal(engine.state.writes.length, 0);
    assert.equal(await readFile(apiModeReceiptPath(f.state), "utf8").catch(() => "gone"), "gone");
  });
});

test("API mode refuses a gateway-owned legacy direct-launchctl agent before writes", mac, async () => {
  const { f, deps, engine } = await setup({ model: "fixture" }, "api-mode-legacy-agent");
  await inDesktopHome(f, async () => {
    const { wrapper } = await registered(f);
    const legacy = `<?xml version="1.0"?>\n<!-- Managed by subscription-gateway desktop-env -->\n<plist version="1.0"><dict><key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>CODEX_CLI_PATH</string><string>${wrapper}</string></array></dict></plist>`;
    await writeFile(join(f.home, "Library/LaunchAgents", `${envAgentLabel}.plist`), legacy);
    await assert.rejects(() => desktopApiMode("on", f.config, {}, deps), /too old for API mode/);
    assert.equal(engine.state.writes.length, 0);
    assert.equal(await readFile(apiModeReceiptPath(f.state), "utf8").catch(() => "gone"), "gone");
  });
});

test("every path that arms the adapter stands down while the receipt exists, and only while it does", mac, async () => {
  const { f, deps, engine } = await setup({ model: "fixture" }, "api-mode-preset-guard");
  await inDesktopHome(f, async () => {
    const { wrapper, runtime } = await registered(f);
    // Off: the daemon's first step presets, and the service's restore registers.
    assert.equal(await presetDesktopEnv(f.state, f.exec, runtime), "set");
    f.calls.length = 0;
    assert.equal((await macDesktop("register", f.config, f.app, true, f.exec)).registered, true);
    assert.ok(f.calls.includes(`setenv ${PATH_KEY} ${wrapper}`), "with API mode off the adapter is armed as usual");
    await desktopApiMode("on", f.config, {}, { ...deps, cliPathOwner: async () => "gateway" });
    assert.equal(engine.state.writes.length, 1);
    // On: both hold back, and neither may put the wrapper back into the session.
    f.calls.length = 0;
    assert.equal(await presetDesktopEnv(f.state, f.exec, runtime), "skipped", "the daemon preset stands down");
    const restored = await macDesktop("register", f.config, f.app, true, f.exec);
    assert.equal(restored.registered, false);
    assert.equal(restored.skipped, "api_mode");
    assert.equal(f.calls.some(call => call.startsWith("setenv")), false, "nothing re-arms the adapter while API mode owns the desktop");
    await assert.rejects(() => macDesktop("register", f.config, f.app, false, f.exec), /API mode is on/);
    await desktopApiMode("off", f.config, {}, deps);
    f.calls.length = 0;
    assert.equal(await presetDesktopEnv(f.state, f.exec, runtime), "set", "and both are back once it is off");
    await flushTelemetry();
    // Two paths stood down here and neither logged: the earlier guard test already spent this process's one record.
    const presets = (await readTelemetry(f.state, 0)).filter(event => event.event === "desktop_api_mode" && event.action === "preset");
    assert.deepEqual(presets.map(event => event.outcome), []);
  });
});
