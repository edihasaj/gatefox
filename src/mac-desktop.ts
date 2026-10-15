import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { loadConfig, writePrivateJson } from "./config.js";
import { prepareDesktop } from "./desktop-launch.js";
import { gatewayCommand } from "./command.js";
import { isOwnWrapperPath } from "./desktop-wrapper-path.js";
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
/** The part of an entry's status that ownership needs: what kind of entry it is, and who owns it. */
export type WrapperStat = (path: string) => Promise<{ isFile(): boolean; isSymbolicLink(): boolean; uid: number }>;
/**
 * An older gateway exported CODEX_CLI_PATH beside FORCE_CLI=1. That path is ours only when its spelling passes the
 * shared wrapper rule (see desktop-wrapper-path.ts) for this state directory, and the entry it names is a regular
 * file owned by this user or is missing because a cleanup already removed it. A symlink, a directory, or any other
 * probe failure proves nothing, so it stays foreign; a deleted stale wrapper stays replaceable.
 * `stat` and `uid` are seams: production uses `lstat` and this process's uid, and a test can supply either
 * without a root-owned file in the state directory.
 */
export const ownWrapper = async (stateDirectory: string, value: string, stat: WrapperStat = lstat, uid = process.getuid?.()): Promise<boolean> => {
  if (!isOwnWrapperPath(value, stateDirectory)) return false;
  try { const info = await stat(value); return info.isFile() && !info.isSymbolicLink() && info.uid === uid; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
};
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
/**
 * One `launchctl getenv`. A failing read propagates instead of looking like an unset variable, and launchctl prints
 * the value followed by one newline, so exactly that terminator is removed; any other whitespace is part of the
 * value. The value itself is only ever compared, never reported.
 */
const getenv = async (exec: LaunchctlExec, name: string) => (await exec("/bin/launchctl", ["getenv", name])).stdout.replace(/\n$/, "");
/** The last registration's receipt, or nothing where unregister cleared it or it never existed. Unreadable JSON fails the caller. */
async function readReceipt(receipt: string): Promise<{ wrapper?: string }> {
  try { return JSON.parse(await readFile(receipt, "utf8")) as { wrapper?: string }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return {}; }
}
/** The desktop LaunchAgent's contents, or none where the file is absent. A plist without our marker is not ours to change. */
async function readDesktopPlist(path: string): Promise<string | undefined> {
  let contents: string | undefined; try { contents = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (contents && !contents.includes(marker)) throw new Error("Refusing to change an unmanaged desktop LaunchAgent");
  return contents;
}
export async function macDesktop(action: string, configPath: string, app = "/Applications/ChatGPT.app", restoreOnly = false, exec: LaunchctlExec = launchctlExec): Promise<Record<string, unknown>> {
  if (action === "status") return desktopOperation(action, configPath, app, restoreOnly, exec);
  const config = await loadConfig(configPath);
  return withLoginRegistrationLock(config.stateDirectory, () => desktopOperation(action, configPath, app, restoreOnly, exec));
}

/** What unregister has found about the session, before any of it is changed. */
type UnregisterPlan = {
  /** The receipt that unregister clears. */
  receipt: string;
  /** The desktop LaunchAgent that unregister moves to the Trash, its contents as read, and its launchd target. */
  plist: string; existing: string | undefined; target: string;
  /** Whether the receipt names a wrapper. */
  registered: boolean;
  /** Whether the session's CODEX_CLI_PATH is a wrapper this gateway wrote. */
  ownPath: boolean;
  /** FORCE_CLI. Read only once the path proved itself ours, so "" also means "not ours to read". */
  force: string;
};
/**
 * The read half of unregister, and the half `gateway uninstall` runs as a preflight. Reads only: whoever owns the
 * registration, then the plist and the marker that says it is ours to remove, then the receipt, then the session.
 * The marker is checked before a single launchctl call, so an unmanaged desktop LaunchAgent refuses while nothing
 * of ours has been touched.
 */
async function planUnregister(stateDirectory: string, exec: LaunchctlExec): Promise<UnregisterPlan> {
  if (await readServicePlan(stateDirectory) || await readPendingLoginConsolidation(stateDirectory)) throw new Error("Desktop registration is owned by the unified service or its pending login plan. Finish that migration before unregistering the desktop adapter");
  const receipt = resolve(stateDirectory, "desktop-registration.json");
  const plist = resolve(homedir(), "Library/LaunchAgents", label + ".plist");
  const existing = await readDesktopPlist(plist);
  const registration = await readReceipt(receipt);
  const cliPath = await getenv(exec, "CODEX_CLI_PATH");
  // Ownership is decided from the session as it is now, before any write, so a later failure cannot leave a
  // half-cleared pair behind, and so the call order is always reads first then writes.
  const ownPath = (!!registration.wrapper && cliPath === registration.wrapper) || (!!cliPath && await ownWrapper(stateDirectory, cliPath));
  // FORCE_CLI is read only once the path proves itself ours, and an unset name reads as the empty string.
  return { receipt, plist, existing, target: `gui/${process.getuid!()}/${label}`,
    registered: !!registration.wrapper, ownPath, force: ownPath ? await getenv(exec, "CODEX_APP_SERVER_FORCE_CLI") : "" };
}
/** The writes unregister does after the plan above, in the order they have always happened: env, then plist, then receipt. */
async function applyUnregister(plan: UnregisterPlan, exec: LaunchctlExec): Promise<Record<string, unknown>> {
  // The plist is read again, before the first write, because the plan proved it was ours only moments ago: a file
  // that took its place in between is refused rather than moved to the Trash.
  const existing = await readDesktopPlist(plan.plist);
  let legacyForceCliKept = false;
  if (plan.ownPath) {
    await exec("/bin/launchctl", ["unsetenv", "CODEX_CLI_PATH"]);
    if (plan.force === "1") {
      // The value is ours to clear only when the receipt names a wrapper. An own path beside an empty or missing
      // receipt proves the path is ours, not that we ever exported the pair, so the 1 stays beside the path we
      // just cleared. legacyForceCliKept says so: the next register refuses until the value is cleared by hand.
      if (plan.registered) await exec("/bin/launchctl", ["unsetenv", "CODEX_APP_SERVER_FORCE_CLI"]);
      else legacyForceCliKept = true;
    }
  }
  if (existing) { await exec("/bin/launchctl", ["bootout", plan.target]).catch(() => undefined); const trash = resolve(homedir(), ".Trash"); await mkdir(trash, { recursive: true }); await rename(plan.plist, resolve(trash, `${label}.${Date.now()}.plist`)); }
  await writePrivateJson(plan.receipt, {});
  return { registered: false, nativeConfigUntouched: true, ...(legacyForceCliKept ? { legacyForceCliKept: true } : {}) };
}
/**
 * The preflight form of `gateway desktop unregister`: the same reads, under the same lock, with no writes at all.
 * `gateway uninstall` runs it before it removes anything, so a refusal lands while the service and native
 * components are still in place. The answer describes what unregister would do, in words: no path and no variable
 * value leaves this function.
 */
export async function planDesktopUnregister(configPath: string, exec: LaunchctlExec = launchctlExec): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin") throw new Error("Choose gateway desktop register, unregister or status on macOS");
  const config = await loadConfig(configPath);
  const plan = await withLoginRegistrationLock(config.stateDirectory, () => planUnregister(config.stateDirectory, exec));
  // The same truthiness the apply step uses to decide whether there is a plist to move, so the plan cannot
  // promise to trash a file it would then leave alone.
  return { unregisterReady: true, loginAgent: plan.existing ? "managed" : "absent", cliPathOurs: plan.ownPath,
    receiptNamesWrapper: plan.registered, ...(plan.ownPath && !plan.registered && plan.force === "1" ? { legacyForceCliKept: true } : {}) };
}
async function desktopOperation(action: string, configPath: string, app: string, restoreOnly: boolean, exec: LaunchctlExec): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin" || !["register", "unregister", "status"].includes(action)) throw new Error("Choose gateway desktop register, unregister or status on macOS");
  const config = await loadConfig(configPath);
  if (action === "unregister") return applyUnregister(await planUnregister(config.stateDirectory, exec), exec);
  const receipt = resolve(config.stateDirectory, "desktop-registration.json");
  const unified = await readServicePlan(config.stateDirectory);
  const pending = await readPendingLoginConsolidation(config.stateDirectory);
  const path = resolve(homedir(), "Library/LaunchAgents", label + ".plist"); const domain = `gui/${process.getuid!()}`; const target = `${domain}/${label}`;
  const registration = await readReceipt(receipt);
  if (action === "status") {
    const cliPath = await getenv(exec, "CODEX_CLI_PATH");
    // One getenv answers both FORCE_CLI questions. A real `launchctl getenv` exits 0 with empty stdout for an
    // unset name, so the variable counts as set only when it holds a non-empty value; the value itself never
    // reaches the output.
    const force = await getenv(exec, "CODEX_APP_SERVER_FORCE_CLI");
    const fromReceipt = !!registration.wrapper && cliPath === registration.wrapper;
    const owned = fromReceipt || (!!cliPath && await ownWrapper(config.stateDirectory, cliPath));
    // Future launches use the registered wrapper, so an older one we still own is stale, not active. Ownership
    // only decides whether the legacy FORCE_CLI value is ours to clear.
    return { registered: !!registration.wrapper, activeForFutureLaunches: fromReceipt, forceCliSet: force !== "",
      legacyForceCli: owned && !!registration.wrapper && force === "1",
      ...(owned && !fromReceipt ? { staleWrapper: true } : {}) };
  }
  const existing = await readDesktopPlist(path);
  const { wrapper } = await prepareDesktop(configPath, app); const previous = await getenv(exec, "CODEX_CLI_PATH");
  const ownPrevious = !!previous && await ownWrapper(config.stateDirectory, previous);
  // The refusal names the variable it refuses, never its value, and gives the next step for an override the
  // caller no longer uses.
  if (previous && previous !== wrapper && previous !== registration.wrapper && !ownPrevious) throw new Error(
    "Another desktop CLI override is active; it was not replaced. CODEX_CLI_PATH names a CLI this gateway did not register. If that override is no longer used, run `launchctl unsetenv CODEX_CLI_PATH`, then register again.");
  // Older gateways exported FORCE_CLI=1 beside CODEX_CLI_PATH. It is ours only when the receipt names a wrapper
  // and the CLI path is a gateway wrapper (the receipt's, the current one, or an older one in this state
  // directory); any other value, or a "1" without that proof, belongs to someone else.
  const force = await getenv(exec, "CODEX_APP_SERVER_FORCE_CLI");
  if (force === "1" && ownPrevious && !registration.wrapper) throw new Error("CODEX_APP_SERVER_FORCE_CLI is set to the legacy value beside a gateway wrapper, but no registration receipt proves the gateway set it. If it came from the gateway, run `launchctl unsetenv CODEX_APP_SERVER_FORCE_CLI` and register again.");
  const ours = !!registration.wrapper && !!previous && (previous === registration.wrapper || previous === wrapper || ownPrevious);
  // A 1 that nothing proves is ours gets the remedy, not just a refusal; any other value stays nameless so a
  // foreign setting is never echoed back.
  if (force && !(force === "1" && ours)) throw new Error(force === "1"
    ? "CODEX_APP_SERVER_FORCE_CLI is set to the legacy value and nothing proves the gateway set it. Run `launchctl unsetenv CODEX_APP_SERVER_FORCE_CLI`, then register again."
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
