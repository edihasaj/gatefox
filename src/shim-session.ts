import type { Readable } from "node:stream";
import type { GatewayConfig } from "./config.js";
import { AppServerRouter } from "./app-server-router.js";
import { AppServerBackends } from "./app-server-backends.js";
import { DesktopCatalog } from "./desktop-catalog.js";
import { isId, jsonLines, object, type Message } from "./app-server-connection.js";
import { NativeControl, nativeRegistration } from "./native-control.js";
import { applyCodexHookCorrections, hasLegacyCodexHookConfig, normalizeCodexFeatureRequest, rewrittenCodexHookScopes, scopedCodexFeatureBase } from "./codex-feature-compat.js";

/** One transport owns its RPC clients, approvals, and cancellation routing. */
export async function shimSession(executable: string, args: string[], config: GatewayConfig,
  prepared: { path: string; settings: Message; native: Message[] }, overrides: Message,
  input: Readable, emit: (message: Message) => Promise<void>, signal: AbortSignal, configPath?: string, originalArgs = args): Promise<number> {
  const source = new DesktopCatalog(config, prepared.native, prepared.path);
  await source.initialize();
  let closing = false;
  const registration = await nativeRegistration(config);
  const control = registration ? new NativeControl(registration.home, emit) : undefined;
  const rewrittenHooks = rewrittenCodexHookScopes(originalArgs, prepared.settings);
  let router: AppServerRouter | undefined;
  let backends: AppServerBackends;
  try {
    backends = await AppServerBackends.create(executable, args, config, prepared.settings, overrides, source, async message => {
      await router?.observeNotification(message);
      if (!(control && message.method === "remoteControl/status/changed")) await emit(message);
    }, () => input.destroy(), configPath);
  } catch (error) { control?.close(); throw error; }
  router = new AppServerRouter(config, (method, params) => control && method.startsWith("remoteControl/") ? control.request(method, params) : backends.request(method, params), prepared.path, source);
  const tasks = new Set<Promise<void>>();
  const compatible = async (method: string, params: Message): Promise<Message> => {
    const threadConfig = ["thread/start", "thread/resume", "thread/fork"].includes(method);
    const legacy = threadConfig ? hasLegacyCodexHookConfig(object(params.config)) : method === "experimentalFeature/enablement/set" && Object.hasOwn(object(params.enablement), "codex_hooks");
    if (!legacy && !(threadConfig && rewrittenHooks.size)) return normalizeCodexFeatureRequest(method, params);
    let cwd = typeof params.cwd === "string" ? params.cwd : method === "thread/start" ? process.cwd() : undefined;
    if (threadConfig && !cwd && typeof params.threadId === "string") {
      const thread = object((await backends.request("thread/read", { threadId: params.threadId, includeTurns: false })).thread);
      if (typeof thread.cwd !== "string") throw Object.assign(new Error("This chat's workspace is unavailable; deprecated hooks settings were not applied."), { code: -32001 });
      cwd = thread.cwd;
    }
    const current = await backends.native.request("config/read", { includeLayers: true, ...(cwd ? { cwd } : {}) });
    const { base, corrections } = scopedCodexFeatureBase(current, rewrittenHooks);
    const normalized = normalizeCodexFeatureRequest(method, params, base);
    return threadConfig && Object.keys(corrections).length ? { ...normalized, config: applyCodexHookCorrections(object(normalized.config), corrections) } : normalized;
  };
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
        const task = compatible(message.method, object(message.params)).then(params => router!.request(message.method as string, params)).then(result => emit({ id: message.id, result }), error => {
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
