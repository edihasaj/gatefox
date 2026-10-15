import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
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
    const cliPath = await environment("CODEX_CLI_PATH"); const owned = !!registration.wrapper && cliPath === registration.wrapper;
    return { registered: !!registration.wrapper, activeForFutureLaunches: owned, legacyForceCli: owned && await environment("CODEX_APP_SERVER_FORCE_CLI") === "1" };
  }
  let existing: string | undefined; try { existing = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing && !existing.includes(marker)) throw new Error("Refusing to change an unmanaged desktop LaunchAgent");
  if (action === "unregister") {
    if (unified || pending) throw new Error("Desktop registration is owned by the unified service or its pending login plan. Finish that migration before unregistering the desktop adapter");
    if (registration.wrapper && await environment("CODEX_CLI_PATH") === registration.wrapper) {
      await exec("/bin/launchctl", ["unsetenv", "CODEX_CLI_PATH"]);
      if (await environment("CODEX_APP_SERVER_FORCE_CLI") === "1") await exec("/bin/launchctl", ["unsetenv", "CODEX_APP_SERVER_FORCE_CLI"]);
    }
    if (existing) { await exec("/bin/launchctl", ["bootout", target]).catch(() => undefined); const trash = resolve(homedir(), ".Trash"); await mkdir(trash, { recursive: true }); await rename(path, resolve(trash, `${label}.${Date.now()}.plist`)); }
    await writePrivateJson(receipt, {}); return { registered: false, nativeConfigUntouched: true };
  }
  const { wrapper } = await prepareDesktop(configPath, app); const previous = await environment("CODEX_CLI_PATH");
  if (previous && previous !== wrapper && previous !== registration.wrapper) throw new Error("Another desktop CLI override is active; it was not replaced");
  // Older gateways exported FORCE_CLI=1 beside CODEX_CLI_PATH. It is ours only when the receipt and the
  // current CLI path prove the pair; any other value, or a "1" without that proof, belongs to someone else.
  const force = await environment("CODEX_APP_SERVER_FORCE_CLI"); const ours = !!registration.wrapper && !!previous && (previous === registration.wrapper || previous === wrapper);
  if (force && !(force === "1" && ours)) throw new Error("Another desktop CLI mode is active; it was not replaced");
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
