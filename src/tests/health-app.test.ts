import test from "node:test";
import assert from "node:assert/strict";
import { appEnginePath, appInfoPlist, appPathFromPlan, detectAppChange, defaultAppPath, readAppInfo } from "../health-app.js";
import type { AppInfo } from "../health-types.js";
import type { ServicePlan } from "../service-plan.js";

const at = "2026-10-16T09:00:00.000Z";

/** A plan whose desktop component launches the given app, if any. */
function plan(app?: string): ServicePlan {
  const args = app === undefined ? ["--config", "/c.json"] : ["--config", "/c.json", "--app", app];
  return { version: 1, config: "/c.json", components: [{ id: "desktop", kind: "desktop", command: "/bin/gateway", args, log: "/log" }] } as ServicePlan;
}

test("the app path comes from the desktop plan or the standard location", () => {
  assert.equal(appPathFromPlan(undefined), defaultAppPath);
  assert.equal(appPathFromPlan(plan()), defaultAppPath);
  assert.equal(appPathFromPlan(plan("/Apps/ChatGPT.app")), "/Apps/ChatGPT.app");
  // A relative or missing value is not an app path; the standard location stands.
  assert.equal(appPathFromPlan(plan("ChatGPT.app")), defaultAppPath);
});

test("the engine and plist live under the app bundle", () => {
  assert.equal(appEnginePath("/Apps/ChatGPT.app"), "/Apps/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
  assert.equal(appInfoPlist("/Apps/ChatGPT.app"), "/Apps/ChatGPT.app/Contents/Info.plist");
});

test("a missing app is absent, and no command runs", () => {
  const calls: string[] = [];
  return readAppInfo("/nope/ChatGPT.app", { exists: async () => false, exec: async (command) => { calls.push(command); return "x"; } })
    .then(info => { assert.equal(info.state, "absent"); assert.equal(info.bundle, null); assert.equal(info.engine, null); assert.deepEqual(calls, []); });
});

test("found app pairs read the engine version and the bundle string", async () => {
  const info = await readAppInfo("/Apps/ChatGPT.app", {
    exists: async () => true,
    exec: async (command, args) => {
      if (command.endsWith("codex")) { assert.deepEqual(args, ["--version"]); return "codex-cli 0.99.1\n"; }
      assert.equal(command, "/usr/libexec/PlistBuddy");
      assert.deepEqual(args, ["-c", "Print CFBundleShortVersionString", "/Apps/ChatGPT.app/Contents/Info.plist"]);
      return "26.10.1\n";
    },
  });
  assert.deepEqual(info, { state: "found", path: "/Apps/ChatGPT.app", enginePath: appEnginePath("/Apps/ChatGPT.app"), bundle: "26.10.1", engine: "0.99.1" });
});

test("a version field that is not a token reads as unknown", async () => {
  const info = await readAppInfo("/Apps/ChatGPT.app", {
    exists: async () => true,
    exec: async (command) => command.endsWith("codex") ? "0.99.1 (fake) /path/to/bin\n" : "File Doesn't Exist, Will Create: /x",
  });
  assert.deepEqual([info.bundle, info.engine], [null, null]);
});

test("a failing command leaves its half of the pair unknown", async () => {
  const info = await readAppInfo("/Apps/ChatGPT.app", {
    exists: async () => true,
    exec: async (command) => { if (command.endsWith("codex")) throw new Error("Exec failed"); return "1.2.3"; },
  });
  assert.deepEqual([info.state, info.bundle, info.engine], ["found", "1.2.3", null]);
});

test("change detection: first seen, unchanged, changed, and absent", () => {
  const found = (bundle: string | null, engine: string | null): AppInfo => ({ state: "found", path: "/a", enginePath: "/e", bundle, engine });
  const absent: AppInfo = { state: "absent", path: "/a", enginePath: "/e", bundle: null, engine: null };
  // Nothing recorded yet: this pair is news.
  assert.deepEqual(detectAppChange(undefined, found("1", "2"), at), { changed: true, record: { bundle: "1", engine: "2", seenAt: at } });
  assert.equal(detectAppChange({ bundle: "1", engine: "2", seenAt: at }, found("1", "2"), at).changed, false);
  assert.equal(detectAppChange({ bundle: "1", engine: "2", seenAt: at }, found("1", "3"), at).changed, true);
  assert.equal(detectAppChange({ bundle: "1", engine: "2", seenAt: at }, found(null, "2"), at).changed, true);
  // An absent app is never "changed", and it does not overwrite what was recorded.
  const kept = { bundle: "1", engine: "2", seenAt: at };
  assert.deepEqual(detectAppChange(kept, absent, "2026-10-17T09:00:00.000Z"), { changed: false, record: kept });
  assert.equal(detectAppChange(undefined, absent, at).changed, false);
});
