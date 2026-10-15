import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, normalize, resolve, sep } from "node:path";
import { loadConfig, writePrivateJson } from "./config.js";
import { prepareDesktop } from "./desktop-launch.js";
import { gatewayCommand } from "./command.js";
import { readServicePlan } from "./service-plan.js";
import { ensureLaunchAgent } from "./mac-launch-agent.js";
import { readPendingLoginConsolidation } from "./mac-login-consolidate.js";
import { withLoginRegistrationLock } from "./login-registration-lock.js";

const execFileAsync = promisify(execFile); const label = "com.edihasaj.subscription-gateway.desktop"; const marker = "<!-- Managed by subscription-gateway desktop -->";
/** Seam for every launchctl call so a registration test can observe the GUI session without changing it. */
export type LaunchctlExec = (file: string, args: string[]) => Promise<{ stdout: string }>;
type ExecFileWithTimeout = (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;
/** The real session's launchctl: every call, including enable and bootstrap, is bounded by the same 10 s timeout. */
export const launchctlRunner = (run: ExecFileWithTimeout = (file, args, options) => execFileAsync(file, args, options)): LaunchctlExec =>
  (file, args) => run(file, args, { timeout: 10000 });
const launchctlExec = launchctlRunner();
/**
 * An older gateway exported CODEX_CLI_PATH beside FORCE_CLI=1. That path is ours only when it is an absolute,
 * already-normalised name of a regular file owned by this user, or of an entry that no longer exists, sitting
 * directly in this state directory with a generated wrapper name. A relative path, one that climbs through `..`
 * or ends in a slash, a symlink, or a directory is foreign; a deleted stale wrapper stays replaceable.
 */
const ownWrapper = async (stateDirectory: string, value: string): Promise<boolean> => {
  // normalize keeps a trailing separator, so a path that ends in one is rejected on its own.
  if (!isAbsolute(value) || value.endsWith(sep) || normalize(value) !== value || dirname(value) !== resolve(stateDirectory)) return false;
  if (!/^desktop-wrapper-[0-9a-f]{16}$/.test(basename(value))) return false;
  try { const info = await lstat(value); return info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.(); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
};
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export async function macDesktop(action: string, configPath: string, app = "/Applications/ChatGPT.app", restoreOnly = false, exec: LaunchctlExec = launchctlExec): Promise<Record<string, unknown>> {
  if (action === "status") return desktopOperation(action, configPath, app, restoreOnly, exec);
  const config = await loadConfig(configPath);
  return withLoginRegistrationLock(config.stateDirectory, () => desktopOperation(action, configPath, app, restoreOnly, exec));
}
async function desktopOperation(action: string, configPath: string, app: string, restoreOnly: boolean, exec: LaunchctlExec): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin" || !["register", "unregister", "status"].includes(action)) throw new Error("Choose gateway desktop register, unregister or status on macOS");
  const config = await loadConfig(configPath); const receipt = resolve(config.stateDirectory, "desktop-registration.json");
  const unified = await readServicePlan(config.stateDirectory);
  const pending = await readPendingLoginConsolidation(config.stateDirectory);
  const path = resolve(homedir(), "Library/LaunchAgents", label + ".plist"); const domain = `gui/${process.getuid!()}`; const target = `${domain}/${label}`;
  const environment = async (name: string) => (await exec("/bin/launchctl", ["getenv", name]).catch(() => ({ stdout: "" }))).stdout.trim();
  let registration: { wrapper?: string } = {}; try { registration = JSON.parse(await readFile(receipt, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (action === "status") {
    const cliPath = await environment("CODEX_CLI_PATH");
    // One getenv answers both FORCE_CLI questions. forceCliSet is presence only: it is true when the session
    // holds the variable at all, whatever its value, and the value itself never reaches the output.
    const force = await exec("/bin/launchctl", ["getenv", "CODEX_APP_SERVER_FORCE_CLI"]).then(result => result.stdout.trim(), () => undefined);
    const fromReceipt = !!registration.wrapper && cliPath === registration.wrapper;
    const owned = fromReceipt || (!!cliPath && await ownWrapper(config.stateDirectory, cliPath));
    // Future launches use the registered wrapper, so an older one we still own is stale, not active. Ownership
    // only decides whether the legacy FORCE_CLI value is ours to clear.
    return { registered: !!registration.wrapper, activeForFutureLaunches: fromReceipt, forceCliSet: force !== undefined,
      legacyForceCli: owned && !!registration.wrapper && force === "1",
      ...(owned && !fromReceipt ? { staleWrapper: true } : {}) };
  }
  let existing: string | undefined; try { existing = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing && !existing.includes(marker)) throw new Error("Refusing to change an unmanaged desktop LaunchAgent");
  if (action === "unregister") {
    if (unified || pending) throw new Error("Desktop registration is owned by the unified service or its pending login plan. Finish that migration before unregistering the desktop adapter");
    const cliPath = await environment("CODEX_CLI_PATH");
    // FORCE_CLI is ours to clear only when the receipt names a wrapper. An own path beside an empty or missing
    // receipt proves the path is ours, not that we ever exported the pair, so the 1 stays beside the path we
    // just cleared. legacyForceCliKept says so: the next register refuses until the value is cleared by hand.
    let legacyForceCliKept = false;
    if ((!!registration.wrapper && cliPath === registration.wrapper) || (!!cliPath && await ownWrapper(config.stateDirectory, cliPath))) {
      await exec("/bin/launchctl", ["unsetenv", "CODEX_CLI_PATH"]);
      if (await environment("CODEX_APP_SERVER_FORCE_CLI") === "1") {
        if (registration.wrapper) await exec("/bin/launchctl", ["unsetenv", "CODEX_APP_SERVER_FORCE_CLI"]);
        else legacyForceCliKept = true;
      }
    }
    if (existing) { await exec("/bin/launchctl", ["bootout", target]).catch(() => undefined); const trash = resolve(homedir(), ".Trash"); await mkdir(trash, { recursive: true }); await rename(path, resolve(trash, `${label}.${Date.now()}.plist`)); }
    await writePrivateJson(receipt, {});
    return { registered: false, nativeConfigUntouched: true, ...(legacyForceCliKept ? { legacyForceCliKept: true } : {}) };
  }
  const { wrapper } = await prepareDesktop(configPath, app); const previous = await environment("CODEX_CLI_PATH");
  const ownPrevious = !!previous && await ownWrapper(config.stateDirectory, previous);
  // The refusal names the variable it refuses, never its value, and gives the next step for an override the
  // caller no longer uses.
  if (previous && previous !== wrapper && previous !== registration.wrapper && !ownPrevious) throw new Error(
    "Another desktop CLI override is active; it was not replaced. CODEX_CLI_PATH names a CLI this gateway did not register. If that override is no longer used, run `launchctl unsetenv CODEX_CLI_PATH`, then register again.");
  // Older gateways exported FORCE_CLI=1 beside CODEX_CLI_PATH. It is ours only when the receipt names a wrapper
  // and the CLI path is a gateway wrapper (the receipt's, the current one, or an older one in this state
  // directory); any other value, or a "1" without that proof, belongs to someone else.
  const force = await environment("CODEX_APP_SERVER_FORCE_CLI");
  if (force === "1" && ownPrevious && !registration.wrapper) throw new Error("CODEX_APP_SERVER_FORCE_CLI=1 is set beside a gateway wrapper, but no registration receipt proves the gateway set it. If it came from the gateway, run `launchctl unsetenv CODEX_APP_SERVER_FORCE_CLI` and register again.");
  const ours = !!registration.wrapper && !!previous && (previous === registration.wrapper || previous === wrapper || ownPrevious);
  // A 1 that nothing proves is ours gets the remedy, not just a refusal; any other value stays nameless so a
  // foreign setting is never echoed back.
  if (force && !(force === "1" && ours)) throw new Error(force === "1"
    ? "CODEX_APP_SERVER_FORCE_CLI=1 is set and nothing proves the gateway set it. Run `launchctl unsetenv CODEX_APP_SERVER_FORCE_CLI`, then register again."
    : "Another desktop CLI mode is active; it was not replaced");
  // Clearing ours returns durable chats and SSH rows to native execution; CODEX_CLI_PATH alone keeps local
  // chats on the gateway. Before the early return below so unified re-registration and upgrades clean it too.
  if (force) await exec("/bin/launchctl", ["unsetenv", "CODEX_APP_SERVER_FORCE_CLI"]);
  const helper = gatewayCommand(); const args = [helper.command, ...helper.args, "desktop", "register", "--config", configPath, "--app", app];
  const contents = `<?xml version="1.0" encoding="UTF-8"?>\n${marker}\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array><key>RunAtLoad</key><true/></dict></plist>\n`;
  await writePrivateJson(receipt, { wrapper, registeredAt: new Date().toISOString() });
  await exec("/bin/launchctl", ["setenv", "CODEX_CLI_PATH", wrapper]);
  if (restoreOnly || unified || pending) return { registered: true, activeForFutureLaunches: true, nativeConfigUntouched: true, loginHook: pending ? "unified service at next login" : "unified service" };
  if (existing !== contents) { if (existing) await exec("/bin/launchctl", ["bootout", target]).catch(() => undefined); await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents, { mode: 0o600 }); }
  let loaded = false; try { await exec("/bin/launchctl", ["print", target]); loaded = true; } catch { /* Restore an explicitly registered login hook. */ }
  // One path for production and tests: every launchctl call goes through exec, so no branch decides whether a test reaches the real session.
  await ensureLaunchAgent(domain, label, path, loaded, args => exec("/bin/launchctl", args));
  return { registered: true, activeForFutureLaunches: true, freshAppLaunchRequired: true, nativeConfigUntouched: true };
}
