import { spawn, execFileSync } from "node:child_process";
import { access, open, readFile, chmod, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
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
  const content = '#!/bin/sh\n# Subscription Gateway desktop adapter.\nfor argument in "$@"; do\n  if [ "$argument" = app-server ]; then exec ' + command + ' "$@"; fi\ndone\nexec ' + quoted(codex) + ' "$@"\n';
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

export async function launchDesktop(configPath: string, nativeHome?: string, app = "/Applications/ChatGPT.app"): Promise<Record<string, unknown>> {
  const config = await loadConfig(configPath); const { binary, wrapper } = await prepareDesktop(configPath, app);
  if (execFileSync("ps", ["-axo", "comm="], { encoding: "utf8" }).split("\n").some(command => command.trim() === binary)) throw new Error("Quit ChatGPT normally with Command-Q, then run gateway desktop. The launcher never stops a running app.");
  const health = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error("Gateway is not healthy; check gateway service status before desktop activation");
  const env = { ...process.env, CODEX_CLI_PATH: wrapper, CODEX_APP_SERVER_FORCE_CLI: "1", GATEWAY_CONFIG: configPath,
    ...(nativeHome ? { CODEX_HOME: resolve(nativeHome) } : {}) };
  // Preserve the desktop's saved login instead of a terminal's platform API overrides.
  for (const key of ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) delete (env as NodeJS.ProcessEnv)[key];
  const child = spawn(binary, [], { env, detached: true, stdio: "ignore" });
  let failure: Error | undefined; child.once("error", error => { failure = error; }); child.unref(); await delay(2000);
  if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error("Desktop launch failed; no native settings were changed");
  await writePrivateJson(resolve(config.stateDirectory, "desktop-launch.json"), { startedAt: new Date().toISOString(), pid: child.pid, adapter: wrapper, isolatedNativeHome: !!nativeHome });
  return { launched: true, pid: child.pid, adapterConfigured: true, renderedPickerVerified: false };
}
