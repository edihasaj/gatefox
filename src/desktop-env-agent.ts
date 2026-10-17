import { readFile, mkdir, rename, writeFile, unlink, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { ensureLaunchAgent } from "./mac-launch-agent.js";
import { isOwnWrapperPath } from "./desktop-wrapper-path.js";
import { gatewayCommand } from "./command.js";

/**
 * The login-time environment agent. ChatGPT is a login item and can start before the unified service has set
 * CODEX_CLI_PATH, in which case the app launches its own engine and runs without the gateway. This tiny LaunchAgent
 * sets the variable at login, before anything slower can run. It is not a service component: it has no node, no
 * KeepAlive and no environment of its own, and consolidation neither collects nor retires it.
 *
 * macOS names a background item after the executable in ProgramArguments[0]. Running `/bin/launchctl` directly would
 * list the item as "launchctl", so the agent runs a private script in the state directory named `harness-gateway-login-env`
 * whose one command is that `launchctl setenv`.
 */
export const envAgentLabel = "com.edihasaj.subscription-gateway.desktop-env";
export const envAgentMarker = "<!-- Managed by subscription-gateway desktop-env -->";
export const envAgentScriptName = "harness-gateway-login-env";
export const envAgentScriptMarker = "# Managed by subscription-gateway desktop-env";
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
const unxml = (value: string) => value.replaceAll("&apos;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export const envAgentPath = () => resolve(homedir(), "Library/LaunchAgents", envAgentLabel + ".plist");
export const envAgentScriptPath = (stateDirectory: string) => resolve(stateDirectory, envAgentScriptName);
/**
 * The file that proves a gateway can still run: the installed release's CLI, or the CLI this process runs from where the
 * command is not installed. The script checks it at every login, so an agent left behind by a gateway that was removed
 * (for example by a rollback to a release that does not know the agent) sets nothing.
 */
export function agentRuntimeFile(): string {
  const command = gatewayCommand();
  return command.args.length ? command.args[0]! : resolve(dirname(command.command), "../share/subscription-gateway/current/package/dist/cli.js");
}
/**
 * The private script for one registered wrapper. It sets the variable only while both the wrapper and the gateway
 * release exist; otherwise it exits 0 and sets nothing, so a gateway that was uninstalled or unregistered by an older
 * release is not set up again at the next login.
 */
export const envAgentScript = (wrapper: string, runtimeFile = agentRuntimeFile()): string =>
  `#!/bin/sh\n${envAgentScriptMarker}\n[ -x ${shellQuote(wrapper)} ] && [ -f ${shellQuote(runtimeFile)} ] || exit 0\nexec /bin/launchctl setenv CODEX_CLI_PATH ${shellQuote(wrapper)}\n`;
/** The whole plist for one script; its only program argument is the script, so macOS lists it by that name. */
export function envAgentPlist(script: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${envAgentMarker}\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${envAgentLabel}</string>\n<key>ProgramArguments</key><array><string>${xml(script)}</string></array>\n<key>RunAtLoad</key><true/>\n<key>LimitLoadToSessionType</key><string>Aqua</string>\n</dict></plist>\n`;
}
/** The script a managed agent plist runs, or nothing for an agent written before the script existed (it ran launchctl directly). */
export function envAgentScriptOf(contents: string | undefined): string | undefined {
  const match = contents ? /<key>ProgramArguments<\/key><array><string>([^<]*)<\/string><\/array>/.exec(contents) : undefined;
  const script = match ? unxml(match[1]!) : undefined;
  return script && basename(script) === envAgentScriptName ? script : undefined;
}
async function readIfExists(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
}
/** The agent's contents, or nothing where it is absent. A plist without our marker is not ours to change. */
export async function readEnvAgent(path = envAgentPath()): Promise<string | undefined> {
  let contents: string | undefined;
  try { contents = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (contents !== undefined && !contents.includes(envAgentMarker)) throw new EnvAgentError("unmanaged", "Refusing to change an unmanaged desktop environment LaunchAgent");
  return contents;
}
/** Whether the agent exists, is ours, and its script sets exactly this wrapper. */
export async function envAgentNames(contents: string | undefined, wrapper: string | undefined): Promise<boolean> {
  const script = envAgentScriptOf(contents);
  if (!contents || !wrapper || !script) return false;
  return await readIfExists(script).catch(() => undefined) === envAgentScript(wrapper);
}
/**
 * Writes or updates the agent for `wrapper` and loads it into the login session. The wrapper must be a generated
 * wrapper in the gateway state directory: the stable registered path, never a release path. The file is private and
 * replaced atomically; a changed agent is booted out first, and an unchanged one is only enabled and loaded if missing.
 */
export async function writeEnvAgent(stateDirectory: string, wrapper: string, existing: string | undefined, exec: EnvAgentExec): Promise<void> {
  if (!isOwnWrapperPath(wrapper, stateDirectory)) throw new EnvAgentError("other", "The desktop environment agent only names a wrapper in the gateway state directory");
  const path = envAgentPath(); const domain = `gui/${process.getuid!()}`; const target = `${domain}/${envAgentLabel}`;
  const script = envAgentScriptPath(stateDirectory); const contents = envAgentPlist(script);
  // The script comes first, so the agent never names a script that is not there yet. One without our marker is not ours.
  await failing("write", async () => {
    const prior = await readIfExists(script); const text = envAgentScript(wrapper);
    if (prior !== undefined && !prior.includes(envAgentScriptMarker)) throw new EnvAgentError("unmanaged", "Refusing to change an unmanaged desktop environment script");
    if (prior === text) return;
    await mkdir(dirname(script), { recursive: true, mode: 0o700 });
    const temporary = `${script}.${process.pid}.tmp`;
    try { await writeFile(temporary, text, { mode: 0o700 }); await chmod(temporary, 0o700); await rename(temporary, script); }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  });
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
/**
 * Boots the agent out and moves its script and plist to the Trash. The caller has already proven the plist is ours;
 * the script is moved only when it carries our marker, so a foreign file at that path stays where it is.
 */
export async function removeEnvAgent(existing: string | undefined, exec: EnvAgentExec): Promise<void> {
  if (existing === undefined) return;
  const path = envAgentPath();
  await exec("/bin/launchctl", ["bootout", `gui/${process.getuid!()}/${envAgentLabel}`]).catch(() => undefined);
  const trash = resolve(homedir(), ".Trash"); await mkdir(trash, { recursive: true });
  const script = envAgentScriptOf(existing);
  if (script && (await readIfExists(script).catch(() => undefined))?.includes(envAgentScriptMarker)) await rename(script, resolve(trash, `${envAgentScriptName}.${Date.now()}`));
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
