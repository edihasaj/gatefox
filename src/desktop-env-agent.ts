import { readFile, mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { ensureLaunchAgent } from "./mac-launch-agent.js";
import { isOwnWrapperPath } from "./desktop-wrapper-path.js";

/**
 * The login-time environment agent. ChatGPT is a login item and can start before the unified service has set
 * CODEX_CLI_PATH, in which case the app launches its own engine and runs without the gateway. This tiny LaunchAgent
 * sets the variable at login, before anything slower can run. It is not a service component: it has no node, no
 * KeepAlive and no environment of its own, and consolidation neither collects nor retires it.
 */
export const envAgentLabel = "com.edihasaj.subscription-gateway.desktop-env";
export const envAgentMarker = "<!-- Managed by subscription-gateway desktop-env -->";
/** Same shape as the desktop module's seam: every launchctl call goes through it, so a test never reaches the session. */
export type EnvAgentExec = (file: string, args: string[]) => Promise<{ stdout: string }>;

/** The fixed classes a failed agent step is reported as; error text and paths never leave the process. */
export type EnvAgentFailure = "write" | "bootstrap" | "unmanaged" | "other";
/** A failed agent step, with its class. The message is the underlying one, so an interactive command still explains itself. */
export class EnvAgentError extends Error {
  constructor(readonly reason: EnvAgentFailure, message: string, cause?: unknown) { super(message, { cause }); }
}
export const envAgentFailure = (error: unknown): EnvAgentFailure => error instanceof EnvAgentError ? error.reason : "other";
const failing = async <T>(reason: EnvAgentFailure, run: () => Promise<T>): Promise<T> => {
  try { return await run(); } catch (error) { throw error instanceof EnvAgentError ? error : new EnvAgentError(reason, error instanceof Error ? error.message : "The desktop environment agent failed", error); }
};

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export const envAgentPath = () => resolve(homedir(), "Library/LaunchAgents", envAgentLabel + ".plist");
/** The whole plist for one registered wrapper. */
export function envAgentPlist(wrapper: string): string {
  const args = ["/bin/launchctl", "setenv", "CODEX_CLI_PATH", wrapper].map(value => `<string>${xml(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${envAgentMarker}\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${envAgentLabel}</string>\n<key>ProgramArguments</key><array>${args}</array>\n<key>RunAtLoad</key><true/>\n<key>LimitLoadToSessionType</key><string>Aqua</string>\n</dict></plist>\n`;
}
/** The agent's contents, or nothing where it is absent. A plist without our marker is not ours to change. */
export async function readEnvAgent(path = envAgentPath()): Promise<string | undefined> {
  let contents: string | undefined;
  try { contents = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (contents !== undefined && !contents.includes(envAgentMarker)) throw new EnvAgentError("unmanaged", "Refusing to change an unmanaged desktop environment LaunchAgent");
  return contents;
}
/** Whether the agent exists, is ours, and names exactly this wrapper. */
export const envAgentNames = (contents: string | undefined, wrapper: string | undefined): boolean =>
  !!contents && !!wrapper && contents.includes(`<string>CODEX_CLI_PATH</string><string>${xml(wrapper)}</string>`);
/**
 * Writes or updates the agent for `wrapper` and loads it into the login session. The wrapper must be a generated
 * wrapper in the gateway state directory: the stable registered path, never a release path. The file is private and
 * replaced atomically; a changed agent is booted out first, and an unchanged one is only enabled and loaded if missing.
 */
export async function writeEnvAgent(stateDirectory: string, wrapper: string, existing: string | undefined, exec: EnvAgentExec): Promise<void> {
  if (!isOwnWrapperPath(wrapper, stateDirectory)) throw new EnvAgentError("other", "The desktop environment agent only names a wrapper in the gateway state directory");
  const path = envAgentPath(); const domain = `gui/${process.getuid!()}`; const target = `${domain}/${envAgentLabel}`;
  const contents = envAgentPlist(wrapper);
  if (existing !== contents) {
    if (existing !== undefined) await exec("/bin/launchctl", ["bootout", target]).catch(() => undefined);
    await failing("write", async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      try { await writeFile(temporary, contents, { mode: 0o600 }); await rename(temporary, path); }
      catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    });
  }
  let loaded = false; try { await exec("/bin/launchctl", ["print", target]); loaded = true; } catch { /* Not loaded yet. */ }
  await failing("bootstrap", () => ensureLaunchAgent(domain, envAgentLabel, path, loaded, args => exec("/bin/launchctl", args)));
}
/** Boots the agent out and moves its plist to the Trash. The caller has already proven it is ours. */
export async function removeEnvAgent(existing: string | undefined, exec: EnvAgentExec): Promise<void> {
  if (existing === undefined) return;
  const path = envAgentPath();
  await exec("/bin/launchctl", ["bootout", `gui/${process.getuid!()}/${envAgentLabel}`]).catch(() => undefined);
  const trash = resolve(homedir(), ".Trash"); await mkdir(trash, { recursive: true });
  await rename(path, resolve(trash, `${envAgentLabel}.${Date.now()}.plist`));
}
/**
 * What the login (GUI) domain holds for the two desktop variables, from the `environment` block of
 * `launchctl print gui/<uid>`; `launchctl getenv` run over SSH reads another domain. Only those two keys are read:
 * the CLI path itself, and whether FORCE_CLI is present and non-empty (its value is never kept). A failing print
 * falls back to `getenv` for both. A real `getenv` failure propagates, so an unreadable session never looks unset.
 */
export async function readGuiDesktopEnv(exec: EnvAgentExec, getenv: (name: string) => Promise<string>): Promise<{ cliPath: string; forceCliSet: boolean; forceCli1: boolean }> {
  let printed: string;
  try { printed = (await exec("/bin/launchctl", ["print", `gui/${process.getuid!()}`])).stdout; }
  catch { const cliPath = await getenv("CODEX_CLI_PATH"); const force = await getenv("CODEX_APP_SERVER_FORCE_CLI"); return { cliPath, forceCliSet: force !== "", forceCli1: force === "1" }; }
  let inside = false; let cliPath = ""; let force = "";
  for (const line of printed.split("\n")) {
    if (!inside) { if (/^\s*environment = \{\s*$/.test(line)) inside = true; continue; }
    if (/^\s*\}\s*$/.test(line)) break;
    const cli = /^\s*CODEX_CLI_PATH => ([^\r\n]*)\r?$/.exec(line); if (cli) cliPath = cli[1]!;
    const flag = /^\s*CODEX_APP_SERVER_FORCE_CLI => ([^\r\n]*)\r?$/.exec(line); if (flag) force = flag[1]!;
  }
  return { cliPath, forceCliSet: force !== "", forceCli1: force === "1" };
}
