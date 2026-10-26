import type { Readable } from "node:stream";
import type { GatewayConfig } from "./config.js";
import { AppServerRouter, AppServerRoutingError, inheritsParentSettings } from "./app-server-router.js";
import { AppServerBackends } from "./app-server-backends.js";
import { DesktopCatalog } from "./desktop-catalog.js";
import { isId, jsonLines, object, type Message } from "./app-server-connection.js";
import { NativeControl } from "./native-control.js";
import { readNativePickerPreferences } from "./native-picker-preferences.js";
import { TurnTelemetry, errorClass } from "./turn-telemetry.js";
import { AnnouncedThreads, describeChat } from "./announced-threads.js";
import { telemetry } from "./telemetry.js";
import { reportException } from "./error-report.js";
import { watchForUpgrade } from "./self-update.js";
import { registerActivityProbe } from "./runtime-activity.js";
import { ThreadStartOrder } from "./thread-start-order.js";
import { nativeThreadAbsent } from "./native-thread-absence.js";
import { rpcRejection } from "./rpc-rejection.js";
import { applyCodexHookCorrections, hasLegacyCodexHookConfig, normalizeCodexFeatureRequest, rewrittenCodexHookScopes, scopedCodexFeatureBase } from "./codex-feature-compat.js";
import { CompletionReplay, completionReplayStorage } from "./completion-replay.js";

/** One transport owns its RPC clients, approvals, and cancellation routing. */
export function operationalStartFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /unavailable|ownership|quiescing|startup settings differ|retry after|is closing|ENOENT|ECONNREFUSED|ECONNRESET/i.test(message);
}

/**
 * How long a session must be silent to count as idle: 30 s. GATEWAY_SESSION_IDLE_MS is a test hook nothing the gateway installs
 * sets; it may only shorten the window (0 to 30000), and anything else, a longer value or text, leaves 30 s.
 */
export function sessionIdleMs(raw = process.env.GATEWAY_SESSION_IDLE_MS): number {
  const value = raw?.trim() ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 && value <= 30000 ? value : 30000;
}

/** The proxy's private hello has no RPC identity and never reaches an engine. */
export function gatewayClientDevice(message: Message, firstClientMessage: boolean, initialized: boolean): string | undefined {
  const device = object(message.params).device;
  return message.method === "gateway/client" && firstClientMessage && !initialized && message.id === undefined && typeof device === "string" && /^[0-9a-f]{32}$/.test(device) ? device : undefined;
}

/** Registration lets this host route remote control; it does not identify the inbound app session. */
export function shimSessionDevice(_relay?: { home: string; nativeHome: string }): "local" { return "local"; }

export async function shimSession(executable: string, args: string[], config: GatewayConfig,
  prepared: { path: string; settings: Message; native: Message[] }, overrides: Message,
  input: Readable, emit: (message: Message) => Promise<void>, signal: AbortSignal, configPath?: string, originalArgs = args,
  relay?: { home: string; nativeHome: string }, upgradeOwner: "session" | "listener" = "session"): Promise<number> {
  const source = new DesktopCatalog(config, prepared.native, prepared.path);
  // Busy from the first moment: a session that is still initializing (or whose engines still start) must never read as idle.
  let started = false;
  let idle = () => false;
  const unregisterActivity = registerActivityProbe("adapter_session", () => !started || !idle());
  try { await source.initialize(); } catch (error) { unregisterActivity(); throw error; }
  let closing = false;
  let router: AppServerRouter | undefined;
  const completionReplay = new CompletionReplay({ storage: completionReplayStorage(config.stateDirectory), request: (method, params) => router!.request(method, params), emit, device: shimSessionDevice(relay), awaitClient: true });
  const send = async (message: Message): Promise<void> => {
    if (!completionReplay.forward(message)) return;
    try { await emit(message); void completionReplay.written(message); }
    catch (error) { completionReplay.failed(message); throw error; }
  };
  // The caller decided once whether a relay is registered. It owns every remote-control request while
  // NativeControl reconnects its private socket; an unavailable relay fails those requests rather than using the engine.
  const control = relay ? new NativeControl(relay.home, send) : undefined;
  const rewrittenHooks = rewrittenCodexHookScopes(originalArgs, prepared.settings);
  const order = new ThreadStartOrder();
  let backends: AppServerBackends;
  const announced = new AnnouncedThreads();
  const turns = new TurnTelemetry(threadId => describeChat(router?.describeThread(threadId), announced, threadId));
  const startedAt = Date.now(); let handled = 0; let lastActivity = Date.now(); let firstClientMessage = true; let initialized = false;
  const tasks = new Set<Promise<void>>();
  // Idle means no turn, no request in flight and no traffic for 30 s. The SSH listener asks this process-wide question (see
  // runtimeBusy) when it is asked to retire, and a session is busy from its first moment, while its engines still start.
  idle = () => turns.active === 0 && tasks.size === 0 && Date.now() - lastActivity > sessionIdleMs();
  started = true;
  try {
    backends = await AppServerBackends.create(executable, args, config, prepared.settings, overrides, source, async (message, engine) => {
      await router?.observeNotification(message, engine);
      if (!isId(message.id)) { announced.observe(message, engine); turns.observe(message); lastActivity = Date.now(); }
      if (control && message.method === "remoteControl/status/changed") return;
      // Server requests keep their own correlation; only notifications wait for a new thread's reply.
      if (isId(message.id)) { await Promise.all(order.before(message).map(send)); await send(message); return; }
      await Promise.all(order.admit(message).map(send));
    }, () => input.destroy(), configPath, signal);
  } catch (error) {
    control?.close(); turns.close(); unregisterActivity();
    // A host that is restarting, busy or owned elsewhere fails closed by design and the
    // app retries; only an unexpected start failure is reported as an exception.
    if (!operationalStartFailure(error)) reportException(error, "adapter_start");
    telemetry("adapter_start_failed", { errorClass: errorClass((error as Error).message), code: (error as { code?: number }).code }); throw error; }
  router = new AppServerRouter(config, (method, params, hint) => control && method.startsWith("remoteControl/") ? control.request(method, params) : backends.request(method, params, hint), prepared.path, source, undefined, backends.identity,
    // Only the same configuration file the adapter started from, and only its two picker fields.
    configPath ? () => readNativePickerPreferences(configPath) : undefined);
  const compatible = async (method: string, params: Message): Promise<Message> => {
    // The parent already runs with corrected hooks; the SDK refuses any override on this fork.
    if (inheritsParentSettings(method, params)) return params;
    const threadConfig = ["thread/start", "thread/resume", "thread/fork"].includes(method);
    const legacy = threadConfig ? hasLegacyCodexHookConfig(object(params.config)) : method === "experimentalFeature/enablement/set" && Object.hasOwn(object(params.enablement), "codex_hooks");
    if (!legacy && !(threadConfig && rewrittenHooks.size)) return normalizeCodexFeatureRequest(method, params);
    let cwd = typeof params.cwd === "string" ? params.cwd : method === "thread/start" ? process.cwd() : undefined;
    if (threadConfig && !cwd && typeof params.threadId === "string") {
      const probe = await backends.request("thread/read", { threadId: params.threadId, includeTurns: false })
        .catch(error => { if (nativeThreadAbsent(error, String(params.threadId))) return undefined; throw error; });
      // A chat no SDK knows cannot load; the SDK's own reply follows without hook corrections.
      if (!probe) return normalizeCodexFeatureRequest(method, params);
      const thread = object(probe.thread);
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
  // Only a process-per-session adapter can upgrade by exiting. A Unix reconnect returns to
  // the same listener and the same loaded code, so session retirement would loop indefinitely.
  const stopWatching = upgradeOwner === "session" ? watchForUpgrade("adapter", idle, () => { stop(); return true; }) : () => {};
  try {
    if (signal.aborted) return 0;
    await router.initialize();
    for await (const line of jsonLines(input)) {
      let message: Message;
      try { message = object(JSON.parse(line)); }
      catch { if (firstClientMessage) completionReplay.settleDevice(); firstClientMessage = false; await send({ id: null, error: { code: -32700, message: "Invalid client JSON" } }); continue; }
      lastActivity = Date.now();
      if (firstClientMessage) {
        const device = gatewayClientDevice(message, true, initialized);
        if (device) completionReplay.setDevice(device); else completionReplay.settleDevice();
      }
      if (message.method === "gateway/client") {
        firstClientMessage = false;
        continue;
      }
      firstClientMessage = false;
      if (typeof message.method === "string" && isId(message.id)) {
        handled++;
        if (message.method === "initialize") { initialized = true; const info = object(object(message.params).clientInfo); telemetry("adapter_client", { client: typeof info.name === "string" ? info.name : "unknown", clientVersion: typeof info.version === "string" ? info.version : undefined }); }
        if (tasks.size >= 256) { await send({ id: message.id, error: { code: -32000, message: "Too many pending client requests" } }); continue; }
        const creating = order.begin(message.method, object(message.params));
        // Writes are queued synchronously, so held notifications follow the reply in SDK order.
        const answer = (reply: Message, created?: string) => { const written = send(reply); if (creating) for (const held of order.settle(created)) void send(held).catch(() => {}); return written; };
        const task = compatible(message.method, object(message.params)).then(params => router!.request(message.method as string, params)).then(async result => {
          await answer({ id: message.id, result }, typeof object(result.thread).id === "string" ? String(object(result.thread).id) : undefined);
        }, error => {
          const failure = error as Error & { code?: number; data?: unknown };
          // Routing errors carry fixed gateway text; other failures are classified only.
          const routing = error instanceof AppServerRoutingError;
          if (failure.code === undefined && !routing) reportException(failure, `rpc:${message.method}`);
          telemetry("rpc_error", { method: message.method, code: failure.code || -32603, ...(routing ? { reason: failure.message } : { errorClass: errorClass(failure.message) }),
            rejection: rpcRejection(String(message.method), failure, routing) });
          return answer({ id: message.id, error: { code: failure.code || -32603, message: failure.message, ...(failure.data === undefined ? {} : { data: failure.data }) } });
        });
        tasks.add(task); void task.finally(() => tasks.delete(task)).catch(stop);
      } else if (typeof message.method === "string") backends.notify(message);
      else if (!backends.reply(message)) await send({ id: isId(message.id) ? message.id : null, error: { code: -32600, message: "Invalid client message or unknown server request" } });
    }
  } catch (error) { if (!closing && !backends.native.closed) throw error; }
  finally {
    closing = true; signal.removeEventListener("abort", stop); turns.close(); stopWatching(); unregisterActivity();
    telemetry("adapter_session_end", { durationMs: Date.now() - startedAt, requests: handled, nativeClosed: backends.native.closed });
    control?.close();
    await backends.stop(); await Promise.allSettled(tasks);
  }
  const { code, signal: exitSignal } = await backends.native.exited;
  return code ?? (exitSignal === "SIGTERM" ? 0 : 1);
}
