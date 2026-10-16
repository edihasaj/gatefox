import { codexStreamIdleTimeoutMs } from "./codex-config.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { configureTelemetry } from "./telemetry.js";
import { startErrorReports } from "./error-report.js";
import { prepareNativeCatalog } from "./native-catalog.js";
import { emitMessage } from "./app-server-connection.js";
import { gatewayCommand } from "./command.js";
import { shimSession } from "./shim-session.js";
import { unixSocketPath, serveUnix } from "./unix-transport.js";
import { sshControlHome, reuseSshSocket } from "./ssh-socket.js";
import { activeNativeRelay } from "./native-control.js";
import { normalizeCodexFeatureArgs } from "./codex-feature-compat.js";

export function appServerIndex(args: string[]): number {
  const values = new Set(["-c", "--config", "--enable", "--disable", "-p", "--profile", "-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval", "-C", "--cd", "--add-dir", "-i", "--image", "--remote", "--remote-auth-token-env", "--local-provider", "--linux-sandbox-pid-namespace"]);
  for (let index = 0; index < args.length; index++) {
    if (values.has(args[index])) { index++; continue; }
    if (args[index].startsWith("-")) continue;
    return args[index] === "app-server" ? index : -1;
  }
  return -1;
}

export async function codexShim(argv: string[]): Promise<void> {
  const separator = argv.indexOf("--");
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const forwarded = separator < 0 ? [] : argv.slice(separator + 1);
  if (options.includes("--help")) {
    process.stdout.write("gateway codex-shim --config PATH --codex PATH -- CODEX_ARGUMENTS\n\nExperimental stdio/private Unix app-server adapter. Other Codex commands pass through unchanged.\nUse an executable wrapper as CODEX_CLI_PATH; do not replace the native binary.\n"); return;
  }
  const { values } = parseArgs({ args: options, options: { config: { type: "string" }, codex: { type: "string" }, ssh: { type: "boolean" }, "ssh-home": { type: "string" } }, strict: true });
  if (!values.config || !values.codex || !forwarded.length) throw new Error("codex-shim requires --config, --codex and -- followed by Codex arguments");
  if (values["ssh-home"] && !values.ssh) throw new Error("--ssh-home requires --ssh");
  const controlHome = values.ssh ? resolve(values["ssh-home"] || sshControlHome(values.config)) : undefined;
  const executable = resolve(values.codex);
  if (executable === fileURLToPath(import.meta.url)) throw new Error("--codex must point to the original Codex executable");
  const appIndex = appServerIndex(forwarded);
  const command = appIndex >= 0 ? forwarded[appIndex + 1] : undefined;
  const decorate = appIndex >= 0 && (!command || command.startsWith("-"));
  if (!decorate) {
    const child = spawn(executable, forwarded, { stdio: "inherit", ...(command === "proxy" && controlHome ? { env: { ...process.env, CODEX_HOME: controlHome } } : {}) });
    child.once("error", () => { process.stderr.write("gateway: Original Codex executable is unavailable\n"); });
    const [code, signal] = await once(child, "exit"); process.exitCode = typeof code === "number" ? code : signal === "SIGINT" ? 130 : 1; return;
  }
  const listenIndex = forwarded.findIndex(arg => arg === "--listen" || arg.startsWith("--listen="));
  const listen = listenIndex < 0 ? "stdio://" : forwarded[listenIndex].includes("=") ? forwarded[listenIndex].split("=")[1] : forwarded[listenIndex + 1];
  if (typeof listen !== "string" || (listen !== "stdio://" && !listen.startsWith("unix://"))) throw new Error("codex-shim supports stdio:// and private unix:// transports only");
  if (controlHome && listen.startsWith("unix://") && listen !== "unix://") throw new Error("The SSH adapter uses its managed Unix socket; omit a custom listen path");
  const socketPath = listen.startsWith("unix://") ? unixSocketPath(controlHome ? "unix://" + resolve(controlHome, "app-server-control/app-server-control.sock") : listen) : undefined;
  if (controlHome && socketPath && await reuseSshSocket(socketPath)) return;
  const preflightArgs = [...forwarded];
  const nativeListenIndex = preflightArgs.findIndex(arg => arg === "--listen" || arg.startsWith("--listen="));
  if (nativeListenIndex >= 0) {
    if (preflightArgs[nativeListenIndex].includes("=")) preflightArgs[nativeListenIndex] = "--listen=stdio://";
    else preflightArgs[nativeListenIndex + 1] = "stdio://";
  }
  const path = resolve(values.config); const config = await loadConfig(path);
  configureTelemetry(config.stateDirectory, "adapter"); startErrorReports(config.stateDirectory, "adapter");
  // One relay decision per process: this adapter or SSH listener never re-checks it while running,
  // so a relay that connects later is used from the next app or listener start.
  const relay = await activeNativeRelay(config);
  if (relay) process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";
  if (!config.port) throw new Error("codex-shim requires a fixed gateway port");
  const helper = gatewayCommand();
  const overrides = {
    name: "Harness Gateway", base_url: `http://127.0.0.1:${config.port}/v1`, wire_api: "responses", requires_openai_auth: false,
    supports_websockets: false, request_max_retries: 2, stream_idle_timeout_ms: codexStreamIdleTimeoutMs,
    "auth.command": helper.command, "auth.args": [...helper.args, "token", "--config", path], "auth.timeout_ms": 5000, "auth.refresh_interval_ms": 300000,
  };
  const prepared = await prepareNativeCatalog(executable, preflightArgs, config);
  const nativeArgs = normalizeCodexFeatureArgs(preflightArgs, prepared.settings);
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const session = (input: NodeJS.ReadableStream, emit: typeof emitMessage, signal: AbortSignal) =>
      shimSession(executable, nativeArgs, config, prepared, overrides, input as typeof process.stdin, emit, signal, path, preflightArgs, relay);
    if (socketPath) {
      try { await serveUnix(socketPath, controller.signal, session); }
      catch (error) {
        // Another bootstrap can finish while this process prepares metadata.
        if (!controlHome || !await reuseSshSocket(socketPath)) throw error;
      }
    }
    else process.exitCode = await session(process.stdin, emitMessage, controller.signal);
  }
  finally {
    controller.abort();
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
  }
}
