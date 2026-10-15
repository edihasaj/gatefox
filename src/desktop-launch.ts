import { spawn, execFileSync } from "node:child_process";
import { access, open, readFile, chmod, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, writePrivateJson } from "./config.js";
import { gatewayCommand } from "./command.js";

export async function prepareDesktop(configPath: string, app = "/Applications/ChatGPT.app"): Promise<{ binary: string; wrapper: string }> {
  if (process.platform !== "darwin") throw new Error("Desktop activation currently supports macOS");
  const config = await loadConfig(configPath); const binary = resolve(app, "Contents/MacOS/ChatGPT");
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url)); const codex = resolve(app, "Contents/Resources/codex-cli/bin/codex");
  await access(binary); await access(cli); await access(codex);
  const quoted = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const helper = gatewayCommand();
  const command = [helper.command, ...helper.args, "codex-shim", "--config", configPath, "--codex", codex, "--"].map(quoted).join(" ");
  // Only app-server sessions need translation. Every other Codex command, such as
  // the desktop's exec-server, runs the original CLI with no adapter process.
  const content = '#!/bin/sh\n# Harness Gateway desktop adapter.\nfor argument in "$@"; do\n  if [ "$argument" = app-server ]; then exec ' + command + ' "$@"; fi\ndone\nexec ' + quoted(codex) + ' "$@"\n';
  const wrapper = resolve(config.stateDirectory, `desktop-wrapper-${createHash("sha256").update(content).digest("hex").slice(0, 16)}`);
  try { const file = await open(wrapper, "wx", 0o700); try { await file.writeFile(content); await file.sync(); } finally { await file.close(); } }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(wrapper);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || await readFile(wrapper, "utf8") !== content) throw new Error("Generated adapter path is occupied by another file");
  }
  await chmod(wrapper, 0o700);
  return { binary, wrapper };
}

const wrapperName = /^desktop-wrapper-[0-9a-f]{16}$/;
/**
 * Whether an inherited `CODEX_CLI_PATH` is a gateway wrapper: the one this launch writes, or an older one
 * generated in the same state directory. A look-alike name anywhere else is someone else's file.
 */
const isGatewayWrapper = (inherited: string, wrapper: string) => inherited === wrapper
  || (dirname(inherited) === dirname(wrapper) && wrapperName.test(basename(inherited)));
/**
 * The launch environment for the desktop. `CODEX_CLI_PATH` is the only adapter hook:
 * `CODEX_APP_SERVER_FORCE_CLI` would push durable chats and SSH rows through the CLI too.
 * An inherited "1" is left out of the launched app only when the inherited `CODEX_CLI_PATH`
 * is a gateway wrapper (it came from our old launchctl export); any other value is kept.
 */
export function desktopEnvironment(base: NodeJS.ProcessEnv, wrapper: string, configPath: string, nativeHome?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CODEX_CLI_PATH: wrapper, GATEWAY_CONFIG: configPath,
    ...(nativeHome ? { CODEX_HOME: resolve(nativeHome) } : {}) };
  const inherited = base.CODEX_CLI_PATH;
  if (env.CODEX_APP_SERVER_FORCE_CLI === "1" && inherited && isGatewayWrapper(inherited, wrapper)) delete env.CODEX_APP_SERVER_FORCE_CLI;
  // Preserve the desktop's saved login instead of a terminal's platform API overrides.
  for (const key of ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) delete env[key];
  return env;
}

/** Side effects of launching the app; tests replace them so no process starts and no wait elapses. */
export interface LaunchDeps {
  spawn: typeof spawn;
  processes: () => string;
  fetch: typeof fetch;
  wait: (ms: number) => Promise<unknown>;
}
const realLaunchDeps: LaunchDeps = { spawn, processes: () => execFileSync("ps", ["-axo", "comm="], { encoding: "utf8" }), fetch, wait: ms => delay(ms) };

export async function launchDesktop(configPath: string, nativeHome?: string, app = "/Applications/ChatGPT.app", deps: Partial<LaunchDeps> = {}): Promise<Record<string, unknown>> {
  const run = { ...realLaunchDeps, ...deps };
  const config = await loadConfig(configPath); const { binary, wrapper } = await prepareDesktop(configPath, app);
  if (run.processes().split("\n").some(command => command.trim() === binary)) throw new Error("Quit ChatGPT normally with Command-Q, then run gateway desktop. The launcher never stops a running app.");
  const health = await run.fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error("Gateway is not healthy; check gateway service status before desktop activation");
  const env = desktopEnvironment(process.env, wrapper, configPath, nativeHome);
  const child = run.spawn(binary, [], { env, detached: true, stdio: "ignore" });
  let failure: Error | undefined; child.once("error", error => { failure = error; }); child.unref(); await run.wait(2000);
  if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error("Desktop launch failed; no native settings were changed");
  await writePrivateJson(resolve(config.stateDirectory, "desktop-launch.json"), { startedAt: new Date().toISOString(), pid: child.pid, adapter: wrapper, isolatedNativeHome: !!nativeHome });
  return { launched: true, pid: child.pid, adapterConfigured: true, renderedPickerVerified: false };
}
