import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { parseProcessTable } from "./health-desktop.js";
import { telemetry } from "./telemetry.js";

/**
 * ChatGPT is a login item and can start a few seconds before the GateFox service has set CODEX_CLI_PATH. It then runs
 * its stock engine outside the gateway: the desktop loses gateway chats, and that engine can take the Mac's single
 * remote-control connection from the native relay, so the phone reaches an engine without gateway models (seen on
 * Studio after a reboot on 13 Nov 2026: 13 seconds of race, then six hours of failed phone turns).
 *
 * Right after the service sets the variable, this reopens such an app once, and only while it is brand new: the app
 * and its stock engine both started at most `loginRaceWindowSeconds` ago, so no chat can have started on it. Anything
 * older is left alone for the health warning. The app gets SIGTERM, which Electron treats as a normal quit; it is
 * never force-killed. Only fixed outcome words are recorded, never a path or a command line.
 */
export const loginRaceWindowSeconds = 90;
const quitWaitMs = 15_000;
const stockEngine = /^\S*\/CodexCLI\.app\/Contents\/MacOS\/codex(?:\s|$)/;
const gatewayShim = /\scodex-shim(?:\s|$)/;

export interface LoginRaceDeps {
  /** Runs one local command and returns its stdout (`ps` and `open` only). */
  exec: (command: string, args: string[]) => Promise<string>;
  /** Sends a signal; signal 0 checks that the process still exists. */
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<void>;
}

const run = promisify(execFile);
const localDeps: LoginRaceDeps = {
  exec: async (command, args) => (await run(command, args, { timeout: 5000, maxBuffer: 16 * 1024 * 1024 })).stdout,
  kill: (pid, signal) => { process.kill(pid, signal); },
  sleep: ms => delay(ms),
};

/** Seconds from a `ps` etime value (`[[dd-]hh:]mm:ss`), or undefined when it is not one. */
export function etimeSeconds(value: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

const alive = (deps: LoginRaceDeps, pid: number): boolean => { try { deps.kill(pid, 0); return true; } catch { return false; } };

export type LoginRaceOutcome = "none" | "relaunched" | "too_old" | "quit_timeout" | "failed";

export async function recoverDesktopLoginRace(appPath: string, overrides: Partial<LoginRaceDeps> = {}): Promise<LoginRaceOutcome> {
  if (process.platform !== "darwin" && !overrides.exec) return "none";
  const deps = { ...localDeps, ...overrides };
  let outcome: LoginRaceOutcome = "failed";
  try {
    const table = parseProcessTable(await deps.exec("/bin/ps", ["-axo", "pid=,ppid=,command="]));
    const main = `${appPath.replace(/\/+$/, "")}/Contents/MacOS/ChatGPT`;
    const apps = table.filter(entry => entry.command === main || entry.command.startsWith(`${main} `));
    const children = (pid: number) => table.filter(entry => entry.ppid === pid);
    const raced = apps.filter(app => !children(app.pid).some(child => gatewayShim.test(child.command))).flatMap(app => {
      const engine = children(app.pid).find(child => stockEngine.test(child.command) && /\sapp-server(?:\s|$)/.test(child.command));
      return engine ? [{ app, engine }] : [];
    });
    if (raced.length !== 1) return outcome = "none";
    const { app, engine } = raced[0]!;
    const ages = (await deps.exec("/bin/ps", ["-o", "pid=,etime=", "-p", `${app.pid},${engine.pid}`])).split("\n").flatMap(line => {
      const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line); return match ? [[Number(match[1]), etimeSeconds(match[2]!)] as const] : [];
    });
    const age = (pid: number) => ages.find(([id]) => id === pid)?.[1];
    const appAge = age(app.pid), engineAge = age(engine.pid);
    if (appAge === undefined || engineAge === undefined || appAge > loginRaceWindowSeconds || engineAge > loginRaceWindowSeconds) return outcome = "too_old";
    deps.kill(app.pid, "SIGTERM");
    for (let waited = 0; alive(deps, app.pid); waited += 250) {
      if (waited >= quitWaitMs) return outcome = "quit_timeout";
      await deps.sleep(250);
    }
    await deps.exec("/usr/bin/open", [appPath]);
    return outcome = "relaunched";
  } catch { return outcome = "failed"; }
  finally { if (outcome !== "none") telemetry("desktop_login_race", { outcome }); }
}
