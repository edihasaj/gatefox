import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, writePrivateJson } from "./config.js";
import { nativeRelayHome } from "./native-control.js";
import { gatewayCommand, launcherName, legacyLauncherName } from "./command.js";
import { readServicePlan } from "./service-plan.js";
import { consolidatedStatus } from "./mac-consolidate.js";
import { readPendingLoginConsolidation } from "./mac-login-consolidate.js";
import { withLoginRegistrationLock } from "./login-registration-lock.js";
import { registerPlanRelay, relayCheck, unregisterPlanRelay, type PlanRelayDeps } from "./native-plan-registration.js";
import { chatGptAppRunning } from "./native-pause.js";
import { clearSlotHolders, type HolderDeps } from "./native-slot-holders.js";
import { sshControlHome } from "./ssh-socket.js";
import { configureTelemetry } from "./telemetry.js";

const exec = promisify(execFile);
const label = "com.edihasaj.subscription-gateway.native";
const marker = "<!-- Managed by subscription-gateway native -->";
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

async function status(target: string): Promise<Record<string, unknown>> {
  try { const { stdout } = await exec("/bin/launchctl", ["print", target], { timeout: 5000 }); return { installed: true, state: stdout.match(/^\s*state = (.+)$/m)?.[1], pid: Number(stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || undefined }; }
  catch { return { installed: false }; }
}

async function enable(binary: string, args: string[]): Promise<void> {
  const child = spawn(binary, [...args, "--enable"], { stdio: ["pipe", "pipe", "ignore"] });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  const lines = createInterface({ input: child.stdout });
  let hardStop: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Native relay did not connect within 45 seconds")), 45000).unref();
      const finish = (error?: Error) => { clearTimeout(timeout); error ? reject(error) : resolve(); };
      child.once("error", () => finish(new Error("Native relay could not start")));
      child.once("close", () => finish(new Error("Native relay stopped before connecting; check the Codex build and host sign-in")));
      lines.on("line", line => {
        let message: { method?: string; params?: { status?: string } };
        try { message = JSON.parse(line); } catch { finish(new Error("Native relay returned invalid status")); return; }
        if (message.method === "remoteControl/status/changed" && message.params?.status === "connected") finish();
      });
    });
  } finally {
    child.stdin.end(); hardStop = setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    await exited; clearTimeout(hardStop); lines.close();
  }
}

/**
 * Whether the installed plist is this registration. A relay started by 0.4.5 names `.../bin/gateway` in its `--gateway`
 * argument and the same plist written now names `.../bin/harness-gateway`; both launchers run the same command, so
 * that difference alone is not "another registration" and does not force an uninstall.
 */
export function sameNativeRegistration(existing: string | undefined, contents: string, command: string): boolean {
  if (existing === contents) return true;
  if (existing === undefined || basename(command) !== launcherName) return false;
  const older = `<string>${xml(resolve(dirname(command), legacyLauncherName))}</string>`; const current = `<string>${xml(command)}</string>`;
  return existing === contents.replace(current, older);
}
/** The side effects of a unified-plan install; a test replaces all of them so it can never reach a process, ChatGPT or launchd. */
export type NativeOptions = { codex?: string; nativeHome?: string; planDeps?: Partial<PlanRelayDeps>; holderDeps?: HolderDeps };
export async function macNative(action: string | undefined, configPath: string, options: NativeOptions = {}): Promise<Record<string, unknown>> {
  if (action === "status") return nativeOperation(action, configPath, options);
  const config = await loadConfig(configPath);
  return withLoginRegistrationLock(config.stateDirectory, () => nativeOperation(action, configPath, options));
}
async function nativeOperation(action: string | undefined, configPath: string, options: NativeOptions): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin" || !["install", "status", "uninstall"].includes(action || "")) throw new Error("Choose gateway native install, status, or uninstall on macOS");
  const config = await loadConfig(configPath);
  const nativeHome = resolve(options.nativeHome || process.env.CODEX_HOME || resolve(homedir(), ".codex"));
  const home = nativeRelayHome(configPath, nativeHome);
  const receipt = resolve(config.stateDirectory, "native-registration.json");
  const domain = `gui/${process.getuid!()}`; const target = `${domain}/${label}`;
  const path = resolve(homedir(), "Library/LaunchAgents", label + ".plist");
  const plan = await readServicePlan(config.stateDirectory);
  if (action === "status") {
    let relay = {}; try { relay = JSON.parse(await readFile(resolve(home, "status.json"), "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return plan ? { service: "com.edihasaj.subscription-gateway", mode: "supervised", component: "native", ...await consolidatedStatus(config.stateDirectory), relay } : { service: label, ...await status(target), relay };
  }
  // Under the unified plan, uninstall is the way out of a registered relay that cannot run: it only unregisters (see native-plan-registration.ts).
  if (plan && action === "uninstall") return unregisterPlanRelay(config.stateDirectory);
  if (plan && action !== "install") throw new Error("Native transport is owned by the unified service. Finish chats and uninstall that service before changing its transport registration");
  if (await readPendingLoginConsolidation(config.stateDirectory)) throw new Error("Native transport startup is staged under the unified service at next login; its separate registration was not changed");
  // Under the unified service, install only registers the relay the service already runs (see native-plan-registration.ts).
  if (plan) {
    configureTelemetry(config.stateDirectory, "native-install");
    // The SSH listeners of this native home keep their activity records under the SSH control home the adapter derives from the same config.
    return registerPlanRelay(config.stateDirectory, plan, { appRunning: () => chatGptAppRunning(), check: (binary, args) => relayCheck(binary, args), enable,
      clearHolders: pendingAtMs => clearSlotHolders({ configPath, sshHome: sshControlHome(configPath, nativeHome), pendingAtMs }, options.holderDeps), ...options.planDeps });
  }
  let existing: string | undefined; try { existing = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing && !existing.includes(marker)) throw new Error("Refusing to replace an unmanaged native relay service");
  if (action === "uninstall") {
    if ((await status(target)).installed) await exec("/bin/launchctl", ["bootout", target], { timeout: 10000 });
    if (existing) { const trash = resolve(homedir(), ".Trash"); await mkdir(trash, { recursive: true }); await rename(path, resolve(trash, `${label}.${Date.now()}.plist`)); }
    await writePrivateJson(receipt, { registered: false });
    return { installed: false, nativeConfigUntouched: true, relayStatePreserved: true, freshAppLaunchRequired: true };
  }
  const command = gatewayCommand(); if (command.args.length) throw new Error("Native registration requires the installed gateway command");
  const binary = fileURLToPath(new URL("../native/gateway-native-relay", import.meta.url));
  try { await stat(binary); } catch { throw new Error("This installer has no native relay binary; install a release containing the native adapter"); }
  const codex = resolve(options.codex || "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
  const args = ["--native-home", nativeHome, "--relay-home", home, "--gateway", command.command, "--gateway-config", configPath, "--codex", codex];
  const paths = [...new Set([dirname(process.execPath), resolve(homedir(), ".local/bin"), ...(process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin").split(":").filter(path => path.startsWith("/"))])].join(":");
  const log = resolve(home, "service.log");
  const contents = `<?xml version="1.0" encoding="UTF-8"?>\n${marker}\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[binary, ...args, "--daemon"].map(arg => `<string>${xml(arg)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(paths)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`;
  const current = await status(target);
  if (current.installed && !sameNativeRegistration(existing, contents, command.command)) throw new Error("The native relay is running with another registration; keep it until active chats finish, then uninstall and install the new registration");
  if (!current.installed) {
    const { stdout } = await exec("/bin/ps", ["-axo", "comm="]);
    if (stdout.split("\n").some(command => command.trim() === "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT")) throw new Error("Quit ChatGPT normally on this test machine before activating the native adapter; it must replace the original remote transport without two hosts competing");
    await mkdir(home, { recursive: true, mode: 0o700 });
    process.stderr.write("Connecting the native Codex relay…\n");
    await enable(binary, args);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, contents, { mode: 0o600 }); await rename(temporary, path);
    await exec("/bin/launchctl", ["enable", target], { timeout: 5000 });
    await exec("/bin/launchctl", ["bootstrap", domain, path], { timeout: 10000 });
  }
  await writePrivateJson(receipt, { registered: true, home, nativeHome, codex });
  return { service: label, ...await status(target), nativeConfigUntouched: true, connection: "Control other devices", relayHome: home };
}
