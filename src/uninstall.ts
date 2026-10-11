import { readFile, readdir, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { macService } from "./mac-service.js";
import { macTunnel } from "./mac-tunnel.js";
import { macDesktop } from "./mac-desktop.js";

export async function uninstallGateway(configPath: string): Promise<Record<string, unknown>> {
  const command = process.env.GATEWAY_COMMAND;
  if (process.env.GATEWAY_INSTALLED !== "1" || !command) throw new Error("Uninstall requires an installed gateway command");
  const root = resolve(dirname(command), "../share/subscription-gateway");
  if (await readFile(resolve(root, ".gateway-installation"), "utf8") !== "subscription-gateway\n" || !(await readFile(command, "utf8")).includes("# Managed by subscription-gateway installer")) throw new Error("Installation is not managed by this installer");
  await macService("uninstall", configPath);
  await macDesktop("unregister", configPath);
  const directory = resolve(homedir(), "Library/LaunchAgents");
  for (const file of await readdir(directory)) {
    const match = /^com\.edihasaj\.subscription-gateway\.tunnel\.([a-z][a-z0-9-]{0,63})\.plist$/.exec(file);
    if (match) await macTunnel("uninstall", { id: match[1] }, dirname(configPath));
  }
  const trash = resolve(homedir(), ".Trash"); await mkdir(trash, { recursive: true }); const suffix = Date.now();
  await rename(command, resolve(trash, `gateway.${suffix}`)); await rename(root, resolve(trash, `subscription-gateway.${suffix}`));
  return { uninstalled: true, installationMovedToTrash: true, credentialsPreserved: true, nativeConfigUntouched: true };
}
