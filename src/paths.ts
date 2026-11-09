import { homedir } from "node:os";
import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { existsSync } from "node:fs";

/** The configuration a fresh installation uses since 1.8.0. */
export function gatefoxConfigPath(home = homedir(), platform = process.platform): string {
  return resolve(home, platform === "darwin" ? "Library/Application Support/GateFox/gateway.json" : ".config/gatefox/gateway.json");
}
/** The configuration installations before 1.8.0 created. It stays in use where it exists, until `gatefox migrate` moves it. */
export function legacyConfigPath(home = homedir(), platform = process.platform): string {
  return resolve(home, platform === "darwin" ? "Library/Application Support/Subscription Gateway/gateway.json" : ".config/subscription-gateway/gateway.json");
}
/** The default configuration: the existing pre-1.8.0 one on a Mac that has it, otherwise the GateFox one. */
export function userConfigPath(home = homedir(), platform = process.platform, exists: (path: string) => boolean = existsSync): string {
  const legacy = legacyConfigPath(home, platform);
  return exists(legacy) && !exists(gatefoxConfigPath(home, platform)) ? legacy : gatefoxConfigPath(home, platform);
}
/** Where the installer keeps releases when no `--prefix` was given. */
export function defaultInstallRoot(): string {
  return resolve(homedir(), ".local/share/subscription-gateway");
}
export async function configPath(explicit?: string): Promise<string> {
  if (explicit || process.env.GATEWAY_CONFIG) return resolve(explicit || process.env.GATEWAY_CONFIG!);
  if (process.env.GATEWAY_INSTALLED === "1") return userConfigPath();
  try { await access("gateway.local.json"); return resolve("gateway.local.json"); } catch { return userConfigPath(); }
}
