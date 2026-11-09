import test from "node:test";
import assert from "node:assert/strict";
import { gatefoxConfigPath, installRootIn, legacyConfigPath, userConfigPath } from "../paths.js";

test("a fresh installation uses the GateFox configuration; a Mac set up before 1.8.0 keeps its own until it migrates", () => {
  const home = "/Users/dev";
  assert.equal(userConfigPath(home, "darwin", () => false), "/Users/dev/Library/Application Support/GateFox/gateway.json");
  assert.equal(userConfigPath(home, "linux", () => false), "/Users/dev/.config/gatefox/gateway.json");
  const legacy = legacyConfigPath(home, "darwin");
  assert.equal(userConfigPath(home, "darwin", path => path === legacy), "/Users/dev/Library/Application Support/Subscription Gateway/gateway.json");
  // Once migrated (both present, or only the new one), the GateFox configuration wins.
  assert.equal(userConfigPath(home, "darwin", () => true), gatefoxConfigPath(home, "darwin"));
});

test("a fresh installation lives in share/gatefox; one from before 1.8.0 keeps share/subscription-gateway", () => {
  const prefix = "/Users/dev/.local";
  assert.equal(installRootIn(prefix, () => false), "/Users/dev/.local/share/gatefox");
  assert.equal(installRootIn(prefix, path => path.endsWith("/subscription-gateway")), "/Users/dev/.local/share/subscription-gateway");
  assert.equal(installRootIn(prefix, () => true), "/Users/dev/.local/share/gatefox");
});
