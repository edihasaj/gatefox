import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { userConfigPath } from "./paths.js";
import { readServicePlan, serviceStatusPath } from "./service-plan.js";

const exec = promisify(execFile);

export const claudeDesktopAdapterLabel = "com.edihasaj.claude-desktop-adapter";
export const sharedGatewayLabel = "com.edihasaj.subscription-gateway";
export const claudeDesktopAdapterMarker = "<!-- Managed by harness-gateway Claude Desktop adapter -->";

export type ClaudeDesktopExec = (file: string, args: string[], options?: { timeout?: number }) => Promise<{ stdout: string }>;

export interface ClaudeDesktopServiceDeps {
  exec?: ClaudeDesktopExec;
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  command?: () => { command: string; args: string[] };
  portAvailable?: (port: number) => Promise<boolean>;
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const target = (uid: number, label = claudeDesktopAdapterLabel) => `gui/${uid}/${label}`;
const runLaunchctl: ClaudeDesktopExec = async (file, args, options) => {
  const result = await exec(file, args, options);
  return { stdout: String(result.stdout) };
};

function requireAbsolute(path: string, name: string): string {
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  return resolve(path);
}

async function adapterPort(configPath: string): Promise<number> {
  let data: unknown;
  try { data = JSON.parse(await readFile(configPath, "utf8")); } catch { throw new Error("Claude Desktop adapter config is unreadable or invalid"); }
  if (!data || typeof data !== "object" || Array.isArray(data) || !Number.isInteger((data as { listenPort?: unknown }).listenPort)) {
    throw new Error("Claude Desktop adapter config is invalid");
  }
  const port = (data as { listenPort: number }).listenPort;
  if (port < 1 || port > 65535) throw new Error("Claude Desktop adapter config must use a fixed port");
  return port;
}

async function loaded(execCommand: ClaudeDesktopExec, serviceTarget: string): Promise<{ loaded: boolean; pid?: number }> {
  try {
    const { stdout } = await execCommand("/bin/launchctl", ["print", serviceTarget], { timeout: 5000 });
    return { loaded: true, pid: Number(stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || undefined };
  } catch { return { loaded: false }; }
}

export function claudeDesktopServicePlist(command: { command: string; args: string[] }, configPath: string, home = homedir(),
  label = claudeDesktopAdapterLabel): string {
  if (label === sharedGatewayLabel) throw new Error("The shared gateway LaunchAgent label is reserved");
  const argumentsList = [command.command, ...command.args, "claude-desktop", "serve", "--config", configPath]
    .map(value => `<string>${xml(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${claudeDesktopAdapterMarker}\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array>${argumentsList}</array>\n<key>WorkingDirectory</key><string>${xml(dirname(configPath))}</string>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${xml(resolve(home, "Library/Logs/harness-gateway-claude-desktop-adapter.log"))}</string>\n<key>StandardErrorPath</key><string>${xml(resolve(home, "Library/Logs/harness-gateway-claude-desktop-adapter.log"))}</string>\n</dict></plist>\n`;
}

export async function installClaudeDesktopService(configPath: string, deps: ClaudeDesktopServiceDeps = {}): Promise<Record<string, unknown>> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("Claude Desktop adapter installation currently supports macOS only");
  requireAbsolute(configPath, "--config");
  throw new Error("Separate Claude Desktop LaunchAgents are no longer supported. Keep the existing adapter running and use gateway service claude-desktop --on-restart to move it under the signed Harness Gateway.app service.");
}

async function managedAdapter(home: string, configPath: string | undefined, execCommand: ClaudeDesktopExec, uid: number): Promise<Record<string, unknown> | undefined> {
  const path = userConfigPath(home, "darwin");
  try { await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Cannot inspect the app-owned gateway service configuration");
  }
  const config = await loadConfig(path);
  const plan = await readServicePlan(config.stateDirectory);
  const component = plan?.components.find(item => item.kind === "claude-adapter" && (!configPath || item.args[item.args.indexOf("--config") + 1] === resolve(configPath)));
  if (!component) return;
  const registration = await loaded(execCommand, target(uid, sharedGatewayLabel));
  const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  let live: Record<string, unknown> = {};
  try { live = record(JSON.parse(await readFile(serviceStatusPath(config.stateDirectory), "utf8"))); } catch { /* Missing status is not a running component. */ }
  const age = Date.now() - Date.parse(typeof live.updatedAt === "string" ? live.updatedAt : "");
  const current = registration.pid && live.pid === registration.pid && age >= 0 && age < 15000;
  const child = current && Array.isArray(live.components) ? live.components.map(record).find(item => item.id === component.id && item.kind === component.kind) : undefined;
  const state = typeof child?.state === "string" && ["starting", "running", "waiting", "complete", "stopped", "paused"].includes(child.state) ? child.state : "unknown";
  return { service: sharedGatewayLabel, mode: "app-service", loaded: registration.loaded, component: component.id,
    state, ...(state === "running" && Number.isSafeInteger(child?.pid) && Number(child?.pid) > 0 ? { pid: child!.pid } : {}),
    legacyLoaded: (await loaded(execCommand, target(uid))).loaded };
}

async function listening(port: number): Promise<boolean> {
  return new Promise(resolveResult => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (result: boolean) => { socket.destroy(); resolveResult(result); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

/** Reports this adapter's process and loopback listener. It never reads or emits its token. */
export async function claudeDesktopServiceStatus(configPath?: string, deps: ClaudeDesktopServiceDeps = {}): Promise<Record<string, unknown>> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const uid = deps.uid ?? process.getuid?.() ?? -1;
  const execCommand = deps.exec ?? runLaunchctl;
  const managed = platform === "darwin" ? await managedAdapter(home, configPath, execCommand, uid) : undefined;
  const state = !managed && platform === "darwin" ? await loaded(execCommand, target(uid)) : { loaded: false };
  const result: Record<string, unknown> = managed ?? { service: claudeDesktopAdapterLabel, loaded: state.loaded, ...(state.pid ? { pid: state.pid } : {}), ...(state.loaded ? { retirementRequired: true } : {}) };
  if (configPath) {
    const config = requireAbsolute(configPath, "--config");
    const port = await adapterPort(config);
    result.listener = { port, listening: await listening(port) };
  }
  return result;
}
