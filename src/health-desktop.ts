import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Exec, Finding } from "./health-types.js";

/**
 * Whether the running ChatGPT app is on the gateway's engine. A registered desktop adapter only
 * reaches an app that starts after it: an app that was already running, or that launched at login
 * before the gateway did, keeps its stock engine until it is quit and reopened.
 *
 * The answer comes from the process table alone (`ps` pid, ppid and command, through the same
 * injectable command seam the app check uses). The app's own children tell the two engines apart:
 * a gatewayed app has a `codex-shim` child of the installed gateway, a stock app a direct
 * `CodexCLI.app/.../codex ... app-server` child. The helper children (`Codex (Service)`,
 * `Codex (Renderer)`) and the `exec-server` child say nothing about it. No process's environment
 * is read, and no command line reaches a report.
 */
const run = promisify(execFile);
const psTimeoutMs = 5000;
export const desktopRegistrationFile = "desktop-registration.json";
export const stockEngineReason = "ChatGPT started before the gateway (for example right after a reboot); quit and reopen ChatGPT to use gateway chats";

const psCommand = "/bin/ps";
const psArguments = ["-axo", "pid=,ppid=,command="];
const gatewayShim = /^\S*\/current\/runtime\/bin\/node\s+\S*\/current\/package\/dist\/cli\.js\s+codex-shim(?:\s|$)/;
const stockEngine = /^\S*\/CodexCLI\.app\/Contents\/MacOS\/codex(?:\s|$)/;

interface ProcessEntry { pid: number; ppid: number; command: string }

const localExec: Exec = async (command, args) => (await run(command, args, { timeout: psTimeoutMs, maxBuffer: 16 * 1024 * 1024 })).stdout;

/** Rows of `ps -axo pid=,ppid=,command=`; a line that is not one is skipped. */
export function parseProcessTable(out: string): ProcessEntry[] {
  return out.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : [];
  });
}

/** Whether the desktop receipt names a wrapper, which is what an active registration leaves. */
async function registered(stateDirectory: string, readFile: (path: string) => Promise<string>): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(join(stateDirectory, desktopRegistrationFile))) as { wrapper?: unknown } | null;
    return typeof value?.wrapper === "string" && value.wrapper.length > 0;
  } catch { return false; }
}

export interface DesktopDeps {
  readFile: (path: string) => Promise<string>;
  /** Runs one local command and returns its stdout; only `ps` is asked for. */
  exec?: Exec;
}

/**
 * The desktop findings: nothing without an active registration, info while ChatGPT is not
 * running, and a warning while it runs on the app's stock engine. A gatewayed app, or an app
 * still starting that has neither child yet, says nothing.
 */
export async function desktopFindings(stateDirectory: string, appPath: string, deps: DesktopDeps): Promise<Finding[]> {
  if (!await registered(stateDirectory, deps.readFile)) return [];
  const table = parseProcessTable(await (deps.exec ?? localExec)(psCommand, psArguments));
  const main = `${appPath.replace(/\/+$/, "")}/Contents/MacOS/ChatGPT`;
  const apps = table.filter(entry => entry.command === main || entry.command.startsWith(`${main} `));
  if (!apps.length) return [{ level: "info", reason: "ChatGPT not running" }];
  const children = (pid: number) => table.filter(entry => entry.ppid === pid);
  if (apps.some(app => children(app.pid).some(child => gatewayShim.test(child.command)))) return [];
  const stock = apps.some(app => children(app.pid).some(child => stockEngine.test(child.command) && /\sapp-server(?:\s|$)/.test(child.command)));
  return stock ? [{ level: "warn", reason: stockEngineReason }] : [];
}
