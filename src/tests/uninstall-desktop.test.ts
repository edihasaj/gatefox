import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uninstallGateway, uninstallFailure, uninstallResult, type UninstallDeps } from "../uninstall.js";
import { macDesktop, planDesktopUnregister } from "../mac-desktop.js";
import { writePrivateJson } from "../config.js";
import { desktopFixture } from "./desktop-fixture.js";

const mac = { skip: process.platform !== "darwin" };

// The result shape and the failure wording are the uninstall contract, so both are checked here as pure helpers.
// Only the pure-helper tests below reach neither launchctl, the Trash, nor the filesystem; the `uninstallGateway`
// tests run the real path, but through fake commands and a temp HOME.
const BASE = ["uninstalled", "installationMovedToTrash", "credentialsPreserved", "nativeConfigUntouched"] as const;

test("a kept legacy FORCE_CLI flag is passed through to the operator", () => {
  assert.equal(uninstallResult({ legacyForceCliKept: true }).legacyForceCliKept, true);
});

test("no kept flag from unregister means no warning key", () => {
  for (const desktop of [{}, { legacyForceCliKept: false }, { legacyForceCliKept: "yes" }]) {
    assert.equal("legacyForceCliKept" in uninstallResult(desktop), false, JSON.stringify(desktop));
  }
});

test("the base uninstall promises hold for every unregister result", () => {
  for (const desktop of [{}, { legacyForceCliKept: true }, { legacyForceCliKept: false }, { legacyForceCliKept: "yes" }]) {
    const result = uninstallResult(desktop);
    for (const key of BASE) assert.equal(result[key], true, `${key} must stay true for ${JSON.stringify(desktop)}`);
  }
});

test("the helper is pure and never calls launchctl", () => {
  const source = uninstallResult.toString();
  for (const forbidden of ["launchctl", "execFile", "spawn", "await", "import("]) {
    assert.equal(source.includes(forbidden), false, `uninstallResult must never use ${forbidden}`);
  }
  // Only the keys the contract names, so a stray unregister field can never leak into the report.
  assert.deepEqual(Object.keys(uninstallResult({ legacyForceCliKept: true, keptPath: "/secret" })),
    [...BASE, "legacyForceCliKept"]);
});

/**
 * The uninstaller's collaborators, replaced by recorders so the test proves the pass-through, not launchctl.
 * Each desktop call is recorded with the action it was given, and `runDesktop` can fail or answer one action
 * instead of returning `desktopResult` for every one.
 */
function fakes(desktopResult: Record<string, unknown> = {}, runDesktop?: (action: string) => Promise<Record<string, unknown>>, runPlan?: () => Promise<Record<string, unknown>>) {
  const calls: string[] = [];
  const record = (name: string) => async (): Promise<Record<string, unknown>> => { calls.push(name); return {}; };
  const deps: UninstallDeps = {
    macService: record("service"), macNative: record("native"), macSsh: record("ssh"), macTunnel: record("tunnel"),
    macDesktop: async (action: string) => { calls.push(`desktop:${action}`); return runDesktop ? runDesktop(action) : desktopResult; },
    planDesktopUnregister: async () => { calls.push("desktop:plan"); return runPlan ? runPlan() : {}; },
  };
  return { calls, deps };
}

/**
 * The installer's own layout in a temp HOME, which uninstallGateway verifies before it removes anything: a
 * managed command beside `<root>/../share/subscription-gateway/.gateway-installation`, and an empty
 * LaunchAgents directory. `install` rebuilds the managed files for a second uninstall, and `cleanup` belongs in
 * the test's `finally` so a temp HOME never leaks into the next test.
 * The layout is the macOS one, so it also pins the platform to darwin: off macOS the uninstaller skips the
 * desktop preflight entirely, and every order asserted below would change with the host that runs the test.
 * A test that needs another platform overrides the pin after this helper has run and restores it before cleanup.
 */
async function installedGateway() {
  const home = await mkdtemp(join(tmpdir(), "gateway-uninstall-"));
  const command = join(home, "bin", "gateway");
  const saved = { HOME: process.env.HOME, installed: process.env.GATEWAY_INSTALLED, command: process.env.GATEWAY_COMMAND, platform: Object.getOwnPropertyDescriptor(process, "platform") };
  Object.defineProperty(process, "platform", { value: "darwin", enumerable: true, configurable: true });
  const install = async () => {
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(command, "#!/bin/sh\n# Managed by subscription-gateway installer\n");
    await mkdir(join(home, "share", "subscription-gateway"), { recursive: true });
    await writeFile(join(home, "share", "subscription-gateway", ".gateway-installation"), "subscription-gateway\n");
  };
  await install(); await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  process.env.HOME = home; process.env.GATEWAY_INSTALLED = "1"; process.env.GATEWAY_COMMAND = command;
  const cleanup = async () => {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.installed === undefined) delete process.env.GATEWAY_INSTALLED; else process.env.GATEWAY_INSTALLED = saved.installed;
    if (saved.command === undefined) delete process.env.GATEWAY_COMMAND; else process.env.GATEWAY_COMMAND = saved.command;
    if (saved.platform) Object.defineProperty(process, "platform", saved.platform);
    await rm(home, { recursive: true, force: true });
  };
  return { home, command, config: join(home, "gateway.json"), install, cleanup };
}

test("uninstallGateway carries unregister's kept-flag warning through the whole path", async () => {
  const gateway = await installedGateway();
  try {
    const kept = fakes({ registered: false, legacyForceCliKept: true });
    const result = await uninstallGateway(gateway.config, kept.deps);
    assert.equal(result.legacyForceCliKept, true, "the kept legacy value is the operator's remaining step");
    for (const key of BASE) assert.equal(result[key], true, `${key} must stay true`);
    // The empty LaunchAgents directory means no tunnel plist, so no tunnel uninstall; order is the real one.
    assert.deepEqual(kept.calls, ["desktop:plan", "service", "native", "desktop:unregister", "ssh"]);
    assert.equal(await readFile(gateway.command, "utf8").then(() => true, () => false), false, "the command moved to the Trash");

    // A second uninstall of a re-installed gateway whose unregister cleared everything reports no warning.
    await rm(join(gateway.home, ".Trash"), { recursive: true, force: true }); await gateway.install();
    const cleared = fakes({});
    assert.equal("legacyForceCliKept" in await uninstallGateway(gateway.config, cleared.deps), false);
    assert.deepEqual(cleared.calls, ["desktop:plan", "service", "native", "desktop:unregister", "ssh"]);
  } finally { await gateway.cleanup(); }
});

test("a desktop unregister plan that fails stops the uninstall before anything is removed", async () => {
  const gateway = await installedGateway();
  try {
    // The plan is the first desktop call, and it reads what unregister would change without changing it, so a
    // failure reaches the operator with the install still intact.
    const failed = fakes({}, undefined, async () => { throw new Error("The desktop session could not be read"); });
    const message = await uninstallGateway(gateway.config, failed.deps).then(
      () => "uninstallGateway resolved", (cause: unknown) => cause instanceof Error ? cause.message : String(cause));
    assert.notEqual(message, "uninstallGateway resolved", "a failed plan must fail the whole uninstall");
    assert.match(message, /unregister preflight failed before anything was removed/, "the message says nothing is gone yet");
    assert.match(message, /desktop session could not be read/, "and names the cause");
    assert.match(message, /resolve that cause, then rerun `gateway uninstall`/i, "and gives the next step");
    assert.deepEqual(failed.calls, ["desktop:plan"], "a failed plan must not remove the service, native files, or SSH");
    assert.equal(await readFile(gateway.command, "utf8").then(() => true, () => false), true, "the command is still installed");
  } finally { await gateway.cleanup(); }
});

/** The refusal this preflight exists for: the plist is not ours, so nothing of ours may go. */
test("an unmanaged desktop LaunchAgent is refused before the service or native files are removed", async () => {
  const gateway = await installedGateway();
  try {
    const refused = fakes({}, undefined, async () => { throw new Error("Refusing to change an unmanaged desktop LaunchAgent"); });
    await assert.rejects(() => uninstallGateway(gateway.config, refused.deps), /unmanaged desktop LaunchAgent/);
    assert.deepEqual(refused.calls, ["desktop:plan"], "the refusal lands while every component is still installed");
    assert.equal(await readFile(gateway.command, "utf8").then(() => true, () => false), true, "the command is still installed");
  } finally { await gateway.cleanup(); }
});

/**
 * A JSON parse failure quotes the file it read, so its message never reaches the operator: both desktop steps
 * report it as invalid data, with the cause kept underneath for anyone who can read the files.
 */
test("a corrupt receipt is reported as invalid JSON, never as the text that failed to parse", async () => {
  const sentinel = "a-sentinel-from-the-file-9c1f";
  for (const stage of ["preflight", "unregister"] as const) {
    const gateway = await installedGateway();
    try {
      const broken = async (): Promise<never> => { throw new SyntaxError(`Unexpected token <, "<!${sentinel}-->" is not valid JSON`); };
      const recorder = stage === "preflight" ? fakes({}, undefined, broken) : fakes({}, () => broken());
      const error = await uninstallGateway(gateway.config, recorder.deps).then(() => undefined, (cause: unknown) => cause as Error);
      assert.ok(error, stage + ": a parse failure must fail the uninstall");
      assert.match(error.message, /Invalid JSON data/, stage);
      assert.equal(error.message.includes(sentinel), false, stage + ": no file snippet reaches the output");
      assert.ok(error.cause instanceof SyntaxError, stage + ": the real failure stays reachable as the cause");
      assert.deepEqual(recorder.calls, stage === "preflight"
        ? ["desktop:plan"]
        : ["desktop:plan", "service", "native", "desktop:unregister"], stage + ": it stops where that step sits");
    } finally { await gateway.cleanup(); }
  }
});

test("the failure helper names the step, what is still installed, and never the JSON text", () => {
  const message = uninstallFailure(new SyntaxError('Unexpected token <, "<!-- managed -->" is not valid JSON'), "preflight").message;
  assert.equal(message, 'Desktop unregister preflight failed before anything was removed: Invalid JSON data. Resolve that cause, then rerun `gateway uninstall`.');
  assert.equal(message.includes("<!--"), false, "the quoted snippet never survives the helper");
  assert.match(uninstallFailure(new Error("boom"), "unregister").message, /^Desktop unregister failed after the service and native components were already removed: boom\./);
  assert.match(uninstallFailure("not an error", "preflight").message, /The desktop registration could not be removed/);
});

test("a failed unregister says what the uninstall already removed and skips SSH", async () => {
  const gateway = await installedGateway();
  try {
    const failed = fakes({}, async (action) => {
      if (action === "unregister") throw new Error("boom");
      return {};
    });
    const message = await uninstallGateway(gateway.config, failed.deps).then(
      () => "uninstallGateway resolved", (cause: unknown) => cause instanceof Error ? cause.message : String(cause));
    assert.notEqual(message, "uninstallGateway resolved", "a failed unregister must fail the whole uninstall");
    for (const pattern of [/desktop unregister/i, /already removed/i, /boom/, /gateway uninstall/]) {
      assert.match(message, pattern, "the message names the step, what is gone, the cause, and the remedy");
    }
    assert.match(message, /resolve that cause, then rerun `gateway uninstall`/i, "and the next step");
    assert.deepEqual(failed.calls, ["desktop:plan", "service", "native", "desktop:unregister"], "SSH never runs after it");
  } finally { await gateway.cleanup(); }
});

/** The unified service's plan, which `gateway service uninstall` moves to the Trash. */
const servicePlan = (state: string, config: string, gateway: string) => writePrivateJson(join(state, "service-plan.json"),
  { version: 1, config, components: [{ id: "inference", kind: "inference", command: gateway, args: [], log: join(state, "inference.log") }] });

/**
 * A refusal the preflight must not make: a Mac that still carries its unified service plan. The plan runs first,
 * and the service uninstall that follows is the step that trashes that file, so the preflight must not refuse the
 * removal it is describing. Real plan and real desktop unregister run over the fixture's launchctl seam; only the
 * service step is faked, and it does with the plan file what `macService("uninstall")` does: moves it aside.
 */
test("the uninstaller plans past a service plan its service step then removes", mac, async () => {
  const gateway = await installedGateway();
  const f = await desktopFixture("uninstall-desktop");
  const calls: string[] = [];
  try {
    await servicePlan(f.state, f.config, f.gateway);
    const deps: UninstallDeps = {
      macService: async () => { calls.push("service"); await rename(join(f.state, "service-plan.json"), join(f.root, "trashed-service-plan.json")); return {}; },
      macNative: async () => { calls.push("native"); return {}; },
      macSsh: async () => { calls.push("ssh"); return {}; },
      macTunnel: async () => { calls.push("tunnel"); return {}; },
      macDesktop: async (action) => { calls.push(`desktop:${action}`); return macDesktop(action, f.config, f.app, false, f.exec); },
      planDesktopUnregister: async (configPath, exec, options) => {
        calls.push("desktop:plan");
        assert.equal(configPath, gateway.config, "the uninstaller plans the config it was given");
        assert.equal(exec, undefined, "and leaves the desktop launchctl seam to the desktop");
        assert.equal(options?.serviceRemovedFirst, true, "saying up front that the service goes first");
        return planDesktopUnregister(f.config, f.exec, options);
      },
    };
    assert.equal((await uninstallGateway(gateway.config, deps)).uninstalled, true, "the uninstall finishes instead of refusing");
    assert.deepEqual(calls, ["desktop:plan", "service", "native", "desktop:unregister", "ssh"]);
    assert.equal(await readFile(join(f.state, "service-plan.json"), "utf8").then(() => true, () => false), false, "the service step, not the desktop step, took that plan out of the state directory");
    assert.equal(await readFile(join(f.root, "trashed-service-plan.json"), "utf8").then(() => true, () => false), true, "and the file it moved is the one the plan had refused on");
    assert.deepEqual(JSON.parse(await readFile(f.receipt, "utf8")), {}, "and the real unregister cleared the receipt it found");
    assert.equal(f.calls.every(call => call.startsWith("getenv ")), true, "the desktop path only read this session: " + f.calls.join(" | "));
  } finally { await gateway.cleanup(); await rm(f.root, { recursive: true, force: true }); }
});

/**
 * Off macOS there is no desktop registration to plan, so the uninstaller must not let the desktop answer for the
 * platform. The service step's own message about what it supports is what the operator should see.
 */
test("a non-macOS host skips the desktop preflight and hears it from the service step", async () => {
  const gateway = await installedGateway();
  const saved = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { value: "win32", enumerable: true, configurable: true });
    const recorder = fakes();
    recorder.deps.macService = async () => {
      recorder.calls.push("service");
      throw new Error("User service setup currently supports macOS; use gateway serve on other systems");
    };
    const message = await uninstallGateway(gateway.config, recorder.deps).then(
      () => "uninstallGateway resolved", (cause: unknown) => cause instanceof Error ? cause.message : String(cause));
    assert.equal(message, "User service setup currently supports macOS; use gateway serve on other systems", "the service answers for the platform, unwrapped");
    assert.deepEqual(recorder.calls, ["service"], "no desktop plan ran on a host with no macOS session");
    assert.equal(await readFile(gateway.command, "utf8").then(() => true, () => false), true, "and the install is left alone");
  } finally {
    if (saved) Object.defineProperty(process, "platform", saved);
    await gateway.cleanup();
  }
});
