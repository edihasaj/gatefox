import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { readServicePlan } from "./service-plan.js";
import { consolidatedStatus } from "./mac-consolidate.js";
import { ensureLaunchAgent } from "./mac-launch-agent.js";

const exec = promisify(execFile); const marker = "<!-- Managed by subscription-gateway tunnel -->";
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export interface TunnelOptions { id: string; host?: string; port?: number; remotePort?: number; reverse?: boolean; sshConfig?: string }
export function tunnelArguments(options: TunnelOptions): string[] {
  if (!options.host || !/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.host)) throw new Error("Tunnel host must be an SSH alias or user@hostname");
  for (const port of [options.port, options.remotePort]) if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Tunnel ports must be 1 through 65535");
  return ["/usr/bin/ssh", "-N", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "RequestTTY=no", "-o", "RemoteCommand=none",
    ...(options.sshConfig ? ["-F", resolve(options.sshConfig)] : []), options.reverse ? "-R" : "-L", `127.0.0.1:${options.port}:127.0.0.1:${options.remotePort}`, options.host];
}
export async function macTunnel(action: string | undefined, options: TunnelOptions, state: string): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin") throw new Error("Managed SSH tunnels currently support macOS");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(options.id) || !["install", "status", "uninstall"].includes(action || "")) throw new Error("Choose tunnel install/status/uninstall and a lowercase --tunnel-id");
  const plan = await readServicePlan(state);
  if (plan) {
    if (action === "status") return { ...await consolidatedStatus(state), component: plan.components.find(component => component.id === "tunnel-" + options.id)?.id || null };
    throw new Error("Tunnels are owned by the unified service. Finish chats and uninstall that service before changing its tunnel configuration");
  }
  const label = `com.edihasaj.subscription-gateway.tunnel.${options.id}`; const domain = `gui/${process.getuid!()}`; const target = `${domain}/${label}`;
  const path = resolve(homedir(), "Library/LaunchAgents", label + ".plist");
  const status = async () => { try { const { stdout } = await exec("/bin/launchctl", ["print", target]); return { installed: true, pid: Number(stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || undefined }; } catch { return { installed: false }; } };
  if (action === "status") return { service: label, ...await status() };
  let existing: string | undefined;
  try { existing = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing && !existing.includes(marker)) throw new Error("Refusing to change an unmanaged tunnel LaunchAgent");
  if (action === "uninstall") {
    if ((await status()).installed) await exec("/bin/launchctl", ["bootout", target]);
    if (existing) { const trash = resolve(homedir(), ".Trash"); await mkdir(trash, { recursive: true }); await rename(path, resolve(trash, label + "." + Date.now() + ".plist")); }
    return { service: label, installed: false };
  }
  const args = tunnelArguments(options);
  const contents = `<?xml version="1.0" encoding="UTF-8"?>\n${marker}\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardErrorPath</key><string>${xml(resolve(state, `tunnel-${options.id}.log`))}</string></dict></plist>\n`;
  const current = await status();
  if (current.installed && existing !== contents) throw new Error("An active tunnel differs; uninstall it before changing its endpoint");
  if (existing !== contents) { await mkdir(dirname(path), { recursive: true }); await mkdir(state, { recursive: true, mode: 0o700 }); const temporary = path + `.${process.pid}.tmp`; await writeFile(temporary, contents, { mode: 0o600 }); await rename(temporary, path); }
  await ensureLaunchAgent(domain, label, path, current.installed);
  return { service: label, ...await status(), port: options.port, reverse: !!options.reverse };
}
