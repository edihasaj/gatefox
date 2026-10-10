import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { AppServerRouter } from "./app-server-router.js";
import { combinedNativeCatalog } from "./native-catalog.js";

type Message = Record<string, unknown>;
type Id = string | number;
const object = (value: unknown): Message => value && typeof value === "object" && !Array.isArray(value) ? value as Message : {};
const isId = (value: unknown): value is Id => typeof value === "string" || typeof value === "number";

/** Bound bytes before decoding, including frames that never contain a newline. */
async function* jsonLines(input: Readable): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8"); let frame = ""; let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let end = 0; end < buffer.length; end++) {
      if (buffer[end] !== 10) continue;
      bytes += end - start;
      if (bytes > 16 * 1024 * 1024) throw new Error("App-server frame exceeds 16 MiB");
      frame += decoder.write(buffer.subarray(start, end)); frame += decoder.end();
      yield frame; frame = ""; bytes = 0; start = end + 1;
    }
    bytes += buffer.length - start;
    if (bytes > 16 * 1024 * 1024) throw new Error("App-server frame exceeds 16 MiB");
    frame += decoder.write(buffer.subarray(start));
  }
  frame += decoder.end();
  if (frame.trim()) throw new Error("App-server stream ended inside a JSON frame");
}

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
  const overrides: Message = {
    name: "Subscription Gateway", base_url: `http://127.0.0.1:${config.port}/v1`, wire_api: "responses", requires_openai_auth: false,
    supports_websockets: false, request_max_retries: 2, stream_max_retries: 0, stream_idle_timeout_ms: config.timeoutMs,
    "auth.command": process.execPath, "auth.args": [helper, "token", "--config", path], "auth.timeout_ms": 5000, "auth.refresh_interval_ms": 300000,
  };
  const catalogPath = await combinedNativeCatalog(executable, forwarded, config);
  const args = [...forwarded, "-c", `model_catalog_json=${JSON.stringify(catalogPath)}`, ...Object.entries(overrides).filter(([, value]) => value !== undefined).flatMap(([key, value]) => ["-c", `model_providers.subscription_gateway.${key}=${JSON.stringify(value)}`])];
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.pipe(process.stderr);
  let sequence = 0; let serverSequence = 0; let closing = false;
  const requests = new Map<Id, { resolve: (value: Message) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const serverRequests = new Map<string, Id>();
  const serverIds = new Map<Id, string>();
  const tasks = new Set<Promise<void>>();
  let killTimer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (closing) return; closing = true;
    child.stdin.end(); child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 1500).unref();
  };
  const emit = async (message: Message) => { if (!process.stdout.write(JSON.stringify(message) + "\n")) await once(process.stdout, "drain"); };
  const send = (message: Message) => { if (!closing) child.stdin.write(JSON.stringify(message) + "\n"); };
  const backend = (method: string, params: Message) => new Promise<Message>((resolve, reject) => {
    if (closing) { reject(new Error("Codex app-server is closed")); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error("Codex app-server request timed out")); }, 120000).unref();
    requests.set(id, { resolve, reject, timer }); send({ id, method, params });
  });
  const exited = new Promise<void>(resolve => child.once("close", (code, signal) => {
    closing = true; clearTimeout(killTimer);
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error("Codex app-server exited")); }
    requests.clear(); process.stdin.destroy(); process.exitCode = typeof code === "number" ? code : signal === "SIGTERM" ? 0 : 1; resolve();
  }));
  child.once("error", () => { process.stderr.write("gateway: Original Codex executable is unavailable\n"); stop(); });
  child.stdin.on("error", stop);
  const router = new AppServerRouter(config, backend, catalogPath);
  const interrupt = () => stop(); process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    await router.initialize();
    const output = (async () => {
      try {
        for await (const line of jsonLines(child.stdout)) {
          let message: Message; try { message = object(JSON.parse(line)); } catch { throw new Error("Codex app-server returned invalid JSON"); }
          if (typeof message.method === "string") {
            if (isId(message.id)) {
              if (serverIds.size >= 256 || serverIds.has(message.id)) throw new Error("Invalid or excessive pending Codex server requests");
              const id = `gateway-server-${++serverSequence}`; serverRequests.set(id, message.id); serverIds.set(message.id, id); await emit({ ...message, id });
            } else if (message.method === "serverRequest/resolved") {
              const params = object(message.params); const original = params.requestId;
              const id = isId(original) ? serverIds.get(original) : undefined;
              if (id) { serverIds.delete(original as Id); serverRequests.delete(id); await emit({ ...message, params: { ...params, requestId: id } }); }
              else await emit(message);
            } else await emit(message);
          } else if (isId(message.id) && requests.has(message.id)) {
            const pending = requests.get(message.id)!; requests.delete(message.id); clearTimeout(pending.timer);
            if (message.error) { const details = object(message.error); pending.reject(Object.assign(new Error(String(details.message || "Codex request failed")), { code: details.code, data: details.data })); }
            else pending.resolve(object(message.result));
          }
        }
      } catch (error) { process.stderr.write(`gateway: ${error instanceof Error ? error.message : "App-server stream failed"}\n`); stop(); }
    })();
    for await (const line of jsonLines(process.stdin)) {
      let message: Message;
      try { message = object(JSON.parse(line)); }
      catch { await emit({ id: null, error: { code: -32700, message: "Invalid client JSON" } }); continue; }
      if (typeof message.method === "string" && isId(message.id)) {
        if (tasks.size >= 256) { await emit({ id: message.id, error: { code: -32000, message: "Too many pending client requests" } }); continue; }
        const task = router.request(message.method, object(message.params)).then(result => emit({ id: message.id, result }), error => {
          const failure = error as Error & { code?: number; data?: unknown };
          return emit({ id: message.id, error: { code: failure.code || -32603, message: failure.message, ...(failure.data === undefined ? {} : { data: failure.data }) } });
        }); tasks.add(task); void task.finally(() => tasks.delete(task)).catch(stop);
      } else if (typeof message.method === "string") send(message);
      else if (typeof message.id === "string" && serverRequests.has(message.id)) {
        const id = serverRequests.get(message.id)!; serverRequests.delete(message.id); send({ ...message, id });
      } else await emit({ id: isId(message.id) ? message.id : null, error: { code: -32600, message: "Invalid client message or unknown server request" } });
    }
    stop(); await output; await Promise.allSettled(tasks); await exited;
  } catch (error) { if (!closing) throw error; }
  finally { stop(); await exited; process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
}
