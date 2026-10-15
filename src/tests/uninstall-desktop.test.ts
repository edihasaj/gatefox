import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uninstallGateway, uninstallResult, type UninstallDeps } from "../uninstall.js";

// The result shape is the whole uninstall contract, so it is checked here as a pure helper. Nothing in this
// file reaches launchctl, the Trash, or the filesystem; see `the helper is pure and never calls launchctl`.
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

/** The uninstaller's collaborators, replaced by recorders so the test proves the pass-through, not launchctl. */
function fakes(desktopResult: Record<string, unknown>) {
  const calls: string[] = [];
  const record = (name: string, result: Record<string, unknown> = {}) =>
    async (): Promise<Record<string, unknown>> => { calls.push(name); return result; };
  const deps: UninstallDeps = {
    macService: record("service"), macNative: record("native"), macDesktop: record("desktop", desktopResult),
    macSsh: record("ssh"), macTunnel: record("tunnel"),
  };
  return { calls, deps };
}

test("uninstallGateway carries unregister's kept-flag warning through the whole path", async () => {
  const home = await mkdtemp(join(tmpdir(), "gateway-uninstall-"));
  const config = join(home, "gateway.json");
  const command = join(home, "bin", "gateway");
  const saved = { HOME: process.env.HOME, installed: process.env.GATEWAY_INSTALLED, command: process.env.GATEWAY_COMMAND };
  // The installer's own layout, which uninstallGateway verifies before it removes anything: a managed command
  // beside `<root>/../share/subscription-gateway/.gateway-installation`, and an empty LaunchAgents directory.
  const install = async () => {
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(command, "#!/bin/sh\n# Managed by subscription-gateway installer\n");
    await mkdir(join(home, "share", "subscription-gateway"), { recursive: true });
    await writeFile(join(home, "share", "subscription-gateway", ".gateway-installation"), "subscription-gateway\n");
  };
  await install(); await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  process.env.HOME = home; process.env.GATEWAY_INSTALLED = "1"; process.env.GATEWAY_COMMAND = command;
  try {
    const kept = fakes({ registered: false, legacyForceCliKept: true });
    const result = await uninstallGateway(config, kept.deps);
    assert.equal(result.legacyForceCliKept, true, "the kept legacy value is the operator's remaining step");
    for (const key of BASE) assert.equal(result[key], true, `${key} must stay true`);
    // The empty LaunchAgents directory means no tunnel plist, so no tunnel uninstall; order is the real one.
    assert.deepEqual(kept.calls, ["service", "native", "desktop", "ssh"]);
    assert.equal(await readFile(command, "utf8").then(() => true, () => false), false, "the command moved to the Trash");

    // A second uninstall of a re-installed gateway whose unregister cleared everything reports no warning.
    await rm(join(home, ".Trash"), { recursive: true, force: true }); await install();
    const cleared = fakes({});
    assert.equal("legacyForceCliKept" in await uninstallGateway(config, cleared.deps), false);
    assert.deepEqual(cleared.calls, ["service", "native", "desktop", "ssh"]);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.installed === undefined) delete process.env.GATEWAY_INSTALLED; else process.env.GATEWAY_INSTALLED = saved.installed;
    if (saved.command === undefined) delete process.env.GATEWAY_COMMAND; else process.env.GATEWAY_COMMAND = saved.command;
    await rm(home, { recursive: true, force: true });
  }
});
