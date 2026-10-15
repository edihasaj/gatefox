import test from "node:test";
import assert from "node:assert/strict";
import { uninstallResult } from "../uninstall.js";

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
