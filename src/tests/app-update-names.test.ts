import assert from "node:assert/strict";
import { test } from "node:test";
import { namesForAssets, namesForBackendArchive, releaseNameSets, releaseTagVersion } from "../app-updates/names.js";

test("release tags: app-vX.Y.Z and the standard vX.Y.Z are accepted, nothing else", () => {
  assert.equal(releaseTagVersion("app-v1.7.6"), "1.7.6");
  assert.equal(releaseTagVersion("v1.8.0"), "1.8.0");
  for (const tag of ["1.8.0", "v1.8", "app-1.8.0", "v1.8.0-rc.1", "xv1.8.0", "app-v1.8.0 ", undefined, 7]) assert.equal(releaseTagVersion(tag), undefined, String(tag));
});

test("asset names match only as a whole Harness Gateway or GateFox set", () => {
  assert.equal(namesForAssets("1.7.6", "Harness-Gateway-1.7.6-macos-arm64.zip", "harness-gateway-1.7.6-macos-arm64.tar.gz")?.app, "Harness Gateway.app");
  const gatefox = namesForAssets("1.8.0", "GateFox-1.8.0-macos-arm64.zip", "gatefox-1.8.0-macos-arm64.tar.gz");
  assert.deepEqual(gatefox, { appAsset: "GateFox-1.8.0-macos-arm64.zip", backendAsset: "gatefox-1.8.0-macos-arm64.tar.gz", backendRoot: "gatefox-1.8.0-macos-arm64", app: "GateFox.app" });
  assert.equal(namesForAssets("1.8.0", "GateFox-1.8.0-macos-arm64.zip", "harness-gateway-1.8.0-macos-arm64.tar.gz"), undefined, "mixed sets are refused");
  assert.equal(namesForAssets("1.8.0", "GateFox-1.7.9-macos-arm64.zip", "gatefox-1.8.0-macos-arm64.tar.gz"), undefined, "another version is refused");
  assert.equal(namesForBackendArchive("1.8.0", "gatefox-1.8.0-macos-arm64.tar.gz")?.backendRoot, "gatefox-1.8.0-macos-arm64");
  assert.equal(namesForBackendArchive("1.8.0", "../gatefox-1.8.0-macos-arm64.tar.gz"), undefined);
  assert.equal(releaseNameSets("1.0.0").length, 2);
});
