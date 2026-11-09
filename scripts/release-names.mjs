import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Names 1.8.0 and later releases publish. They match the GateFox set in src/app-updates/names.ts, which 1.7.6 and
 * later updaters accept as a whole: the ZIP holds `GateFox.app`, the backend archive unpacks to `gatefox-V-macos-arm64`.
 */
export const appBundle = 'GateFox.app';
export const legacyAppBundle = 'Harness Gateway.app';
export const appAsset = version => `GateFox-${version}-macos-arm64.zip`;
export const backendName = version => `gatefox-${version}-macos-arm64`;
export const backendAsset = version => `${backendName(version)}.tar.gz`;

/** The installed app in a folder: GateFox.app, or the Harness Gateway.app a Mac had before it renamed itself. */
export function installedApp(directory) {
  const current = join(directory, appBundle), legacy = join(directory, legacyAppBundle);
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}
