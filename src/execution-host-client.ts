import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { nativeEngineExecutable, nativeOwnerEngineExecutable } from "./native-engine-path.js";
import { setTimeout as delay } from "node:timers/promises";
import { executionHostHome, executionCapabilities, readOwnerRecord, receiptPidAlive, socketIdentity, socketAnswers, sameSocketIdentity, type ExecutionCapability } from "./execution-host-storage.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";
import { object, type Message } from "./app-server-connection.js";
import type { ExecutionDescriptor, ExecutionRecord } from "./execution-host-engine.js";
import type { NativeExecutionRecord } from "./native-execution-host-engine.js";
import { nativeHomeOwnership, readNativeHomeOwnerRecord } from "./native-execution-host-storage.js";
import { acquireNativeCompatible } from "./native-execution-compat.js";
import { requestHostKick } from "./execution-host-kick.js";
export type NativeLaunchRecord = NativeExecutionRecord & { instanceId: string };
/** How long a required host may take to come back (a restart after a crash, a reboot or an update) before an adapter fails. */
const defaultHostWaitMs = 20_000; const hostPollMs = 250;
let hostWaitMs = defaultHostWaitMs;
/** Tests shorten the wait for a required host instead of sitting it out. Undefined restores the production value. */
export function setHostWaitForTests(ms?: number): void { hostWaitMs = ms ?? defaultHostWaitMs; }
/**
 * A host whose gate is closed for a restart check refuses acquire and find as quiescing. A check that is refused (inference
 * still busy) reopens the gate within about 3 s, so these requests ask again every 100 ms for up to 5 s before failing; a
 * host that goes on to restart closes the connection instead, which ends the wait at once.
 */
const quiescingWaitMs = 5_000; const quiescingPollMs = 100;
const quiescing = (error: unknown): boolean => error instanceof Error && /^Execution host is quiescing/.test(error.message);
/** One look at the host: a client, or the error today's single look would throw and whether waiting could change it. */
type HostLook = { client?: ExecutionHostClient; failure?: Error; retry?: boolean };
/**
 * The failures that mean the host is simply down: no receipt, or a valid receipt that names no running, live host. Only these
 * may let an adapter run a private native engine; a host that does not match, a changed socket or any other failure never does.
 */
const unavailable = (message: string): Error => Object.assign(new Error(message), { hostUnavailable: true });
export function hostUnavailable(error: unknown): boolean { return (error as { hostUnavailable?: unknown } | undefined)?.hostUnavailable === true; }
/** Why a desktop adapter that shares native chats runs its own native engine instead, from a fixed vocabulary. */
export type NativeFallbackReason = "host_unavailable" | "other" | "native_owner";
/**
 * The fallback a failed native discovery or acquisition allows, if any: `host_unavailable` when the host stayed down through
 * the wait, `other` when a running host offers gateway chats without native sharing, and `native_owner` when a running
 * host refused native ownership because a live owner, such as private engines that ran while it was down, holds the home.
 * Everything else fails closed.
 */
export function nativeFallbackReason(error: unknown, sharedGateway: boolean): NativeFallbackReason | undefined {
  if ((error as { nativeOwnerHeld?: unknown } | undefined)?.nativeOwnerHeld === true) return "native_owner";
  if ((error as { capabilityAbsent?: unknown } | undefined)?.capabilityAbsent === "native") return sharedGateway ? "other" : undefined;
  return hostUnavailable(error) ? "host_unavailable" : undefined;
}
/** Whether private desktop engines (not a host) hold the native home now, so a refused adapter should join them. */
export async function privateEnginesHoldNativeHome(nativeHome: string): Promise<boolean> {
  return (await readNativeHomeOwnerRecord(nativeHome).catch(() => undefined))?.owner?.privateOwner !== undefined;
}
/**
 * After a restart, the new host can start while the old host is still exiting: its claim of the native home is refused, and
 * it claims again only at the next native request. An adapter refused then must not start a private engine, because the
 * first private engine keeps the home from the host for as long as any desktop stays connected. So while no private engines
 * hold the home, it asks the host again until the wait ends. It returns undefined when private engines do hold the home (the
 * adapter joins them, as before) or the wait ran out; any refusal other than a held native home is thrown.
 */
export async function awaitHostNativeOwnership<T>(acquire: () => Promise<T>, privateHolds: () => Promise<boolean>, signal?: AbortSignal,
  waitMs = hostWaitMs, pollMs = hostPollMs): Promise<T | undefined> {
  const deadline = Date.now() + waitMs;
  while (!signal?.aborted && Date.now() < deadline) {
    if (await privateHolds()) return undefined;
    try { await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())), undefined, signal ? { signal } : {}); } catch { return undefined; }
    try { return await acquire(); }
    catch (error) { if (nativeFallbackReason(error, true) !== "native_owner") throw error; }
  }
  return undefined;
}
/** A receipt left by an owner that is gone must not look alive: its pid alone is not proof. */
async function ownerMtime(home: string): Promise<number> { return (await lstat(resolve(home, "owner.json")).catch(() => undefined))?.mtimeMs ?? Number.POSITIVE_INFINITY; }
async function receiptAlive(record: { pid: number; bootId?: string; startedAtMs?: number; socketPath?: string }, mtimeMs: number): Promise<boolean> {
  if (record.pid > 0 && await receiptPidAlive(record, mtimeMs)) return true;
  return record.socketPath !== undefined && await socketAnswers(record.socketPath);
}

/** One control connection keeps its generation leases until the adapter closes. */
export class ExecutionHostClient {
  private readonly connection: SocketAppServerConnection;
  private closedByUs = false;
  private constructor(private readonly home: string, socketPath: string, readonly capabilities: readonly ExecutionCapability[]) { this.connection = new SocketAppServerConnection(socketPath, async () => {}); }
  get closed(): boolean { return this.connection.closed; }
  /** Resolves when the one control connection closes, whether this adapter asked for it or the host dropped it. */
  get exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> { return this.connection.exited; }
  /** True once `close()` has been called here, so a later `exited` is our own shutdown rather than a lost host. */
  get closedByAdapter(): boolean { return this.closedByUs; }
  static async assertNativeUnowned(configPath: string | undefined, nativeHome: string): Promise<void> {
    const blocked = () => { throw Object.assign(new Error("A managed shared native executor still owns this native home. Finish the sharing-mode migration before reconnecting; its chats were preserved."), { code: -32001 }); };
    // The same verdict a host's claim gets: a live host (even with its SDK idle), a launch still inside its startup grace, or a
    // receipt nothing can prove dead all keep a private writer out, so one native home never has two writers.
    const ownership = await nativeHomeOwnership(nativeHome, configPath ? executionHostHome(configPath, nativeHome) : undefined);
    if (ownership === "live" || ownership === "unconfirmed") blocked();
    if (!configPath) return;
    const owner = await readOwnerRecord(resolve(executionHostHome(configPath, nativeHome), "owner.json"));
    if (owner.owner && owner.owner.configPath === resolve(configPath) && owner.owner.nativeHome === resolve(nativeHome) && executionCapabilities(owner.owner.capabilities).includes("native")
      && (await receiptAlive(owner.owner, owner.mtimeMs) || (owner.owner.native ? await receiptAlive(owner.owner.native, owner.mtimeMs) : false))) blocked();
  }
  /**
   * The host for this configuration. A required host that is missing, not running, dead, or whose socket no longer matches
   * its receipt is usually restarting: the adapter asks the service for an immediate retry (a kick) and waits up to 20 s,
   * looking every 250 ms, for a running, live owner. It then answers as a single look would: the same client or the same
   * error, so a host that stays down still fails with today's message. A live host that does not match fails at once, and
   * an optional host (`required` false) is looked at once, as before.
   */
  static async discover(configPath: string, nativeHome: string, codex: string, capability: ExecutionCapability = "gateway", required = false, signal?: AbortSignal): Promise<ExecutionHostClient | undefined> {
    const home = executionHostHome(configPath, nativeHome); const deadline = Date.now() + hostWaitMs; let kicked = false;
    for (;;) {
      if (signal?.aborted) throw new Error("Shared executor discovery was cancelled");
      const pending = ExecutionHostClient.look(home, configPath, nativeHome, codex, capability, required);
      // SocketAppServerConnection has its own connect timeout. A list operation
      // must not inherit it: abandon the wait immediately and close a client that
      // finishes connecting after its caller has gone away.
      const look = signal ? await Promise.race([pending, new Promise<HostLook>((_, reject) => signal.addEventListener("abort", () => reject(new Error("Shared executor discovery was cancelled")), { once: true }))]).catch(error => {
        void pending.then(value => value.client?.close(), () => {}); throw error;
      }) : await pending;
      if (signal?.aborted) { look.client?.close(); throw new Error("Shared executor discovery was cancelled"); }
      if (!look.failure) return look.client;
      if (!required || !look.retry || signal?.aborted || Date.now() >= deadline) throw look.failure;
      if (!kicked) { kicked = true; await requestHostKick(home); }
      try { await delay(Math.min(hostPollMs, Math.max(1, deadline - Date.now())), undefined, signal ? { signal } : {}); }
      catch { throw look.failure; } // The caller gave up: it gets the answer it would have had without waiting.
    }
  }
  private static async look(home: string, configPath: string, nativeHome: string, codex: string, capability: ExecutionCapability, required: boolean): Promise<HostLook> {
    const receipt = await readOwnerRecord(resolve(home, "owner.json")); const owner = receipt.owner; const receiptMtime = receipt.mtimeMs;
    // A receipt this release cannot read may be a newer host's: it is not proof that the host is down.
    if (!owner) return required ? { failure: receipt.invalid ? new Error(`Shared ${capability} executor host is unavailable; check gateway service status`)
      : unavailable(`Shared ${capability} executor host is unavailable; check gateway service status`), retry: true } : {};
    // A receipt that names no running, live host is a host the service can still bring back; one that does decides now.
    const live = owner.state === "running" && await receiptPidAlive(owner, receiptMtime);
    const fail = (failure: Error, retry = !live): HostLook => ({ failure, retry });
    const capabilities = executionCapabilities(owner.capabilities);
    if (!capabilities.includes(capability)) return required ? fail(Object.assign(new Error(`Shared ${capability} executor is not enabled in the configured host`), { capabilityAbsent: capability })) : {};
    const socketPath = resolve(home, "host.sock");
    if (owner.configPath !== resolve(configPath) || owner.nativeHome !== resolve(nativeHome) || owner.socketPath !== socketPath) return fail(new Error("Shared executor ownership does not match this adapter"));
    // Only native sharing runs the app's own engine. A gateway-only host runs its pinned runtime, guarded by that runtime's
    // checksum, so an app update that moves, relinks or removes the app's codex must not make its host look foreign.
    try {
      if (capability === "native" && capabilities.includes("native") && await nativeOwnerEngineExecutable(owner.codex, owner.nativeSdkExecutable) !== await nativeEngineExecutable(codex)) {
        return fail(new Error("Shared executor ownership does not match this adapter"));
      }
    }
    catch (error) { return fail(error as Error); }
    if (!live) return fail(unavailable("Shared executor host is unavailable; check gateway service status"));
    // A live host whose socket is gone or replaced, or that refuses the connection, is the host going away: wait for the next one.
    let socket;
    try { socket = await socketIdentity(socketPath); } catch (error) { return fail(error as Error, true); }
    if (!socket || !owner.socket || !sameSocketIdentity(owner.socket, socket)) return fail(new Error("Shared executor socket ownership changed; it was preserved"), true);
    const client = new ExecutionHostClient(home, socketPath, capabilities);
    try { await client.connection.ready; return { client }; }
    catch (error) { client.close(); return fail(error as Error, true); }
  }
  /** One control request, asked again while the host's gate is closed for a restart check that may still be refused. */
  private async request(method: string, params: Message): Promise<Message> {
    const deadline = Date.now() + quiescingWaitMs;
    for (;;) {
      try { return await this.connection.request(method, params); }
      catch (error) {
        if (!quiescing(error) || this.connection.closed || Date.now() >= deadline) throw error;
        await delay(quiescingPollMs);
      }
    }
  }
  private record(value: Message): ExecutionRecord {
    if (typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision) || value.socketPath !== resolve(this.home, `e-${value.revision.slice(0, 16)}.sock`) || !Array.isArray(value.aliases) || !value.aliases.length || value.aliases.length > 256 || value.aliases.some(alias => typeof alias !== "string" || !alias || alias.length > 1024)
      || (value.selectedModelCompaction !== undefined && value.selectedModelCompaction !== true)
      || (value.defaultCwd !== undefined && (typeof value.defaultCwd !== "string" || !isAbsolute(value.defaultCwd) || value.defaultCwd.length > 4096 || /[\0\r\n]/.test(value.defaultCwd)))) throw new Error("Shared executor returned invalid generation metadata");
    return value as unknown as ExecutionRecord;
  }
  async acquire(descriptor: ExecutionDescriptor): Promise<ExecutionRecord> {
    if (!this.capabilities.includes("gateway")) throw new Error("Shared gateway execution is not enabled");
    return this.record(await this.request("execution/acquire", { ...descriptor }));
  }
  async find(threadId: string): Promise<ExecutionRecord | undefined> {
    if (!this.capabilities.includes("gateway")) return;
    const result = await this.request("execution/find", { threadId });
    return result.found === false ? undefined : this.record(result);
  }
  /**
   * Read the currently running gateway generations without acquiring one.  This is
   * deliberately separate from `find()`/`acquire()`: a chat-list observer must
   * never wake a host or take a generation lease merely to render runtime state.
   */
  async generations(): Promise<ExecutionRecord[]> {
    if (!this.capabilities.includes("gateway")) return [];
    const status = await this.request("execution/status", {});
    if (status.version !== 1 || !Array.isArray(status.generations)) {
      throw new Error("Shared executor returned invalid generation status");
    }
    const seen = new Set<string>(); const records: ExecutionRecord[] = [];
    for (const value of status.generations) {
      const generation = object(value);
      if (generation.state !== "running") continue;
      const record = this.record(generation);
      if (seen.has(record.revision)) throw new Error("Shared executor returned duplicate generation metadata");
      seen.add(record.revision); records.push(record);
    }
    return records;
  }
  async release(revision: string): Promise<void> { await this.connection.request("execution/release", { revision }); }
  private async codeModeAlreadyEnabled(): Promise<boolean> {
    const receipt = await readOwnerRecord(resolve(this.home, "owner.json")); const native = receipt.owner?.native;
    if (receipt.owner?.state !== "running" || !native || native.socketPath !== resolve(this.home, "native.sock")) return false;
    if (!(await receiptAlive(native, receipt.mtimeMs))) return false;
    const socket = await socketIdentity(native.socketPath);
    if (!socket || !native.socket || !sameSocketIdentity(socket, native.socket)) return false;
    const admin = new SocketAppServerConnection(native.socketPath, async () => {}); let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([(async () => {
        await admin.ready;
        await admin.request("initialize", { clientInfo: { name: "codex_app_server_daemon", version: "1" }, capabilities: { experimentalApi: true } });
        admin.send({ method: "initialized", params: {} });
        let cursor: string | undefined;
        for (let page = 0; page < 8; page++) {
          const result = await admin.request("experimentalFeature/list", { limit: 100, ...(cursor ? { cursor } : {}) });
          if (!Array.isArray(result.data) || result.data.length > 100) return false;
          const feature = result.data.find(value => value && typeof value === "object" && value.name === "code_mode_host");
          if (feature) return feature.enabled === true;
          if (result.nextCursor == null || typeof result.nextCursor !== "string" || result.nextCursor === cursor) return false;
          cursor = result.nextCursor;
        }
        return false;
      })(), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
    } catch { return false; }
    finally { clearTimeout(timer); admin.stop(); }
  }
  async acquireNative(args: string[], cwd: string): Promise<NativeLaunchRecord> {
    if (!this.capabilities.includes("native")) throw new Error("Shared native execution is not enabled");
    // The host's fixed refusal while another live owner holds the native home (its own text, passed through unchanged).
    const value = await acquireNativeCompatible(params => this.request("native/acquire", params), args, cwd, () => this.codeModeAlreadyEnabled()).catch(error => {
      const { code, message } = error as { code?: unknown; message?: unknown };
      throw code === -32000 && typeof message === "string" && message.startsWith("Native execution ownership is held by a live owner;") ? Object.assign(error as Error, { nativeOwnerHeld: true }) : error;
    });
    if (value.kind !== "native" || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision) || value.socketPath !== resolve(this.home, "native.sock") || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1
      || typeof value.instanceId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.instanceId)) throw new Error("Shared native executor returned invalid ownership metadata");
    if (!await socketIdentity(value.socketPath as string)) throw new Error("Shared native executor socket is unavailable");
    return value as unknown as NativeLaunchRecord;
  }
  async releaseNative(revision: string): Promise<void> { await this.connection.request("native/release", { revision }); }
  async confirmedNativeDeath(record: NativeLaunchRecord): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = Date.now() + 1000;
      const timeout = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1000).unref(); });
      const lookup = async (): Promise<boolean> => {
        while (!this.connection.closed && Date.now() < deadline) {
          const result = await this.connection.request("native/death", { revision: record.revision, pid: record.pid, instanceId: record.instanceId });
          if (result.confirmed === true) return result.exitedAtMs === undefined || (typeof result.exitedAtMs === "number" && Number.isSafeInteger(result.exitedAtMs) && result.exitedAtMs >= 0);
          if (result.confirmed !== false) return false;
          // Socket EOF can precede the host's child-close observer. Give that
          // exact launch a bounded chance to publish its actual death proof.
          await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { ref: false });
        }
        return false;
      };
      return await Promise.race([lookup().catch(() => false), timeout]);
    } catch { return false; }
    finally { clearTimeout(timer); }
  }
  close(): void { this.closedByUs = true; this.connection.stop(); }
}
