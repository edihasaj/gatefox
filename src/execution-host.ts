import { createServer } from "node:http";
import { chmod, lstat, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { object, isId, type Id, type Message } from "./app-server-connection.js";
import type { GatewayConfig } from "./config.js";
import { ExecutionEngine, ReleaseSkewError, type SkewDirection, executionDescriptor, validateExecutionSdk, descriptorFingerprint, type ExecutionRecord } from "./execution-host-engine.js";
import { claimHost, executionCapabilities, executionHostHome, executionHostMarker, listenPrivate, privateDirectory, publishOwner, removeOwnedSocket, sdkIdentity, sdkSocketTarget, socketAnswers, socketIdentity, type ExecutionCapability, type HostOwner } from "./execution-host-storage.js";
import { NativeExecutionEngine, compareNativeLaunch, nativeDescriptor, type NativeExecutionDescriptor, type NativeExecutionRecord } from "./native-execution-host-engine.js";
import { claimNativeHome, nativeHomeOwnerPath, type NativeHomeLease } from "./native-execution-host-storage.js";
import { nativeUnavailableReason, verifyNativeSdk, type NativeSdkVerifier } from "./native-execution-host-sdk.js";
import { gatewaySdkRuntime, type GatewaySdkRuntime } from "./gateway-sdk-runtime.js";
import { engineActivity } from "./execution-host-activity.js";
import { pendingGatewaySdkReader, type PendingGatewaySdk } from "./self-update.js";
import { telemetry } from "./telemetry.js";

export { executionHostHome } from "./execution-host-storage.js";
export type { ExecutionDescriptor, ExecutionRecord } from "./execution-host-engine.js";
export interface ExecutionHostOptions { config: GatewayConfig; configPath: string; nativeHome: string; codex: string; capabilities?: ExecutionCapability[]; nativeRelayOwnsRegistration?: boolean; nativeSdkVerifier?: NativeSdkVerifier; gatewayRuntime?: () => Promise<GatewaySdkRuntime | undefined>;
  /** The installed release that is newer than this process, with its gateway SDK checksum; defaults to reading the installed release. A stand-in for tests. */
  pendingRelease?: () => Promise<PendingGatewaySdk | undefined>;
  /**
   * Called with a release made urgent by a refused newer adapter, the moment no turn is running in any engine (and no approval,
   * input or background terminal waits), so the supervisor can try the move before the next turn starts (see `watchSkew`). */
  onSkewIdle?: (release: string) => void }
const maxFrame = 4 * 1024 * 1024;
/** How long after the last turn ended a host with connected adapters still counts as in use (see prepareQuietStop). */
export const defaultQuietMs = 5 * 60_000;
/** Why a quiet check refused, from a fixed vocabulary (see `self_upgrade_waiting` in docs/diagnostics.md). */
export type QuietWait = "running" | "background_terminal" | "too_many" | "unreadable" | "ephemeral_settling" | "recent_turn";
/** A quiet host that closed its gate (how many chats its engines still had loaded, a count only), or why it is not quiet. */
export type QuietStop = { loadedChats: number } | { wait: QuietWait };

/** Why a host start failed, from a fixed vocabulary; the error's own text and paths are never part of it. */
export type HostFailureReason = "live_owner" | "identity_changed" | "socket_occupied" | "sdk_invalid" | "sdk_dir_missing" | "receipt_invalid" | "io_error" | "other";
/** Errors raised while checking the engine binaries themselves (missing, changed, unsigned or the wrong version), whatever their code. */
const sdkFailures = new WeakSet<object>();
async function sdkCheck<T>(check: () => Promise<T>): Promise<T> {
  try { return await check(); } catch (error) { if (error && typeof error === "object") sdkFailures.add(error); throw error; }
}
const failureMessages: Array<[HostFailureReason, RegExp]> = [
  ["live_owner", /^(An execution host already owns this configuration|An execution generation is still running|A native execution owner (is still running|already owns this native home)|Native execution launch is unconfirmed|A live execution listener was preserved|Private preferences are busy)/],
  ["identity_changed", /^(Execution host identity changed|Native execution ownership changed|Execution host ownership changed)/],
  ["socket_occupied", /^(Execution control socket target is occupied|Execution socket (belongs to another listener|changed during recovery|must be private)|Execution SDK socket (rendezvous points to an unrelated target|target must be private)|Native execution socket (is occupied|ownership changed))/],
  ["sdk_invalid", /^(Execution host (SDK |requires the pinned)|Native execution (requires|SDK signature|SDK changed)|Gateway executor artifact does not match)/],
  ["receipt_invalid", /^(Execution host ownership receipt is (invalid|unreadable)|Native execution ownership receipt is invalid|Execution generation receipt is invalid|Native execution (SDK identity|death metadata) is invalid|Execution host capabilities are invalid|Private preference lock is invalid)/],
];
/**
 * The refusal for a native-home receipt left under another configuration or spelling of the native home: it keeps the fixed
 * prefix the control API passes through and names the receipt to move aside, home-relative, so nothing else is shown.
 */
function nativeIdentityRefusal(nativeHome: string): Error {
  const receipt = nativeHomeOwnerPath(nativeHome); const home = homedir();
  const shown = receipt.startsWith(home + "/") ? "~" + receipt.slice(home.length) : receipt;
  return new Error(`Native execution ownership changed; existing ownership was preserved. Move ${shown} aside once no other gateway configuration uses this native home, and this host takes it at the next native request`);
}
/** The SDK's fixed socket folder: a missing one was the 2026-10-16 reboot incident, reported as overloaded by the turn classifier. */
const sdkSocketFolder = /(^|\/)codex-daemon-\d+(\/|$)/;
/**
 * Classifies a failed host start for telemetry and retry policy. It reads the error's fixed message, its errno code and,
 * for a missing file, whether the path lies in the SDK's socket folder; none of them is ever returned or logged.
 */
export function hostFailureReason(error: unknown): HostFailureReason {
  if (!error || typeof error !== "object") return "other";
  const { message, code, path } = error as { message?: unknown; code?: unknown; path?: unknown };
  const text = typeof message === "string" ? message : "";
  if (text.startsWith("Execution SDK socket directory is missing") || code === "ENOENT" && typeof path === "string" && sdkSocketFolder.test(path)) return "sdk_dir_missing";
  if (sdkFailures.has(error)) return "sdk_invalid";
  for (const [reason, pattern] of failureMessages) if (pattern.test(text)) return reason;
  if (code === "EADDRINUSE") return "socket_occupied";
  if (typeof code === "string" && /^E[A-Z0-9]+$/.test(code) || /^(Execution (host|SDK socket) directory must be private|Execution ownership archive is full)/.test(text)) return "io_error";
  return "other";
}

/** How long `release_skew_refused` is held back after one was recorded (ms); `GATEWAY_RELEASE_SKEW_EVENT_MS` shortens it for tests. */
const skewEventGapMs = (): number => Number(process.env.GATEWAY_RELEASE_SKEW_EVENT_MS) || 60_000;
/** How often an urgent host looks for the moment no turn runs (ms); `GATEWAY_SKEW_WATCH_MS` shortens it for tests. */
const skewWatchMs = (): number => Number(process.env.GATEWAY_SKEW_WATCH_MS) || 1000;

/**
 * One owned SDK writer per gateway generation, independent of adapter clients. A host without `prepareQuietStop` (a stand-in) never stops quietly.
 * `skewRefused(release)`: this host refused an adapter that runs the gateway SDK of the installed `release`, so that newer release is waiting urgently.
 */
export async function startExecutionHost(options: ExecutionHostOptions): Promise<{ close(): Promise<void>; prepareStop(): Promise<boolean>; prepareQuietStop?(quietMs?: number): Promise<QuietStop | undefined>; skewRefused?(release: string): boolean; resume(): void }> {
  const home = executionHostHome(options.configPath, options.nativeHome); const socketPath = resolve(home, "host.sock");
  if (Buffer.byteLength(socketPath) > 103) throw new Error("Execution host Unix socket path exceeds 103 bytes");
  const requested = executionCapabilities(options.capabilities); const resolveRuntime = options.gatewayRuntime ?? gatewaySdkRuntime;
  if (options.nativeRelayOwnsRegistration !== undefined && typeof options.nativeRelayOwnsRegistration !== "boolean" || options.nativeRelayOwnsRegistration && !requested.includes("native")) throw new Error("Execution host native relay ownership is invalid");
  // Generations run this release's pinned gateway SDK, so that is the binary to pin. Without one (older layouts) they spawn the app's codex.
  // A runtime that cannot be resolved (a damaged install) falls back to pinning the app's codex, as releases before 0.4.3 did.
  const runtime = requested.includes("gateway") ? await resolveRuntime().catch(() => undefined) : undefined;
  // A gateway-only host runs its own pinned runtime, so an app that was updated or uninstalled must not stop it from starting.
  // Its receipt then names that runtime instead of a binary nothing checks, and the runtime checksum below stays the guard.
  let sdk: { codex: string; sdkSha256: string };
  try { sdk = await sdkCheck(() => sdkIdentity(options.codex)); }
  catch (error) {
    if (!runtime || requested.includes("native")) throw error;
    sdk = { codex: runtime.executable, sdkSha256: runtime.binarySha256 };
  }
  await sdkCheck(() => validateExecutionSdk(runtime ? runtime.executable : sdk.codex));
  let capabilities = requested; let nativeSdk: Awaited<ReturnType<NativeSdkVerifier>> | Record<string, never> = {};
  if (requested.includes("native")) {
    try { nativeSdk = await sdkCheck(() => (options.nativeSdkVerifier ?? verifyNativeSdk)(sdk.codex)); }
    catch (error) {
      // An app whose engine differs from the verified one cannot be shared, but must not take gateway chats down with it.
      if (!requested.includes("gateway")) throw error;
      telemetry("native_sharing_unavailable", { reason: nativeUnavailableReason(error) });
      capabilities = requested.filter(capability => capability !== "native");
    }
  }
  const nativeRelayOwnsRegistration = options.nativeRelayOwnsRegistration === true && capabilities.includes("native");
  const owner: HostOwner = await claimHost(home, { version: 1, managed: executionHostMarker, configPath: resolve(options.configPath), nativeHome: resolve(options.nativeHome), ...sdk, socketPath,
    capabilities, ...nativeSdk, ...(capabilities.includes("native") ? { nativeRelayOwnsRegistration } : {}) });
  let native: NativeExecutionEngine | undefined; let richestNative: NativeExecutionDescriptor | undefined; let nativeLease: NativeHomeLease | undefined;
  const engines = new Map<string, ExecutionEngine>(); const leases = new Map<WebSocket, Set<string>>(); let stopping = false; let quiescing = false; let closed: Promise<void> | undefined;
  let writes: Promise<void> = Promise.resolve(); let serial: Promise<unknown> = Promise.resolve(); let pending = 0;
  // Release skew: a generation request that names another release's gateway SDK. The adapter is newer when its SDK is the
  // installed (pending) release's, and older otherwise. Each direction is recorded at most once per `skewEventGapMs`, with the
  // refusals since the last record; a newer adapter also marks its release urgent for the supervisor (see `skewRefused`).
  const readPendingRelease = options.pendingRelease ?? pendingGatewaySdkReader();
  const skewRefusals = new Map<string, { count: number; recordedAt: number }>(); const urgentReleases = new Set<string>();
  let skewTimer: NodeJS.Timeout | undefined; let skewIdle = false; let skewReading = false;
  /**
   * While a release is urgent, looks at the engines every `skewWatchMs` and tells `onSkewIdle` when none has a turn running, a
   * pending approval or input, or a background terminal, once per time that becomes true. Agents that run turns back to back
   * leave only short gaps that the supervisor's own 10 second look would miss. The host never sees turn notifications (see
   * execution-host-activity.ts), so this reads the engines with the same transient admin connections as a quiet check; it
   * changes nothing and closes no gate: the supervisor's own quiet check (`prepareQuietStop(0)`) decides, and a turn that starts
   * in between simply makes it refuse.
   */
  const watchSkew = () => {
    if (skewTimer || !options.onSkewIdle) return;
    skewTimer = setInterval(() => {
      if (skewReading || stopping || quiescing || !urgentReleases.size) return;
      skewReading = true;
      void (async () => {
        let idle = true;
        for (const engine of [...engines.values(), ...(native ? [native] : [])]) {
          if (engine.closed) continue;
          const activity = await engineActivity(engine.record.socketPath, engine.owner.socket, 0);
          if (activity.running.length || activity.terminals || activity.unknown || activity.tooMany) { idle = false; break; }
        }
        const became = idle && !skewIdle; skewIdle = idle;
        if (became && !stopping) for (const release of urgentReleases) options.onSkewIdle!(release);
      })().catch(() => { skewIdle = false; }).finally(() => { skewReading = false; });
    }, skewWatchMs());
    skewTimer.unref();
  };
  const noteSkew = async (adapterSha256: string): Promise<SkewDirection> => {
    const pendingRelease = await readPendingRelease().catch(() => undefined);
    const direction = pendingRelease?.gatewaySdkSha256 === adapterSha256 ? "adapter_newer" : "adapter_older";
    if (direction === "adapter_newer") urgentReleases.add(pendingRelease!.release);
    const entry = skewRefusals.get(direction) ?? { count: 0, recordedAt: Number.NEGATIVE_INFINITY }; entry.count++; skewRefusals.set(direction, entry);
    if (direction === "adapter_newer") watchSkew();
    if (performance.now() - entry.recordedAt >= skewEventGapMs()) { telemetry("release_skew_refused", { direction, count: entry.count }); entry.count = 0; entry.recordedAt = performance.now(); }
    return direction;
  };
  const publish = () => {
    if (native?.death && !owner.nativeDeaths?.some(death => death.instanceId === native!.death!.instanceId)) owner.nativeDeaths = [...(owner.nativeDeaths || []), native.death].slice(-32);
    const snapshot: HostOwner = { ...owner, generations: [...engines.values()].map(engine => ({ ...engine.owner })), ...(native ? { native: { ...native.owner } } : {}) };
    const sdkState = native ? native.closed ? "exited" : native.owner.pid > 0 ? "running" : "starting" : "idle";
    writes = writes.catch(() => undefined).then(async () => { await nativeLease?.publish(snapshot.native, snapshot.state === "stopped", sdkState); await publishOwner(home, snapshot); }); return writes;
  };
  const remove = async (engine: ExecutionEngine) => { await engine.stop(); engines.delete(engine.record.revision); await publish(); };
  const acquire = async (params: Message): Promise<ExecutionRecord> => {
    if (!capabilities.includes("gateway")) throw new Error("Execution host does not offer gateway ownership");
    const descriptor = executionDescriptor(Object.hasOwn(params, "descriptor") ? params.descriptor : params);
    const existing = engines.get(descriptor.revision);
    if (existing && !existing.closed) {
      if (existing.fingerprint !== descriptorFingerprint(descriptor)) throw new Error("A gateway generation cannot change its loaded settings");
      return existing.record;
    }
    if (existing) await remove(existing);
    if (engines.size >= 4) {
      // Prove the SDK has no loaded owners before retiring a generation.
      for (const engine of [...engines.values()]) if (engine.closed || (![...leases.values()].some(values => values.has(engine.record.revision)) && !(await engine.loadedThreads()).size)) { await remove(engine); if (engines.size < 4) break; }
    }
    if (engines.size >= 4) throw new Error("Four gateway generations have loaded chats. Close an older chat before loading another catalog");
    const engine = new ExecutionEngine(descriptor, owner, home, resolveRuntime, !runtime); engines.set(descriptor.revision, engine);
    try { await engine.start(options.config, publish); await publish(); return engine.record; }
    catch (error) { await remove(engine); if (error instanceof ReleaseSkewError) throw new ReleaseSkewError(error.adapterSha256, await noteSkew(error.adapterSha256).catch(() => "adapter_older" as const)); throw error; }
  };
  // The native home is claimed at start, or, while another live owner holds it (a desktop's private native engine that ran
  // while this host was down, say), at the next native request: until then this host refuses native ownership and keeps
  // serving gateway chats, so it never becomes a second native writer and never takes gateway chats down with it. A receipt
  // left under another configuration or spelling of the native home is refused the same way, with its own fixed message.
  const claimNative = async (): Promise<void> => { nativeLease ??= await claimNativeHome(owner, home); };
  const acquireNative = async (params: Message): Promise<NativeExecutionRecord> => {
    if (!capabilities.includes("native")) throw new Error("Execution host does not offer native ownership");
    if (!nativeLease) {
      try { await claimNative(); }
      catch (error) {
        if (hostFailureReason(error) === "identity_changed") throw nativeIdentityRefusal(options.nativeHome);
        if (hostFailureReason(error) !== "live_owner") throw error;
        telemetry("native_acquire", { outcome: "refused_owner" });
        throw new Error("Native execution ownership is held by a live owner; existing ownership was preserved");
      }
    }
    const descriptor = nativeDescriptor(Object.hasOwn(params, "descriptor") ? params.descriptor : params);
    if (native && !native.closed) {
      const relation = compareNativeLaunch(native.descriptor, descriptor);
      if (relation === "same" || relation === "subset") { telemetry("native_acquire", { relation, outcome: "attached" }); return { ...native.record }; }
      if (relation === "conflict") { telemetry("native_acquire", { relation, outcome: "refused" }); throw new Error("Native execution startup settings differ; existing ownership was preserved"); }
      // The desktop is the native launcher. A writer started for a client with
      // fewer settings yields to it, but never while a loaded chat is working.
      const busy = await native.busyThreads();
      telemetry("native_acquire", { relation, outcome: busy ? "refused_busy" : "replaced", busyChats: busy });
      if (busy) throw new Error("Native execution startup settings differ while a chat is running; retry after it finishes");
      if (native.closed || compareNativeLaunch(native.descriptor, descriptor) !== "superset") throw new Error("Native execution launch changed during replacement; retry");
      await native.stop(); await publish();
    }
    if (native) {
      // Only confirmed process death permits replacement. Socket disconnect is
      // never sufficient, and stop validates/removes only its own dead socket.
      if (!native.death) throw new Error("Native execution launch is unconfirmed; existing ownership was preserved");
      await native.stop();
    }
    if (stopping) throw new Error("Execution host is closing");
    // A relay starting the writer first reuses the richest launch this host has seen,
    // so a returning desktop attaches instead of waiting for an idle replacement.
    const launch = richestNative && compareNativeLaunch(richestNative, descriptor) === "subset" ? richestNative : descriptor;
    native = new NativeExecutionEngine(launch, owner, home, nativeRelayOwnsRegistration);
    if (launch === descriptor && (!richestNative || compareNativeLaunch(richestNative, descriptor) === "superset")) richestNative = descriptor;
    // Persist launch intent before spawn: a killed host cannot claim an unknown
    // child was never started merely because its PID publication was interrupted.
    telemetry("native_acquire", { outcome: "launched", richerLaunchReused: launch !== descriptor });
    try { await publish(); await native.start(publish); await publish(); return { ...native.record }; }
    catch (error) { await native.stop(); await publish(); throw error; }
  };
  const dispatch = async (method: string, params: Message, held: Set<string>): Promise<unknown> => {
    if (stopping) throw new Error("Execution host is closing");
    if (quiescing && ["execution/acquire", "execution/find", "native/acquire"].includes(method)) throw new Error("Execution host is quiescing for an idle restart");
    if (method === "execution/acquire") return acquire(params);
    if (method === "native/acquire") return acquireNative(params);
    if (method === "native/death") {
      if (typeof params.revision !== "string" || !/^[a-f0-9]{64}$/.test(params.revision) || !Number.isSafeInteger(params.pid) || Number(params.pid) < 1 ||
        typeof params.instanceId !== "string" || !/^[a-f0-9-]{36}$/.test(params.instanceId)) throw new Error("Invalid native execution death lookup");
      const death = owner.nativeDeaths?.find(value => value.pid === params.pid && value.revision === params.revision && value.instanceId === params.instanceId);
      return { confirmed: !!death, ...(death ? { exitedAtMs: death.exitedAtMs, intentional: death.intentional } : {}) };
    }
    if (method === "native/release") {
      if (typeof params.revision !== "string" || !/^[a-f0-9]{64}$/.test(params.revision)) throw new Error("Invalid native execution release");
      return { released: held.delete(`native:${params.revision}`) };
    }
    if (method === "execution/release") {
      if (typeof params.revision !== "string" || !/^[a-f0-9]{64}$/.test(params.revision)) throw new Error("Invalid execution generation release");
      return { released: held.delete(params.revision) };
    }
    if (method === "execution/find") {
      if (!capabilities.includes("gateway")) throw new Error("Execution host does not offer gateway ownership");
      if (typeof params.threadId !== "string" || !params.threadId || params.threadId.length > 128) throw new Error("Invalid loaded-chat lookup");
      let record: ExecutionRecord | null = null;
      for (const engine of engines.values()) if ((await engine.loadedThreads()).has(params.threadId)) {
        if (record) throw new Error("Multiple gateway generations report the same loaded chat; its ownership was preserved");
        record = engine.record;
      }
      return record ?? { found: false };
    }
    if (method === "execution/status") return { version: 1, pid: process.pid, quiescing, capabilities,
      native: native ? { ...native.record, state: native.closed ? "exited" : "running" } : null,
      generations: [...engines.values()].map(engine => ({ ...engine.record, pid: engine.owner.pid, state: engine.closed ? "exited" : "running" })) };
    throw new Error("Unknown execution host method");
  };
  const server = createServer((_req, response) => { response.writeHead(404); response.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: maxFrame, perMessageDeflate: false });
  server.on("upgrade", (request, socket, head) => {
    if (stopping || sockets.clients.size >= 8 || request.headers.origin || request.url !== "/") { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, client => {
      const ids = new Set<Id>(); const held = new Set<string>(); leases.set(client, held);
      client.on("close", () => leases.delete(client)); client.on("error", () => client.terminate());
      client.on("message", (bytes, binary) => {
        if (binary) { client.close(1003, "Text JSON required"); return; }
        let message: Message;
        try { message = object(JSON.parse(bytes.toString())); } catch { client.close(1007, "Invalid JSON"); return; }
        if (!isId(message.id) || typeof message.method !== "string" || ids.has(message.id)) { client.close(1008, "Invalid control request"); return; }
        if (pending >= 64) { client.close(1013, "Execution control busy"); return; }
        const id = message.id; ids.add(id); pending++;
        const run = async () => {
          const result = await dispatch(message.method as string, object(message.params), held);
          if (["execution/acquire", "execution/find"].includes(message.method as string) && typeof object(result).revision === "string") held.add((result as ExecutionRecord).revision);
          if (message.method === "native/acquire") held.add(`native:${(result as NativeExecutionRecord).revision}`);
          return result;
        };
        // `execution/status` only reads memory, so it is answered at once rather than behind an acquire or an idle check
        // in the queue: the service's 5 s probe must never read a busy host as a hung one.
        const status = message.method === "execution/status";
        const operation = status ? Promise.resolve().then(run) : serial.then(run);
        if (!status) serial = operation.catch(() => undefined);
        void operation.then(result => ({ id, result }), error => ({ id, error: { code: -32000, message: error instanceof Error && /^(Invalid execution|Execution descriptor|A gateway generation|Four gateway generations|Execution host (is (closing|quiescing)|does not offer)|Invalid native execution|This (Mac's gateway service is moving to the newer release|app and this Mac's gateway service run different gateway releases)|Native execution (startup settings differ|SDK exited|launch (is unconfirmed|changed during replacement)|remote-control flag conflicts|ownership (is held by a live owner|changed))|Invalid loaded-chat|Multiple gateway generations|Unknown execution host)/.test(error.message) ? error.message : "Execution operation failed; managed chat ownership was preserved" } }))
          .then(reply => {
            if (client.readyState !== WebSocket.OPEN) return;
            const payload = JSON.stringify(reply);
            if (Buffer.byteLength(payload) > maxFrame || client.bufferedAmount > maxFrame) { client.close(1009, "Execution output queue exceeded"); return; }
            client.send(payload, error => { if (error) client.terminate(); });
          }).finally(() => { ids.delete(id); pending--; });
      });
    });
  });
  const prepareStop = (): Promise<boolean> => {
    const operation = serial.then(async () => {
      if (stopping) return false;
      if (quiescing) return true;
      if ([...leases.values()].some(held => held.size)) return false;
      try { if (native && (await native.loadedThreads()).size) return false; for (const engine of engines.values()) if ((await engine.loadedThreads()).size) return false; }
      catch { return false; }
      // All queued acquires/finds execute after this gate closes; no owner can
      // appear between this idle check and the supervisor's inference guard.
      quiescing = true; return true;
    });
    serial = operation.catch(() => undefined); return operation;
  };
  // Chats seen running at the last quiet check, when a turn last ended, and since when each settling chat (one whose turns
  // cannot be listed) has been seen settled. A chat that was running then and is not now (its turn ended, it was unloaded, or
  // its engine exited, which clears its turns) ended at the latest now.
  let runningSeen = new Set<string>(); let lastTurnEndedAtMs = Number.NEGATIVE_INFINITY; let settlingSince = new Map<string, number>();
  /**
   * The upgrade's second rule, next to prepareStop: leases and loaded chats do not block it, a turn does. Quiet (the
   * loaded-chat count) only when no engine, gateway or native, has a turn running or waiting for an approval or input, no chat
   * keeps a background terminal, no turn ended within `quietMs`, every chat whose turns cannot be listed has been seen settled
   * for `quietMs`, and every loaded chat could be read; otherwise the first reason it is not. Like prepareStop it runs in the
   * serial queue and closes the gate itself, so no acquire or find runs between this check and the close; resume() reopens it.
   * Turns start on engine sockets, not here, so a turn started in the moment between this check and the close is not held
   * back: the supervisor closes at once. Undefined while the host is stopping or its gate is already closed.
   */
  const prepareQuietStop = (quietMs = defaultQuietMs): Promise<QuietStop | undefined> => {
    const operation = serial.then(async (): Promise<QuietStop | undefined> => {
      if (stopping || quiescing) return;
      const owned: Array<[string, ExecutionEngine | NativeExecutionEngine]> = [...engines.values()].map(engine => [engine.record.revision, engine]);
      if (native) owned.push(["native", native]);
      const running = new Set<string>(); const settling = new Set<string>(); let loadedChats = 0; let unknown = 0; let terminals = 0; let tooMany = false;
      let endedAtMs = Number.NEGATIVE_INFINITY;
      try {
        for (const [key, engine] of owned) {
          if (engine.closed) continue;
          const activity = await engineActivity(engine.record.socketPath, engine.owner.socket, quietMs);
          loadedChats += activity.loaded.length; unknown += activity.unknown; terminals += activity.terminals; tooMany ||= activity.tooMany;
          for (const threadId of activity.running) running.add(`${key}\0${threadId}`);
          for (const threadId of activity.settling) settling.add(`${key}\0${threadId}`);
          if (activity.lastEndedAtMs !== undefined) endedAtMs = Math.max(endedAtMs, activity.lastEndedAtMs);
        }
      } catch { settlingSince = new Map(); return { wait: "unreadable" }; } // An engine it could not read breaks the settled watch too.
      const now = Date.now();
      if ([...runningSeen].some(chat => !running.has(chat))) endedAtMs = Math.max(endedAtMs, now);
      runningSeen = running; lastTurnEndedAtMs = Math.max(lastTurnEndedAtMs, Math.min(endedAtMs, now));
      settlingSince = new Map([...settling].map(chat => [chat, settlingSince.get(chat) ?? now]));
      const wait: QuietWait | undefined = running.size ? "running" : terminals ? "background_terminal" : tooMany ? "too_many" : unknown ? "unreadable"
        : [...settlingSince.values()].some(since => now - since < quietMs) ? "ephemeral_settling" : now - lastTurnEndedAtMs < quietMs ? "recent_turn" : undefined;
      if (wait) return { wait };
      if (stopping) return;
      quiescing = true; return { loadedChats };
    });
    serial = operation.catch(() => undefined); return operation;
  };
  const close = (): Promise<void> => closed ||= (async () => {
    stopping = true; clearInterval(skewTimer); for (const socket of sockets.clients) socket.terminate();
    const stoppedServer = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    const results = await Promise.allSettled([...engines.values()].map(engine => engine.stop()).concat(native ? [native.stop()] : []));
    await serial.catch(() => undefined); await writes.catch(() => undefined); await stoppedServer; sockets.close();
    if (results.some(result => result.status === "rejected")) throw new Error("An execution generation did not stop; its ownership record was preserved");
    // A host that never claimed the native home (a live owner held it) may find it free now, holding the receipt a fallback
    // put back, such as a crashed host's that still says running: it claims it once, so the publish below writes a clean
    // stopped receipt. An owner that still lives, or any other refusal, keeps the receipt as it is.
    engines.clear(); await removeOwnedSocket(socketPath, owner.socket);
    // After its own control socket is gone, so the claim never finds this host's listener at the home it judges.
    if (capabilities.includes("native") && !nativeLease) await claimNative().catch(() => undefined);
    owner.pid = 0; owner.state = "stopped"; await publish();
  })();
  try {
    if (capabilities.includes("native")) {
      try { await claimNative(); }
      catch (error) {
        // A native-only host has nothing else to offer, so it still fails closed and the service retries it. A receipt that
        // names another configuration or spelling of the native home is not this host's to take either, but it must not take
        // gateway chats down: like a live owner, it leaves native ownership to the next native request.
        const reason = hostFailureReason(error);
        if (reason === "identity_changed" && !capabilities.includes("gateway")) throw nativeIdentityRefusal(options.nativeHome);
        if (!capabilities.includes("gateway") || reason !== "live_owner" && reason !== "identity_changed") throw error;
        telemetry("native_sharing_unavailable", { reason: reason === "live_owner" ? "native_owner" : "native_identity" });
      }
    }
    // Codex sandboxes always hide this SDK-reserved physical directory, including
    // access through links. The generation-control API must share that boundary.
    const physicalPath = await sdkSocketTarget(socketPath);
    await privateDirectory(dirname(physicalPath));
    const occupied = await lstat(physicalPath).catch(error => { if (error.code === "ENOENT") return; throw error; });
    if (occupied) {
      // A host that died between its listen and its link left a socket at this configuration's own hashed path that nothing
      // recorded: it would block every later start until a reboot cleared the folder. Only a socket of this user that refuses
      // a connect, and is still the same file when it goes, is removed, whatever its mode: a host that died before its chmod
      // (releases before 0.4.7 listened with the process umask) left it open to others, yet nothing listens there. A socket
      // that answers is never removed, and anything else is preserved as before.
      const orphan = occupied.isSocket() && occupied.uid === process.getuid?.() && !await socketAnswers(physicalPath);
      const again = orphan ? await lstat(physicalPath).catch(() => undefined) : undefined;
      if (!again || again.ino !== occupied.ino || again.dev !== occupied.dev) throw new Error("Execution control socket target is occupied; its listener was preserved");
      await unlink(physicalPath);
    }
    // Private from its first instant; the chmod stays as a second guard.
    await listenPrivate(server, physicalPath); await chmod(physicalPath, 0o600);
    await symlink(physicalPath, socketPath);
    owner.socket = await socketIdentity(socketPath); await publish();
    return { close, prepareStop, prepareQuietStop, skewRefused: release => !stopping && urgentReleases.has(release), resume: () => { if (!stopping) quiescing = false; } };
  } catch (error) { await close(); throw error; }
}
