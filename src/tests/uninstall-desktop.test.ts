import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uninstallGateway, uninstallResult, type UninstallDeps } from "../uninstall.js";

// The result shape is the whole uninstall contract, so it is checked here as a pure helper. Only the pure-helper
// tests below reach neither launchctl, the Trash, nor the filesystem; the `uninstallGateway` tests run the real
// path, but through fake commands and a temp HOME.
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
function fakes(desktopResult: Record<string, unknown> = {}, runDesktop?: (action: string) => Promise<Record<string, unknown>>) {
  const calls: string[] = [];
  const record = (name: string) => async (): Promise<Record<string, unknown>> => { calls.push(name); return {}; };
  const deps: UninstallDeps = {
    macService: record("service"), macNative: record("native"), macSsh: record("ssh"), macTunnel: record("tunnel"),
    macDesktop: async (action: string) => { calls.push(`desktop:${action}`); return runDesktop ? runDesktop(action) : desktopResult; },
  };
  return { calls, deps };
}

/**
 * The installer's own layout in a temp HOME, which uninstallGateway verifies before it removes anything: a
 * managed command beside `<root>/../share/subscription-gateway/.gateway-installation`, and an empty
 * LaunchAgents directory. `install` rebuilds the managed files for a second uninstall, and `cleanup` belongs in
 * the test's `finally` so a temp HOME never leaks into the next test.
 */
async function installedGateway() {
  const home = await mkdtemp(join(tmpdir(), "gateway-uninstall-"));
  const command = join(home, "bin", "gateway");
  const saved = { HOME: process.env.HOME, installed: process.env.GATEWAY_INSTALLED, command: process.env.GATEWAY_COMMAND };
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
    assert.deepEqual(kept.calls, ["desktop:status", "service", "native", "desktop:unregister", "ssh"]);
    assert.equal(await readFile(gateway.command, "utf8").then(() => true, () => false), false, "the command moved to the Trash");

    // A second uninstall of a re-installed gateway whose unregister cleared everything reports no warning.
    await rm(join(gateway.home, ".Trash"), { recursive: true, force: true }); await gateway.install();
    const cleared = fakes({});
    assert.equal("legacyForceCliKept" in await uninstallGateway(gateway.config, cleared.deps), false);
    assert.deepEqual(cleared.calls, ["desktop:status", "service", "native", "desktop:unregister", "ssh"]);
  } finally { await gateway.cleanup(); }
});

test("a desktop status probe that fails stops the uninstall before anything is removed", async () => {
  const gateway = await installedGateway();
  try {
    // Status is the first call, so the failure must reach the operator with the install still intact.
    const failed = fakes({}, async (action) => {
      if (action === "status") throw new Error("The desktop session could not be read");
      return {};
    });
    await assert.rejects(() => uninstallGateway(gateway.config, failed.deps), /desktop session could not be read/);
    assert.deepEqual(failed.calls, ["desktop:status"], "a failed probe must not remove the service, native files, or SSH");
    assert.equal(await readFile(gateway.command, "utf8").then(() => true, () => false), true, "the command is still installed");
  } finally { await gateway.cleanup(); }
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
    assert.deepEqual(failed.calls, ["desktop:status", "service", "native", "desktop:unregister"], "SSH never runs after it");
  } finally { await gateway.cleanup(); }
});
