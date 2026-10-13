import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { executionHostHome, executionCapabilities, livePid, readOwner, socketIdentity, sameSocketIdentity, type ExecutionCapability } from "./execution-host-storage.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";
import type { Message } from "./app-server-connection.js";
import type { ExecutionDescriptor, ExecutionRecord } from "./execution-host-engine.js";
import type { NativeExecutionRecord } from "./native-execution-host-engine.js";
import { readNativeHomeOwner } from "./native-execution-host-storage.js";
import { acquireNativeCompatible } from "./native-execution-compat.js";
export type NativeLaunchRecord = NativeExecutionRecord & { instanceId: string };

/** One control connection keeps its generation leases until the adapter closes. */
export class ExecutionHostClient {
  private readonly connection: SocketAppServerConnection;
  private constructor(private readonly home: string, socketPath: string, readonly capabilities: readonly ExecutionCapability[]) { this.connection = new SocketAppServerConnection(socketPath, async () => {}); }
  get closed(): boolean { return this.connection.closed; }
  static async assertNativeUnowned(configPath: string | undefined, nativeHome: string): Promise<void> {
    const homeOwner = await readNativeHomeOwner(nativeHome);
    const blocked = () => { throw Object.assign(new Error("A managed shared native executor still owns this native home. Finish the sharing-mode migration before reconnecting; its chats were preserved."), { code: -32001 }); };
    if (homeOwner && (livePid(homeOwner.hostPid) || livePid(homeOwner.pid) || (homeOwner.state === "running" && homeOwner.sdkState === "starting"))) blocked();
    if (!configPath) return;
    const owner = await readOwner(resolve(executionHostHome(configPath, nativeHome), "owner.json"));
    if (owner && owner.configPath === resolve(configPath) && owner.nativeHome === resolve(nativeHome) && executionCapabilities(owner.capabilities).includes("native")
      && (livePid(owner.pid) || livePid(owner.native?.pid || 0))) blocked();
  }
  static async discover(configPath: string, nativeHome: string, codex: string, capability: ExecutionCapability = "gateway", required = false): Promise<ExecutionHostClient | undefined> {
    const home = executionHostHome(configPath, nativeHome);
    const owner = await readOwner(resolve(home, "owner.json"));
    if (!owner) {
      if (required) throw new Error(`Shared ${capability} executor host is unavailable; check gateway service status`);
      return;
    }
    const capabilities = executionCapabilities(owner.capabilities);
    if (!capabilities.includes(capability)) {
      if (required) throw new Error(`Shared ${capability} executor is not enabled in the configured host`);
      return;
    }
    const socketPath = resolve(home, "host.sock");
    if (owner.configPath !== resolve(configPath) || owner.nativeHome !== resolve(nativeHome) || owner.codex !== await realpath(codex) || owner.socketPath !== socketPath) throw new Error("Shared executor ownership does not match this adapter");
    if (owner.state !== "running" || !livePid(owner.pid)) throw new Error("Shared executor host is unavailable; check gateway service status");
    const socket = await socketIdentity(socketPath);
    if (!socket || !owner.socket || !sameSocketIdentity(owner.socket, socket)) throw new Error("Shared executor socket ownership changed; it was preserved");
    const client = new ExecutionHostClient(home, socketPath, capabilities);
    try { await client.connection.ready; return client; }
    catch (error) { client.close(); throw error; }
  }
  private record(value: Message): ExecutionRecord {
    if (typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision) || value.socketPath !== resolve(this.home, `e-${value.revision.slice(0, 16)}.sock`) || !Array.isArray(value.aliases) || !value.aliases.length || value.aliases.length > 256 || value.aliases.some(alias => typeof alias !== "string" || !alias || alias.length > 1024)
      || (value.selectedModelCompaction !== undefined && value.selectedModelCompaction !== true)) throw new Error("Shared executor returned invalid generation metadata");
    return value as unknown as ExecutionRecord;
  }
  async acquire(descriptor: ExecutionDescriptor): Promise<ExecutionRecord> {
    if (!this.capabilities.includes("gateway")) throw new Error("Shared gateway execution is not enabled");
    return this.record(await this.connection.request("execution/acquire", { ...descriptor }));
  }
  async find(threadId: string): Promise<ExecutionRecord | undefined> {
    if (!this.capabilities.includes("gateway")) return;
    const result = await this.connection.request("execution/find", { threadId });
    return result.found === false ? undefined : this.record(result);
  }
  async release(revision: string): Promise<void> { await this.connection.request("execution/release", { revision }); }
  private async codeModeAlreadyEnabled(): Promise<boolean> {
    const owner = await readOwner(resolve(this.home, "owner.json")); const native = owner?.native;
    if (owner?.state !== "running" || !native || !livePid(native.pid) || native.socketPath !== resolve(this.home, "native.sock")) return false;
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
    const value = await acquireNativeCompatible(params => this.connection.request("native/acquire", params), args, cwd, () => this.codeModeAlreadyEnabled());
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
  close(): void { this.connection.stop(); }
}
