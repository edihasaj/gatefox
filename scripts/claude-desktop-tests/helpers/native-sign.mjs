// Shared harness for the native-trial signing tests: fake task roots and homes, a scripted codesign/plutil, and sample entitlements.
// Not a test file (the npm glob only matches *.test.mjs in the parent directory).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OFFICIAL_APP, SIGNING_KEYCHAIN, SignError } from "../../claude-native-trial/sign.mjs";

export const HAS_PLUTIL = process.platform === "darwin" && existsSync("/usr/bin/plutil");
export const ORIGINAL = {
  "com.apple.application-identifier": "TEAM.com.example.app",
  "com.apple.developer.team-identifier": "TEAM",
  "com.apple.security.cs.allow-jit": true,
  "com.apple.security.device.camera": true,
  "keychain-access-groups": ["TEAM.a", "TEAM.b"],
  "com.apple.security.automation.apple-events": true,
  "custom.nested": { list: [1, "two", { three: false }], text: "x" },
};

export function taskRoot({ mode = 0o700 } = {}) {
  const task = mkdtempSync("/private/tmp/claude-native-picker.");
  chmodSync(task, mode);
  const app = join(task, "Claude Native Trial.app");
  mkdirSync(app, { mode: 0o700 });
  return { task, app };
}
export const plutil = (args, input) => {
  const result = spawnSync("/usr/bin/plutil", args, { encoding: "utf8", input });
  if (result.status !== 0) throw new Error(`plutil failed: ${result.stderr}`);
  return { stdout: result.stdout, stderr: "" };
};
export const xmlOf = object => plutil(["-convert", "xml1", "-o", "-", "-"], JSON.stringify(object)).stdout;

/** A scripted codesign/plutil. The copy's entitlements are replaced by whatever the main signing call is given. */
export function fakeExec(copy, { entitlements = ORIGINAL, officialFails = false, mutate } = {}) {
  const calls = [];
  let current = xmlOf(entitlements);
  const exec = (file, args, options = {}) => {
    calls.push({ file, args: [...args], input: options.input });
    if (file === "/usr/bin/plutil") return plutil(args, options.input);
    assert.equal(file, "/usr/bin/codesign");
    if (args[0] === "--verify") {
      if (officialFails && args.at(-1) === OFFICIAL_APP) throw new SignError("official signature is not valid");
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "-dv") return { stdout: "", stderr: "Identifier=com.anthropic.claudefordesktop\nCodeDirectory v=20500 size=458 flags=0x10000(runtime) hashes=3+7 location=embedded\n" };
    if (args[0] === "-d") return { stdout: current, stderr: "" };
    if (args[0] === "--force" && args.includes("--entitlements")) current = readFileSync(args[args.indexOf("--entitlements") + 1], "utf8");
    mutate?.(args);
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

export const FINGERPRINT = "D8A977A01A3CEE4199F5775C6101769099D48E6D";
export function fakeHome({ mode = 0o600 } = {}) {
  const home = mkdtempSync("/private/tmp/claude-sign-home.");
  const keychain = join(home, SIGNING_KEYCHAIN);
  mkdirSync(join(home, "Library/Keychains"), { recursive: true });
  writeFileSync(keychain, "fake keychain", { mode });
  chmodSync(keychain, mode);
  return { home, keychain };
}
export const noCalls = () => { const calls = []; return { calls, exec: (...args) => { calls.push(args); return { stdout: "", stderr: "" }; } }; };
