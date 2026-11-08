/**
 * Release names the app updater accepts. 1.7.6 is the bridge release: it still publishes the
 * Harness Gateway names (under `app-vVERSION` for older updaters, and a standard `vVERSION`
 * release), and accepts the GateFox names that 1.8.0 and later publish under `vVERSION` only.
 * Each set must be used as a whole: a GateFox ZIP holds `GateFox.app`, a GateFox archive
 * unpacks to `gatefox-VERSION-macos-arm64`.
 */
export interface ReleaseNames { appAsset: string; backendAsset: string; backendRoot: string; app: string }

export function releaseNameSets(version: string): ReleaseNames[] {
  return [
    { appAsset: `Harness-Gateway-${version}-macos-arm64.zip`, backendAsset: `harness-gateway-${version}-macos-arm64.tar.gz`,
      backendRoot: `harness-gateway-${version}-macos-arm64`, app: "Harness Gateway.app" },
    { appAsset: `GateFox-${version}-macos-arm64.zip`, backendAsset: `gatefox-${version}-macos-arm64.tar.gz`,
      backendRoot: `gatefox-${version}-macos-arm64`, app: "GateFox.app" },
  ];
}

/** The name set whose app ZIP and backend archive are both exactly these names, or undefined. */
export function namesForAssets(version: string, appAsset: unknown, backendAsset: unknown): ReleaseNames | undefined {
  return releaseNameSets(version).find(names => names.appAsset === appAsset && names.backendAsset === backendAsset);
}

/** The name set a staged backend archive belongs to, from its file name. */
export function namesForBackendArchive(version: string, archiveName: string): ReleaseNames | undefined {
  return releaseNameSets(version).find(names => names.backendAsset === archiveName);
}

/** The version of an app release tag: `app-vX.Y.Z` (through 1.7.6) or the standard `vX.Y.Z`. */
export function releaseTagVersion(tag: unknown): string | undefined {
  const match = typeof tag === "string" ? /^(?:app-)?v([0-9]+\.[0-9]+\.[0-9]+)$/.exec(tag) : null;
  return match?.[1];
}
