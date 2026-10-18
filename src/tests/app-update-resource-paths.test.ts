import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import test from "node:test";
import { appResourceAncestorAllowed, safeAncestors } from "../app-updates/private-fs.js";

test("only the standard admin Applications root is an app-resource exception", async () => {
  const applications = await lstat("/Applications").catch(() => undefined);
  if (!applications || process.getgroups?.().includes(80) !== true) return;
  assert.equal(appResourceAncestorAllowed("/Applications", applications, false), true);
  assert.equal(appResourceAncestorAllowed("/OtherApplications", applications, false), false);
  assert.equal(appResourceAncestorAllowed("/Applications/Harness Gateway.app", applications, true), false);
});

test("private updater state keeps the strict shared-directory refusal", async () => {
  if (!await lstat("/Applications").catch(() => undefined)) return;
  await assert.rejects(safeAncestors("/Applications"), /unsafe/);
});
