import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, gatewayToken } from "./config.js";

const exec = promisify(execFile);
const label = "com.edihasaj.subscription-gateway";
const marker = "<!-- Managed by subscription-gateway -->";
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
export function servicePlist(node: string, cli: string, config: string, log: string, path: string): string {
  const args = [node, cli, "serve", "--config", config].map(value => `<string>${xml(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${marker}\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array>${args}</array>\n<key>WorkingDirectory</key><string>${xml(dirname(config))}</string>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>10</integer>\n<key>StandardOutPath</key><string>${xml(log)}</string>\n<key>StandardErrorPath</key><string>${xml(log)}</string>\n</dict></plist>\n`;
}
async function status(target: string): Promise<{ installed: boolean; state?: string; pid?: number }> {
  try {
    const { stdout } = await exec("/bin/launchctl", ["print", target], { timeout: 5000 });
    return { installed: true, state: stdout.match(/^\s*state = ([a-zA-Z ]+)$/m)?.[1], pid: Number(stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || undefined };
  } catch { return { installed: false }; }
}
export async function macService(action: string | undefined, configPath: string): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin") throw new Error("User service setup currently supports macOS; use gateway serve on other systems");
  if (!["install", "status", "restart", "uninstall"].includes(action || "")) throw new Error("Choose gateway service install, status, restart, or uninstall");
  const domain = `gui/${process.getuid!()}`; const target = `${domain}/${label}`;
  const path = resolve(homedir(), "Library/LaunchAgents", `${label}.plist`);
  if (action === "status") return { service: label, ...await status(target) };
  let existing: string | undefined;
  try { existing = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read the gateway LaunchAgent"); }
  if (existing !== undefined && !existing.includes(marker)) throw new Error("An unmanaged LaunchAgent uses this name; refusing to replace it");
  if (action === "uninstall") {
    if ((await status(target)).installed) await exec("/bin/launchctl", ["bootout", target], { timeout: 10000 });
    if (existing !== undefined) {
      const trash = resolve(homedir(), ".Trash"); await mkdir(trash, { recursive: true, mode: 0o700 });
      await rename(path, resolve(trash, `${label}.${Date.now()}.plist`));
    }
    return { service: label, installed: false, credentialsPreserved: true };
  }
  if (action === "restart") {
    const before = await status(target);
    if (existing === undefined || !before.installed) throw new Error("Gateway service is not installed");
    if (!before.pid) { await exec("/bin/launchctl", ["kickstart", target], { timeout: 10000 }); return { service: label, ...await status(target) }; }
    const { stdout } = await exec("/usr/bin/plutil", ["-extract", "ProgramArguments", "json", "-o", "-", path]);
    const args: unknown = JSON.parse(stdout);
    if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new Error("Managed service arguments are invalid");
    const configIndex = args.indexOf("--config");
    if (configIndex < 0 || typeof args[configIndex + 1] !== "string") throw new Error("Managed service has no configuration path");
    const config = await loadConfig(args[configIndex + 1]);
    let health: { active?: number; idleRestart?: boolean };
    try { health = await (await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(3000) })).json() as typeof health; }
    catch { throw new Error("Cannot verify the running gateway is idle; service was not restarted"); }
    if (health.active !== 0) throw new Error("Gateway has active inference; finish or cancel it before restarting");
    if (health.idleRestart !== true) throw new Error("This daemon predates safe idle restart; upgrade it after active work finishes");
    process.kill(before.pid, "SIGUSR2");
    for (let attempt = 0; attempt < 30; attempt++) {
      await delay(100); const after = await status(target);
      if (after.pid && after.pid !== before.pid) return { service: label, ...after };
      if (!after.pid) { await exec("/bin/launchctl", ["kickstart", target], { timeout: 10000 }); return { service: label, ...await status(target) }; }
    }
    throw new Error("New gateway work prevented the idle restart; the existing service is still running");
  }
  const config = await loadConfig(configPath);
  if (!config.port) throw new Error("A managed daemon requires a fixed port");
  await gatewayToken(config.stateDirectory);
  const paths = [...new Set([dirname(process.execPath), resolve(homedir(), ".local/bin"), ...(process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin").split(":").filter(path => path.startsWith("/"))])].join(":");
  const contents = servicePlist(process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), configPath, resolve(config.stateDirectory, "service.log"), paths);
  const current = await status(target);
  if (current.installed && existing === undefined) throw new Error("An existing service has this label without a managed LaunchAgent; refusing to replace it");
  if (existing !== contents) {
    if (current.installed) await exec("/bin/launchctl", ["bootout", target], { timeout: 10000 });
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, contents, { mode: 0o600 }); await rename(temporary, path);
  }
  if (!current.installed || existing !== contents) await exec("/bin/launchctl", ["bootstrap", domain, path], { timeout: 10000 });
  return { service: label, ...await status(target), port: config.port };
}
