import { createServer } from "node:http";
import { chmod, lstat, symlink } from "node:fs/promises";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { object, isId, type Id, type Message } from "./app-server-connection.js";
import type { GatewayConfig } from "./config.js";
import { ExecutionEngine, executionDescriptor, validateExecutionSdk, descriptorFingerprint, type ExecutionRecord } from "./execution-host-engine.js";
import { claimHost, executionHostHome, executionHostMarker, privateDirectory, publishOwner, removeOwnedSocket, sdkIdentity, sdkSocketTarget, socketIdentity, type HostOwner } from "./execution-host-storage.js";

export { executionHostHome } from "./execution-host-storage.js";
export type { ExecutionDescriptor, ExecutionRecord } from "./execution-host-engine.js";
export interface ExecutionHostOptions { config: GatewayConfig; configPath: string; nativeHome: string; codex: string }
const maxFrame = 4 * 1024 * 1024;

/** One owned SDK writer per gateway generation, independent of adapter clients. */
export async function startExecutionHost(options: ExecutionHostOptions): Promise<{ close(): Promise<void>; prepareStop(): Promise<boolean>; resume(): void }> {
  const home = executionHostHome(options.configPath, options.nativeHome); const socketPath = resolve(home, "host.sock");
  if (Buffer.byteLength(socketPath) > 103) throw new Error("Execution host Unix socket path exceeds 103 bytes");
  const sdk = await sdkIdentity(options.codex); await validateExecutionSdk(sdk.codex);
  const owner: HostOwner = await claimHost(home, { version: 1, managed: executionHostMarker, configPath: resolve(options.configPath), nativeHome: resolve(options.nativeHome), ...sdk, socketPath });
  const engines = new Map<string, ExecutionEngine>(); const leases = new Map<WebSocket, Set<string>>(); let stopping = false; let quiescing = false; let closed: Promise<void> | undefined;
  let writes: Promise<void> = Promise.resolve(); let serial: Promise<unknown> = Promise.resolve(); let pending = 0;
  const publish = () => {
    const snapshot: HostOwner = { ...owner, generations: [...engines.values()].map(engine => ({ ...engine.owner })) };
    writes = writes.catch(() => undefined).then(() => publishOwner(home, snapshot)); return writes;
  };
  const remove = async (engine: ExecutionEngine) => { await engine.stop(); engines.delete(engine.record.revision); await publish(); };
  const acquire = async (params: Message): Promise<ExecutionRecord> => {
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
    const engine = new ExecutionEngine(descriptor, owner, home); engines.set(descriptor.revision, engine);
    try { await engine.start(options.config, publish); await publish(); return engine.record; }
    catch (error) { await remove(engine); throw error; }
  };
  const dispatch = async (method: string, params: Message, held: Set<string>): Promise<unknown> => {
    if (stopping) throw new Error("Execution host is closing");
    if (quiescing && ["execution/acquire", "execution/find"].includes(method)) throw new Error("Execution host is quiescing for an idle restart");
    if (method === "execution/acquire") return acquire(params);
    if (method === "execution/release") {
      if (typeof params.revision !== "string" || !/^[a-f0-9]{64}$/.test(params.revision)) throw new Error("Invalid execution generation release");
      return { released: held.delete(params.revision) };
    }
    if (method === "execution/find") {
      if (typeof params.threadId !== "string" || !params.threadId || params.threadId.length > 128) throw new Error("Invalid loaded-chat lookup");
      let record: ExecutionRecord | null = null;
      for (const engine of engines.values()) if ((await engine.loadedThreads()).has(params.threadId)) {
        if (record) throw new Error("Multiple gateway generations report the same loaded chat; its ownership was preserved");
        record = engine.record;
      }
      return record ?? { found: false };
    }
    if (method === "execution/status") return { version: 1, pid: process.pid, quiescing, generations: [...engines.values()].map(engine => ({ ...engine.record, pid: engine.owner.pid, state: engine.closed ? "exited" : "running" })) };
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
        const operation = serial.then(async () => {
          const result = await dispatch(message.method as string, object(message.params), held);
          if (["execution/acquire", "execution/find"].includes(message.method as string) && typeof object(result).revision === "string") held.add((result as ExecutionRecord).revision);
          return result;
        });
        serial = operation.catch(() => undefined);
        void operation.then(result => ({ id, result }), error => ({ id, error: { code: -32000, message: error instanceof Error && /^(Invalid execution|Execution descriptor|A gateway generation|Four gateway generations|Execution host is (closing|quiescing)|Invalid loaded-chat|Multiple gateway generations|Unknown execution host)/.test(error.message) ? error.message : "Execution operation failed; managed chat ownership was preserved" } }))
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
      try { for (const engine of engines.values()) if ((await engine.loadedThreads()).size) return false; }
      catch { return false; }
      // All queued acquires/finds execute after this gate closes; no owner can
      // appear between this idle check and the supervisor's inference guard.
      quiescing = true; return true;
    });
    serial = operation.catch(() => undefined); return operation;
  };
  const close = (): Promise<void> => closed ||= (async () => {
    stopping = true; for (const socket of sockets.clients) socket.terminate();
    const stoppedServer = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    const results = await Promise.allSettled([...engines.values()].map(engine => engine.stop()));
    await serial.catch(() => undefined); await writes.catch(() => undefined); await stoppedServer; sockets.close();
    if (results.some(result => result.status === "rejected")) throw new Error("An execution generation did not stop; its ownership record was preserved");
    engines.clear(); await removeOwnedSocket(socketPath, owner.socket);
    owner.pid = 0; owner.state = "stopped"; await publish();
  })();
  try {
    // Codex sandboxes always hide this SDK-reserved physical directory, including
    // access through links. The generation-control API must share that boundary.
    const physicalPath = await sdkSocketTarget(socketPath);
    await privateDirectory(dirname(physicalPath));
    const occupied = await lstat(physicalPath).catch(error => { if (error.code === "ENOENT") return; throw error; });
    if (occupied) throw new Error("Execution control socket target is occupied; its listener was preserved");
    server.listen(physicalPath); await once(server, "listening"); await chmod(physicalPath, 0o600);
    await symlink(physicalPath, socketPath);
    owner.socket = await socketIdentity(socketPath); await publish();
    return { close, prepareStop, resume: () => { if (!stopping) quiescing = false; } };
  } catch (error) { await close(); throw error; }
}
