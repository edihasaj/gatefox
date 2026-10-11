import { homedir } from "node:os";
import { resolve } from "node:path";
import { access } from "node:fs/promises";

export function userConfigPath(): string {
  return resolve(homedir(), process.platform === "darwin" ? "Library/Application Support/Subscription Gateway/gateway.json" : ".config/subscription-gateway/gateway.json");
}
export async function configPath(explicit?: string): Promise<string> {
  if (explicit || process.env.GATEWAY_CONFIG) return resolve(explicit || process.env.GATEWAY_CONFIG!);
  if (process.env.GATEWAY_INSTALLED === "1") return userConfigPath();
  try { await access("gateway.local.json"); return resolve("gateway.local.json"); } catch { return userConfigPath(); }
}
