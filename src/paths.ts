import { homedir } from "node:os";
import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname } from "node:path";

/** Only the exact, user-owned rename alias shares the legacy identity; arbitrary links are never normalized. */
export function compatibilityBackingPath(path: string, canonical: string, legacy: string): string {
  if (resolve(path) !== resolve(canonical)) return path;
  try {
    const alias = lstatSync(dirname(canonical)), backing = lstatSync(dirname(legacy));
    if (alias.isSymbolicLink() && alias.uid === process.getuid?.() && backing.isDirectory() &&
        backing.uid === process.getuid?.() && !(backing.mode & 0o022) &&
        resolve(dirname(dirname(canonical)), readlinkSync(dirname(canonical))) === dirname(legacy)) return legacy;
  } catch { /* A missing or unverified alias keeps its original identity. */ }
  return path;
}

export function configIdentityPath(path: string, home = homedir(), platform = process.platform): string {
  return compatibilityBackingPath(path, gatefoxConfigPath(home, platform), legacyConfigPath(home, platform));
}

/** The configuration a fresh installation uses since 1.8.0. */
export function gatefoxConfigPath(home = homedir(), platform = process.platform): string {
  return resolve(home, platform === "darwin" ? "Library/Application Support/GateFox/gateway.json" : ".config/gatefox/gateway.json");
}
/** The historical backing configuration. Rename aliases keep this identity so existing execution hosts still match. */
export function legacyConfigPath(home = homedir(), platform = process.platform): string {
  return resolve(home, platform === "darwin" ? "Library/Application Support/Subscription Gateway/gateway.json" : ".config/subscription-gateway/gateway.json");
}
/** The default configuration: the existing pre-1.8.0 one on a Mac that has it, otherwise the GateFox one. */
export function userConfigPath(home = homedir(), platform = process.platform, exists: (path: string) => boolean = existsSync): string {
  const legacy = legacyConfigPath(home, platform);
  return exists(legacy) && !exists(gatefoxConfigPath(home, platform)) ? legacy : configIdentityPath(gatefoxConfigPath(home, platform), home, platform);
}
/** Install folders under `<prefix>/share`: GateFox's for fresh installations, then the one installations before 1.8.0 created. */
export const installDirectoryNames = ["gatefox", "subscription-gateway"] as const;
/** The install root under a prefix: an existing GateFox one, else an existing pre-1.8.0 one, else GateFox's for a fresh installation. */
export function installRootIn(prefix: string, exists: (path: string) => boolean = existsSync): string {
  const [gatefox, legacy] = installDirectoryNames.map(name => resolve(prefix, "share", name)) as [string, string];
  if (!exists(gatefox) && exists(legacy)) return legacy;
  return dirname(compatibilityBackingPath(resolve(gatefox, ".gateway-installation"), resolve(gatefox, ".gateway-installation"), resolve(legacy, ".gateway-installation")));
}
/** Where the installer keeps releases when no `--prefix` was given. */
export function defaultInstallRoot(exists?: (path: string) => boolean): string {
  return installRootIn(resolve(homedir(), ".local"), exists);
}
export async function configPath(explicit?: string): Promise<string> {
  if (explicit || process.env.GATEWAY_CONFIG) return configIdentityPath(resolve(explicit || process.env.GATEWAY_CONFIG!));
  if (process.env.GATEWAY_INSTALLED === "1") return userConfigPath();
  try { await access("gateway.local.json"); return resolve("gateway.local.json"); } catch { return userConfigPath(); }
}
