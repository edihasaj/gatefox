import type { Readable } from "node:stream";
import type { GatewayConfig } from "./config.js";
import { AppServerRouter } from "./app-server-router.js";
import { AppServerBackends } from "./app-server-backends.js";
import { DesktopCatalog } from "./desktop-catalog.js";
import { isId, jsonLines, object, type Message } from "./app-server-connection.js";
import { NativeControl, nativeRegistration } from "./native-control.js";

/** One transport connection owns its executors, approvals, and cancellation. */
export async function shimSession(executable: string, args: string[], config: GatewayConfig,
  prepared: { path: string; settings: Message; native: Message[] }, overrides: Message,
  input: Readable, emit: (message: Message) => Promise<void>, signal: AbortSignal, configPath?: string): Promise<number> {
  const source = new DesktopCatalog(config, prepared.native, prepared.path);
  await source.initialize();
  let closing = false;
  const registration = await nativeRegistration(config);
  const control = registration ? new NativeControl(registration.home, emit) : undefined;
  const backends = new AppServerBackends(executable, args, config, prepared.settings, overrides, source, message => control && message.method === "remoteControl/status/changed" ? Promise.resolve() : emit(message), () => input.destroy(), configPath);
  const router = new AppServerRouter(config, (method, params) => control && method.startsWith("remoteControl/") ? control.request(method, params) : backends.request(method, params), prepared.path, source);
  const tasks = new Set<Promise<void>>();
  const stop = () => { closing = true; input.destroy(); void backends.stop(); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) return 0;
    await router.initialize();
    for await (const line of jsonLines(input)) {
      let message: Message;
      try { message = object(JSON.parse(line)); }
      catch { await emit({ id: null, error: { code: -32700, message: "Invalid client JSON" } }); continue; }
      if (typeof message.method === "string" && isId(message.id)) {
        if (tasks.size >= 256) { await emit({ id: message.id, error: { code: -32000, message: "Too many pending client requests" } }); continue; }
        const task = router.request(message.method, object(message.params)).then(result => emit({ id: message.id, result }), error => {
          const failure = error as Error & { code?: number; data?: unknown };
          return emit({ id: message.id, error: { code: failure.code || -32603, message: failure.message, ...(failure.data === undefined ? {} : { data: failure.data }) } });
        });
        tasks.add(task); void task.finally(() => tasks.delete(task)).catch(stop);
      } else if (typeof message.method === "string") backends.notify(message);
      else if (!backends.reply(message)) await emit({ id: isId(message.id) ? message.id : null, error: { code: -32600, message: "Invalid client message or unknown server request" } });
    }
  } catch (error) { if (!closing && !backends.native.closed) throw error; }
  finally {
    closing = true; signal.removeEventListener("abort", stop);
    control?.close();
    await backends.stop(); await Promise.allSettled(tasks);
  }
  const { code, signal: exitSignal } = await backends.native.exited;
  return code ?? (exitSignal === "SIGTERM" ? 0 : 1);
}
