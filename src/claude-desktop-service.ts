import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { gatewayCommand } from "./command.js";

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

async function defaultPortAvailable(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((resolveResult, reject) => {
    server.once("error", error => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") resolveResult(false);
      else reject(error);
    });
    server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(error) : resolveResult(true)));
  });
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
  const config = requireAbsolute(configPath, "--config");
  const home = deps.home ?? homedir();
  const uid = deps.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("Cannot identify the macOS login session");
  const execCommand = deps.exec ?? runLaunchctl;
  const serviceTarget = target(uid);
  if ((await loaded(execCommand, serviceTarget)).loaded) throw new Error("Claude Desktop adapter LaunchAgent is already loaded; refusing to replace it");
  const port = await adapterPort(config);
  if (!await (deps.portAvailable ?? defaultPortAvailable)(port)) throw new Error(`Claude Desktop adapter port ${port} is already occupied`);
  const path = resolve(home, "Library/LaunchAgents", `${claudeDesktopAdapterLabel}.plist`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let existing: string | undefined;
  try { existing = await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read the Claude Desktop adapter LaunchAgent");
  }
  if (existing !== undefined && !existing.includes(claudeDesktopAdapterMarker)) {
    throw new Error("An unmanaged LaunchAgent uses the Claude Desktop adapter label; refusing to replace it");
  }
  const contents = claudeDesktopServicePlist((deps.command ?? gatewayCommand)(), config, home);
  if (existing !== contents) {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, path);
  }
  await execCommand("/bin/launchctl", ["enable", serviceTarget], { timeout: 5000 });
  await execCommand("/bin/launchctl", ["bootstrap", `gui/${uid}`, path], { timeout: 10000 });
  return { service: claudeDesktopAdapterLabel, installed: true, port };
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
  const state = platform === "darwin" ? await loaded(execCommand, target(uid)) : { loaded: false };
  const result: Record<string, unknown> = { service: claudeDesktopAdapterLabel, loaded: state.loaded, ...(state.pid ? { pid: state.pid } : {}) };
  if (configPath) {
    const config = requireAbsolute(configPath, "--config");
    const port = await adapterPort(config);
    result.listener = { port, listening: await listening(port) };
  }
  return result;
}
