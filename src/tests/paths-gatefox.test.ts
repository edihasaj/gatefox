import test from "node:test";
import assert from "node:assert/strict";
import { gatefoxConfigPath, legacyConfigPath, userConfigPath } from "../paths.js";

test("a fresh installation uses the GateFox configuration; a Mac set up before 1.8.0 keeps its own until it migrates", () => {
  const home = "/Users/dev";
  assert.equal(userConfigPath(home, "darwin", () => false), "/Users/dev/Library/Application Support/GateFox/gateway.json");
  assert.equal(userConfigPath(home, "linux", () => false), "/Users/dev/.config/gatefox/gateway.json");
  const legacy = legacyConfigPath(home, "darwin");
  assert.equal(userConfigPath(home, "darwin", path => path === legacy), "/Users/dev/Library/Application Support/Subscription Gateway/gateway.json");
  // Once migrated (both present, or only the new one), the GateFox configuration wins.
  assert.equal(userConfigPath(home, "darwin", () => true), gatefoxConfigPath(home, "darwin"));
});
