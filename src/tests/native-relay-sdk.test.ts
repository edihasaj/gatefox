import assert from "node:assert/strict";
import { test } from "node:test";

const sdk = await import(new URL("../../scripts/native-relay-sdk.mjs", import.meta.url).href);
const file = "codex-rs/app-server-transport/src/example.rs";

test("SDK patches require each anchor exactly once and apply deterministically to pristine text", () => {
  const patches = [{ file, original: "mod transport;\n", replacement: "mod transport;\npub mod gateway_counters;\n" }];
  const pristine = "mod outgoing_message;\nmod transport;\n";
  const first = sdk.applyPatches(pristine, file, patches);
  assert.equal(first, "mod outgoing_message;\nmod transport;\npub mod gateway_counters;\n");
  assert.equal(sdk.applyPatches(pristine, file, patches), first);
  assert.throws(() => sdk.applyPatches("mod outgoing_message;\n", file, patches), /occurs 0 times, expected 1/);
  assert.throws(() => sdk.applyPatches(pristine + pristine, file, patches), /occurs 2 times, expected 1/);
  // A second application to patched output is refused instead of silently skipped.
  const retained = [{ file, original: "pub enum A {", replacement: "pub enum A {\n    B," }];
  assert.throws(() => sdk.applyPatches(sdk.applyPatches("pub enum A {", file, retained) + "\npub enum A {", file, retained), /occurs 2 times/);
  assert.equal(sdk.applyPatches("x", "other.rs", patches), "x");
});

test("counted SDK patches replace every expected occurrence and nothing else", () => {
  const patches = [{ file, count: 2, original: "Config {\n", replacement: "Config {\n    name: None,\n" }];
  assert.equal(sdk.applyPatches("Config {\nConfig {\n", file, patches), "Config {\n    name: None,\nConfig {\n    name: None,\n");
  assert.throws(() => sdk.applyPatches("Config {\n", file, patches), /occurs 1 times, expected 2/);
});

test("the pinned patch list has unique anchors per file and a stable digest", () => {
  assert.ok(sdk.sdkPatches.length >= 7);
  for (const patch of sdk.sdkPatches) assert.ok(patch.file.startsWith("codex-rs/") && patch.original && patch.replacement !== patch.original);
  assert.match(sdk.sdkPatchDigest(), /^[a-f0-9]{64}$/);
  assert.equal(sdk.sdkPatchDigest(), sdk.sdkPatchDigest());
});

test("SDK overlays may only add files", () => {
  const listing = ["root/", "root/codex-rs/", "root/codex-rs/app-server-transport/src/lib.rs"];
  sdk.checkOverlayPaths(["codex-rs/app-server-transport/src/gateway_counters.rs"], listing, "root");
  assert.throws(() => sdk.checkOverlayPaths(["codex-rs/app-server-transport/src/lib.rs"], listing, "root"), /replace an upstream file/);
  assert.throws(() => sdk.checkOverlayPaths(["codex-rs/../escape.rs"], listing, "root"), /Unsafe SDK overlay path/);
  assert.throws(() => sdk.checkOverlayPaths(["other/file.rs"], listing, "root"), /Unsafe SDK overlay path/);
});

test("the SDK test gate requires 0 failed and every required test name", () => {
  const required = ["a::one", "a::two"];
  const ok = "test a::one ... ok\ntest a::two ... ok\n\ntest result: ok. 2 passed; 0 failed; 0 ignored;";
  assert.equal(sdk.checkSdkTestOutput(ok, required, 2), 2);
  assert.throws(() => sdk.checkSdkTestOutput(ok, required, 3), /expected at least 3/);
  assert.throws(() => sdk.checkSdkTestOutput("test a::one ... ok\n\ntest result: ok. 1 passed; 0 failed;", required, 1), /a::two/);
  assert.throws(() => sdk.checkSdkTestOutput("test result: FAILED. 1 passed; 1 failed;", required, 1), /0 failed/);
  assert.ok(sdk.minimumSdkTests > sdk.requiredSdkTests.length);
  const args = sdk.sdkTestArguments({ sdk: "/sdk", target: "/target", dev: true });
  assert.deepEqual(args.slice(-3), ["--", ...sdk.sdkTestFilters]);
  assert.ok(args.includes("--locked") && !args.includes("--release"));
});
