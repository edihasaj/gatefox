import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { AppServerRouter } from "./app-server-router.js";
import { prepareNativeCatalog } from "./native-catalog.js";
import { AppServerBackends } from "./app-server-backends.js";
import { DesktopCatalog } from "./desktop-catalog.js";
import { emitMessage, isId, jsonLines, object } from "./app-server-connection.js";

export async function codexShim(argv: string[]): Promise<void> {
  const separator = argv.indexOf("--");
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const forwarded = separator < 0 ? [] : argv.slice(separator + 1);
  if (options.includes("--help")) {
    process.stdout.write("gateway codex-shim --config PATH --codex PATH -- CODEX_ARGUMENTS\n\nExperimental stdio app-server adapter. Other Codex commands pass through unchanged.\nUse an executable wrapper as CODEX_CLI_PATH; do not replace the native binary.\n"); return;
  }
  const { values } = parseArgs({ args: options, options: { config: { type: "string" }, codex: { type: "string" } }, strict: true });
  if (!values.config || !values.codex || !forwarded.length) throw new Error("codex-shim requires --config, --codex and -- followed by Codex arguments");
  const executable = resolve(values.codex);
  if (executable === fileURLToPath(import.meta.url)) throw new Error("--codex must point to the original Codex executable");
  const appIndex = forwarded.indexOf("app-server");
  const command = appIndex >= 0 ? forwarded[appIndex + 1] : undefined;
  const decorate = appIndex >= 0 && (!command || command.startsWith("-"));
  if (!decorate) {
    const child = spawn(executable, forwarded, { stdio: "inherit" });
    child.once("error", () => { process.stderr.write("gateway: Original Codex executable is unavailable\n"); });
    const [code, signal] = await once(child, "exit"); process.exitCode = typeof code === "number" ? code : signal === "SIGINT" ? 130 : 1; return;
  }
  const listenIndex = forwarded.findIndex(arg => arg === "--listen" || arg.startsWith("--listen="));
  const listen = listenIndex < 0 ? "stdio://" : forwarded[listenIndex].includes("=") ? forwarded[listenIndex].split("=")[1] : forwarded[listenIndex + 1];
  if (listen !== "stdio://") throw new Error("codex-shim supports app-server stdio transport only");
  const path = resolve(values.config); const config = await loadConfig(path);
  if (!config.port) throw new Error("codex-shim requires a fixed gateway port");
  const helper = fileURLToPath(new URL("./cli.js", import.meta.url));
  const overrides = {
    name: "Subscription Gateway", base_url: `http://127.0.0.1:${config.port}/v1`, wire_api: "responses", requires_openai_auth: false,
    supports_websockets: false, request_max_retries: 2, stream_max_retries: 0, stream_idle_timeout_ms: config.timeoutMs,
    "auth.command": process.execPath, "auth.args": [helper, "token", "--config", path], "auth.timeout_ms": 5000, "auth.refresh_interval_ms": 300000,
  };
  const prepared = await prepareNativeCatalog(executable, forwarded, config);
  const source = new DesktopCatalog(config, prepared.native, prepared.path);
  let closing = false;
  const backends = new AppServerBackends(executable, forwarded, config, prepared.settings, overrides, source, emitMessage, () => {
    if (!closing) process.stdin.destroy();
  });
  const router = new AppServerRouter(config, (method, params) => backends.request(method, params), prepared.path, source);
  const tasks = new Set<Promise<void>>();
  const stop = () => { closing = true; process.stdin.destroy(); void backends.stop(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    await router.initialize();
    for await (const line of jsonLines(process.stdin)) {
      let message;
      try { message = object(JSON.parse(line)); }
      catch { await emitMessage({ id: null, error: { code: -32700, message: "Invalid client JSON" } }); continue; }
      if (typeof message.method === "string" && isId(message.id)) {
        if (tasks.size >= 256) { await emitMessage({ id: message.id, error: { code: -32000, message: "Too many pending client requests" } }); continue; }
        const task = router.request(message.method, object(message.params)).then(result => emitMessage({ id: message.id, result }), error => {
          const failure = error as Error & { code?: number; data?: unknown };
          return emitMessage({ id: message.id, error: { code: failure.code || -32603, message: failure.message, ...(failure.data === undefined ? {} : { data: failure.data }) } });
        }); tasks.add(task); void task.finally(() => tasks.delete(task)).catch(stop);
      } else if (typeof message.method === "string") backends.notify(message);
      else if (!backends.reply(message)) await emitMessage({ id: isId(message.id) ? message.id : null, error: { code: -32600, message: "Invalid client message or unknown server request" } });
    }
  } catch (error) { if (!closing && !backends.native.closed) throw error; }
  finally {
    closing = true; await backends.stop(); await Promise.allSettled(tasks);
    const { code, signal } = await backends.native.exited;
    if (process.exitCode === undefined) process.exitCode = code ?? (signal === "SIGTERM" ? 0 : 1);
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
  }
}
