import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { executionHostHome, livePid, readOwner, socketIdentity, sameSocketIdentity } from "./execution-host-storage.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";
import type { Message } from "./app-server-connection.js";
import type { ExecutionDescriptor, ExecutionRecord } from "./execution-host-engine.js";

/** One control connection keeps its generation leases until the adapter closes. */
export class ExecutionHostClient {
  private readonly connection: SocketAppServerConnection;
  private constructor(private readonly home: string, socketPath: string) { this.connection = new SocketAppServerConnection(socketPath, async () => {}); }
  get closed(): boolean { return this.connection.closed; }
  static async discover(configPath: string, nativeHome: string, codex: string): Promise<ExecutionHostClient | undefined> {
    const home = executionHostHome(configPath, nativeHome);
    const owner = await readOwner(resolve(home, "owner.json"));
    if (!owner) return;
    const socketPath = resolve(home, "host.sock");
    if (owner.configPath !== resolve(configPath) || owner.nativeHome !== resolve(nativeHome) || owner.codex !== await realpath(codex) || owner.socketPath !== socketPath) throw new Error("Shared executor ownership does not match this adapter");
    if (owner.state !== "running" || !livePid(owner.pid)) throw new Error("Shared executor host is unavailable; check gateway service status");
    const socket = await socketIdentity(socketPath);
    if (!socket || !owner.socket || !sameSocketIdentity(owner.socket, socket)) throw new Error("Shared executor socket ownership changed; it was preserved");
    const client = new ExecutionHostClient(home, socketPath);
    try { await client.connection.ready; return client; }
    catch (error) { client.close(); throw error; }
  }
  private record(value: Message): ExecutionRecord {
    if (typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision) || value.socketPath !== resolve(this.home, `e-${value.revision.slice(0, 16)}.sock`) || !Array.isArray(value.aliases) || !value.aliases.length || value.aliases.length > 256 || value.aliases.some(alias => typeof alias !== "string" || !alias || alias.length > 1024)) throw new Error("Shared executor returned invalid generation metadata");
    return value as unknown as ExecutionRecord;
  }
  async acquire(descriptor: ExecutionDescriptor): Promise<ExecutionRecord> {
    return this.record(await this.connection.request("execution/acquire", { ...descriptor }));
  }
  async find(threadId: string): Promise<ExecutionRecord | undefined> {
    const result = await this.connection.request("execution/find", { threadId });
    return result.found === false ? undefined : this.record(result);
  }
  async release(revision: string): Promise<void> { await this.connection.request("execution/release", { revision }); }
  close(): void { this.connection.stop(); }
}
