import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { constants } from "node:fs";
import { open, opendir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { Message } from "./app-server-connection.js";
import { ownerStamp } from "./boot-identity.js";
import { listenPrivate, privateDirectory, receiptPidAlive, socketAnswers, socketIdentity, type SocketIdentity } from "./execution-host-storage.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";
import { testSafeRoot } from "./test-root-guard.js";

const protocol = "gw-native-runtime-status";
const version = 1;
const frameLimit = 1024 * 1024;
const registryInspectLimit = 64;
const registrationLimit = 4096;
const peersLimit = 16;
const clientsLimit = 8;
const pendingLimit = 8;
const pageLimit = 100;
const snapshotLimit = 512;
const maxPages = snapshotLimit;
const nativeReadLimit = 4;
const probeDeadlineMs = 1000;
const listDeadlineMs = 1500;
const refreshMs = 5000;
const textLimit = 256;

type RuntimeStatus = "notLoaded" | "idle" | "systemError" | { type: "notLoaded" | "idle" | "systemError" | "active"; activeFlags?: ("waitingOnApproval" | "waitingOnUserInput")[] };
export type NativeRuntimeSnapshot = { id: string; status?: RuntimeStatus; model?: string | null; reasoningEffort?: string | null; canAcceptDirectInput?: boolean | null };
type Registration = { protocol: typeof protocol; version: typeof version; pid: number; bootId?: string; startedAtMs?: number; scope: string; socketPath: string; socket: SocketIdentity; instance: string };
type PeerEvent = { revision: number; status: RuntimeStatus };
type Peer = { registration: Registration; connection?: SocketAppServerConnection; snapshots: Map<string, NativeRuntimeSnapshot>; events?: Map<string, PeerEvent>; revision: number; reading?: Promise<void>; available: boolean };
type PeerDiscovery = { registrations: Registration[]; complete: boolean };

export interface NativeRuntimeStatusOptions {
  nativeHome: string;
  scope?: string;
  readOnlyNativeRequest(method: string, params: Message): Promise<Message>;
  emitStatus(message: Message): void | Promise<void>;
  reportError?(error: Error): void;
}

let runtimeRootOverride: string | undefined;
export function nativeRuntimeRoot(): string { return runtimeRootOverride ?? testSafeRoot(resolve(homedir(), ".local/state/gw-runtime"), "native runtime status root"); }
export function setNativeRuntimeRootForTests(root?: string): void { runtimeRootOverride = root ? resolve(root) : undefined; }
function runtimeSocketRoot(): string {
  const suffix = runtimeRootOverride ? `test-${hash(runtimeRootOverride)}` : String(process.getuid?.() ?? "user");
  const root = resolve("/tmp", `gw-runtime-${suffix}`);
  return runtimeRootOverride ? root : testSafeRoot(root, "native runtime status sockets", { fixed: true });
}

function object(value: unknown): Message | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Message : undefined; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
function pathInside(parent: string, candidate: string): boolean { const rest = relative(parent, candidate); return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest); }
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512; }
function validScope(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function boundedText(value: unknown): string | null | undefined { return value === null || typeof value === "string" && value.length <= textLimit ? value : undefined; }
function has(value: Message, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function validStatus(value: unknown): RuntimeStatus | undefined {
  if (value === "notLoaded" || value === "idle" || value === "systemError") return value;
  const status = object(value); const type = status?.type;
  if (type !== "notLoaded" && type !== "idle" && type !== "systemError" && type !== "active") return;
  if (type !== "active") return { type };
  const flags = status!.activeFlags;
  if (!Array.isArray(flags) || flags.length > 2 || flags.some(flag => flag !== "waitingOnApproval" && flag !== "waitingOnUserInput")) return;
  return { type, activeFlags: [...new Set(flags)] as ("waitingOnApproval" | "waitingOnUserInput")[] };
}
function isNotLoaded(status: RuntimeStatus | undefined): boolean { return status === "notLoaded" || typeof status === "object" && status.type === "notLoaded"; }
function sameSocket(a: SocketIdentity, b: SocketIdentity): boolean { return a.inode === b.inode && a.device === b.device; }
function cloneStatus(status: RuntimeStatus | undefined): RuntimeStatus | undefined { return status && typeof status === "object" ? { ...status, ...(status.activeFlags ? { activeFlags: [...status.activeFlags] } : {}) } : status; }
function remaining(deadline: number): number { return deadline - Date.now(); }
function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolvePromise, reject) => { const timer = setTimeout(() => reject(new Error(message)), ms).unref(); promise.then(value => { clearTimeout(timer); resolvePromise(value); }, error => { clearTimeout(timer); reject(error); }); });
}

/** Shares live native runtime metadata between private adapters without owning a peer's SDK. */
export class NativeRuntimeStatus {
  private readonly scope: string;
  private readonly home: string;
  private readonly socketHome: string;
  private readonly instance = randomBytes(12).toString("hex");
  private readonly socketPath: string;
  private readonly registrationPath: string;
  private server?: Server;
  private sockets?: WebSocketServer;
  private ownSocket?: SocketIdentity;
  private started = false;
  private stopped = false;
  private lifecycle = 0;
  private refreshTimer?: NodeJS.Timeout;
  private readonly peers = new Map<string, Peer>();
  private readonly local = new Map<string, NativeRuntimeSnapshot>();
  private readonly localRevision = new Map<string, number>();
  private readonly localTombstones = new Map<string, number>();
  /** This stays assigned until raw borrowed-SDK calls settle, even after a caller's deadline expires. */
  private localProbe?: Promise<NativeRuntimeSnapshot[]>;
  private peerRefresh?: Promise<boolean>;
  private closing?: Promise<void>;
  private serverClients = 0;

  constructor(private readonly options: NativeRuntimeStatusOptions) {
    const nativeHome = resolve(options.nativeHome);
    this.scope = validScope(options.scope) ? options.scope : hash(nativeHome); this.home = resolve(nativeRuntimeRoot(), hash(nativeHome));
    this.socketHome = runtimeSocketRoot(); this.socketPath = resolve(this.socketHome, `${this.scope}-${this.instance.slice(0, 12)}.sock`);
    this.registrationPath = resolve(this.home, `runtime-${this.instance}.json`);
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true; const epoch = this.lifecycle;
    try {
      await privateDirectory(this.home); if (!this.current(epoch)) return;
      await privateDirectory(this.socketHome); if (!this.current(epoch)) return;
      const server = createServer((_request, response) => { response.statusCode = 404; response.end(); });
      const sockets = new WebSocketServer({ noServer: true, maxPayload: frameLimit, perMessageDeflate: false });
      server.on("upgrade", (request, socket, head) => {
        if (request.url !== "/" || request.headers.origin || this.serverClients >= clientsLimit || !this.current(epoch)) { socket.destroy(); return; }
        sockets.handleUpgrade(request, socket, head, client => sockets.emit("connection", client));
      });
      sockets.on("connection", client => this.acceptClient(client));
      await listenPrivate(server, this.socketPath);
      const ownSocket = await socketIdentity(this.socketPath);
      this.server = server; this.sockets = sockets; this.ownSocket = ownSocket;
      if (!this.current(epoch)) { await this.closePublication(); return; }
      if (!this.ownSocket) throw new Error("Native runtime status socket was not created");
      const stamp = await ownerStamp(); if (!this.current(epoch)) { await this.closePublication(); return; }
      const registration: Registration = { protocol, version, pid: process.pid, ...stamp, scope: this.scope, socketPath: this.socketPath, socket: this.ownSocket, instance: this.instance };
      await writeFile(this.registrationPath, JSON.stringify(registration), { encoding: "utf8", mode: 0o600, flag: "wx" });
      if (!this.current(epoch)) await this.closePublication();
    } catch {
      try { this.options.reportError?.(new Error("Native runtime status publication is unavailable")); } catch { /* Optional reporting. */ }
      await this.closePublication();
    }
  }

  observe(message: Message): void {
    if (message.id !== undefined || message.method !== "thread/status/changed") return;
    const params = object(message.params); const id = params?.threadId; const status = validStatus(params?.status);
    if (!validId(id) || status === undefined) return;
    if (isNotLoaded(status)) this.deleteLocal(id); else this.setLocal(id, { ...(this.local.get(id) ?? { id }), status: cloneStatus(status) });
    const outgoing: Message = { method: "thread/status/changed", params: { threadId: id, status: cloneStatus(status) },
      ...(typeof message.emittedAtMs === "number" ? { emittedAtMs: message.emittedAtMs } : {}) };
    for (const client of this.sockets?.clients ?? []) this.sendClient(client, outgoing);
  }

  async hydrate(result: Message): Promise<Message> { await this.refreshPeers(); return this.overlay(result); }
  async loaded(_params: Message, nativeResult: Message): Promise<Message> { return this.hydrate(nativeResult); }
  async loadedIds(): Promise<string[] | undefined> {
    if (!await this.refreshPeers()) return;
    const ids = new Set<string>();
    for (const peer of this.peers.values()) if (peer.available && peer.connection && !peer.connection.closed) {
      for (const [id, snapshot] of peer.snapshots) if (!isNotLoaded(snapshot.status)) ids.add(id);
    }
    return [...ids];
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; this.lifecycle++; clearInterval(this.refreshTimer); this.refreshTimer = undefined;
    for (const peer of this.peers.values()) this.invalidatePeer(peer);
    this.peers.clear();
    await this.closePublication();
  }

  private current(epoch: number): boolean { return !this.stopped && epoch === this.lifecycle; }
  private async closeServer(server?: Server, sockets?: WebSocketServer): Promise<void> {
    if (sockets) for (const client of sockets.clients) client.terminate();
    if (sockets) await new Promise<void>(done => sockets.close(() => done()));
    if (server?.listening) await new Promise<void>(done => server.close(() => done()));
  }
  private async closePublication(): Promise<void> {
    if (this.closing) await this.closing;
    const closing = (async () => {
      const ownRecord = await this.readRegistration(this.registrationPath).catch(() => undefined);
      const server = this.server; const sockets = this.sockets; this.server = undefined; this.sockets = undefined;
      await this.closeServer(server, sockets);
      const expected = this.ownSocket; this.ownSocket = undefined;
      if (expected && sameSocket(expected, (await socketIdentity(this.socketPath).catch(() => undefined)) ?? { inode: "", device: "" })) await unlink(this.socketPath).catch(() => {});
      if (ownRecord?.instance === this.instance) await unlink(this.registrationPath).catch(() => {});
    })();
    this.closing = closing;
    try { await closing; } finally { if (this.closing === closing) this.closing = undefined; }
  }

  private sendClient(client: WebSocket, message: Message): void {
    if (client.readyState !== client.OPEN) return;
    let frame: string; try { frame = JSON.stringify(message); } catch { client.close(1011); return; }
    const bytes = Buffer.byteLength(frame);
    if (bytes > frameLimit || client.bufferedAmount + bytes > frameLimit) { client.close(1013); return; }
    try { client.send(frame); } catch { client.close(1011); }
  }
  private acceptClient(client: WebSocket): void {
    this.serverClients++; let pending = 0; const ids = new Set<string | number>();
    client.once("close", () => { this.serverClients--; }); client.on("error", () => {});
    client.on("message", (bytes, binary) => {
      const buffer = Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      if (binary || buffer.length > frameLimit || pending >= pendingLimit) { client.close(1013); return; }
      let message: Message | undefined; try { message = object(JSON.parse(buffer.toString("utf8"))); } catch { client.close(1008); return; }
      const id = message?.id; const method = message?.method;
      if (!message || (typeof id !== "string" && typeof id !== "number") || ids.has(id) || (method !== "runtime/list" && method !== "runtime/read")) { client.close(1008); return; }
      ids.add(id); pending++; const params = object(message.params) ?? {};
      void this.runtimeRequest(method, params).then(result => this.sendClient(client, { id, result }), () => this.sendClient(client, { id, error: { code: -32001, message: "Native runtime status is unavailable" } }))
        .finally(() => { ids.delete(id); pending--; });
    });
  }
  private async runtimeRequest(method: string, params: Message): Promise<Message> {
    if (method === "runtime/read") {
      const id = params.threadId; if (!validId(id)) throw new Error("Unknown runtime thread");
      const snapshot = (await this.probe()).find(item => item.id === id); if (!snapshot) throw new Error("Unknown runtime thread");
      return { thread: this.publicSnapshot(snapshot) };
    }
    if (params.page !== undefined && params.page !== 0) throw new Error("Invalid runtime page");
    const data = (await this.probe()).map(snapshot => this.publicSnapshot(snapshot));
    const result = { data, nextCursor: null };
    if (Buffer.byteLength(JSON.stringify(result)) > frameLimit) throw new Error("Native runtime snapshot exceeds frame limit");
    return result;
  }
  private publicSnapshot(snapshot: NativeRuntimeSnapshot): Message {
    return { id: snapshot.id, ...(snapshot.status !== undefined ? { status: cloneStatus(snapshot.status) } : {}), ...(snapshot.model !== undefined ? { model: snapshot.model } : {}),
      ...(snapshot.reasoningEffort !== undefined ? { reasoningEffort: snapshot.reasoningEffort } : {}), ...(snapshot.canAcceptDirectInput !== undefined ? { canAcceptDirectInput: snapshot.canAcceptDirectInput } : {}) };
  }

  private probe(): Promise<NativeRuntimeSnapshot[]> {
    if (!this.localProbe) this.localProbe = this.probeNow().finally(() => { this.localProbe = undefined; });
    return timeout(this.localProbe, probeDeadlineMs, "Native runtime snapshot timed out");
  }
  private async requestBeforeDeadline(method: string, params: Message, deadline: number): Promise<Message> {
    if (remaining(deadline) <= 0) throw new Error("Native runtime snapshot timed out");
    const result = await this.options.readOnlyNativeRequest(method, params);
    if (remaining(deadline) <= 0) throw new Error("Native runtime snapshot timed out");
    return result;
  }
  private async probeNow(): Promise<NativeRuntimeSnapshot[]> {
    const deadline = Date.now() + probeDeadlineMs; const ids: string[] = []; const seenIds = new Set<string>(); const seenCursors = new Set<string>();
    let cursor: string | null | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await this.requestBeforeDeadline("thread/loaded/list", { limit: pageLimit, ...(cursor ? { cursor } : {}) }, deadline);
      const data = Array.isArray(result.data) ? result.data : undefined;
      if (!data || data.length > pageLimit) throw new Error("Native runtime list is invalid");
      for (const item of data) {
        const row = object(item); const id = typeof item === "string" ? item : row?.id ?? row?.threadId;
        if (!validId(id)) throw new Error("Native runtime list is invalid");
        if (!seenIds.has(id)) { if (ids.length >= snapshotLimit) throw new Error("Native runtime snapshot exceeds 512 threads"); seenIds.add(id); ids.push(id); }
      }
      const next = result.nextCursor;
      if (next === null || next === undefined) { cursor = undefined; break; }
      if (typeof next !== "string" || !next || seenCursors.has(next)) throw new Error("Native runtime list cursor is invalid");
      seenCursors.add(next); cursor = next;
    }
    if (cursor !== undefined) throw new Error("Native runtime list did not complete");
    const snapshots = await this.mapLimit(ids, nativeReadLimit, deadline, async id => {
      const revision = this.localRevision.get(id) ?? 0;
      const result = await this.requestBeforeDeadline("thread/read", { threadId: id, includeTurns: false }, deadline);
      const thread = object(result.thread) ?? result;
      if (!validId(thread.id) || thread.id !== id) throw new Error("Native runtime thread is invalid");
      const snapshot = this.snapshotFrom({ id, status: thread.status, ...(has(thread, "model") ? { model: thread.model } : {}),
        ...(has(thread, "reasoningEffort") ? { reasoningEffort: thread.reasoningEffort } : {}), ...(has(thread, "canAcceptDirectInput") ? { canAcceptDirectInput: thread.canAcceptDirectInput } : {}) });
      if (!snapshot) throw new Error("Native runtime thread is invalid");
      const current = this.local.get(id);
      if ((this.localRevision.get(id) ?? 0) !== revision) {
        if (current) return { ...snapshot, ...current, status: cloneStatus(current.status) };
        if (this.localTombstones.get(id) === (this.localRevision.get(id) ?? 0)) return { id, status: { type: "notLoaded" as const } };
      }
      if (isNotLoaded(snapshot.status)) { this.deleteLocal(id); return snapshot; }
      this.setLocal(id, snapshot); return snapshot;
    });
    return snapshots;
  }
  private async mapLimit<T, R>(values: T[], limit: number, deadline: number, fn: (value: T) => Promise<R>): Promise<R[]> {
    const output: R[] = []; let next = 0; let failure: unknown;
    const worker = async () => { while (!failure && next < values.length && remaining(deadline) > 0) {
      const index = next++; try { output[index] = await fn(values[index]!); } catch (error) { failure ??= error; }
    } };
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
    if (failure) throw failure;
    if (next !== values.length) throw new Error("Native runtime snapshot timed out");
    return output;
  }

  private refreshPeers(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    if (!this.peerRefresh) this.peerRefresh = this.refreshPeersNow().finally(() => { this.peerRefresh = undefined; });
    return timeout(this.peerRefresh, listDeadlineMs, "Native runtime peer refresh timed out").catch(() => false);
  }
  private async refreshPeersNow(): Promise<boolean> {
    if (this.stopped) return false;
    const epoch = this.lifecycle; const deadline = Date.now() + listDeadlineMs;
    this.refreshTimer ??= setInterval(() => { void this.refreshPeers(); }, refreshMs).unref();
    const discovery = await this.discoverPeers(deadline).catch((): PeerDiscovery => ({ registrations: [], complete: false })); if (!this.current(epoch)) return false;
    const allowed = new Set(discovery.registrations.map(record => record.instance));
    for (const [key, peer] of this.peers) if (!allowed.has(key)) { this.invalidatePeer(peer); this.peers.delete(key); }
    for (const registration of discovery.registrations) if (!this.peers.has(registration.instance) && this.current(epoch)) this.peers.set(registration.instance, { registration, snapshots: new Map(), events: new Map(), revision: 0, available: false });
    await this.mapLimit([...this.peers.values()], nativeReadLimit, deadline, async peer => { await this.readPeer(peer, epoch, deadline); });
    if (!this.current(epoch)) return false;
    return discovery.complete && discovery.registrations.every(registration => {
      const peer = this.peers.get(registration.instance);
      return peer?.available && !!peer.connection && !peer.connection.closed;
    });
  }
  private async discoverPeers(deadline: number): Promise<PeerDiscovery> {
    if (remaining(deadline) <= 0) throw new Error("Native runtime peer refresh timed out");
    let directory;
    try { directory = await opendir(this.home); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { registrations: [], complete: true };
      throw error;
    }
    const result: Registration[] = []; let inspected = 0;
    try {
      for await (const entry of directory) {
        if (remaining(deadline) <= 0) throw new Error("Native runtime peer refresh timed out");
        if (inspected++ >= registryInspectLimit) return { registrations: result, complete: false };
        if (!entry.isFile() || !/^runtime-[a-f0-9]{24}\.json$/.test(entry.name)) continue;
        const path = resolve(this.home, entry.name);
        const record = await this.readRegistration(path);
        if (record && record.instance !== this.instance && record.scope === this.scope) {
          if (result.length >= peersLimit) return { registrations: result, complete: false };
          result.push(record);
        }
        else if (!record) await this.removeDeadRegistration(path, deadline);
      }
      return { registrations: result, complete: true };
    } finally { await directory.close().catch(() => {}); }
  }
  private async readRegistration(path: string): Promise<Registration | undefined> {
    if (!pathInside(this.home, path) || !/^runtime-[a-f0-9]{24}\.json$/.test(basename(path))) return;
    let file; try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0));
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > registrationLimit) return;
      const value: unknown = JSON.parse(await file.readFile("utf8")); const record = object(value); const socket = object(record?.socket); const pid = record?.pid;
      if (!record || record.protocol !== protocol || record.version !== version || !Number.isSafeInteger(pid) || (pid as number) < 1 || !validScope(record.scope) ||
        typeof record.socketPath !== "string" || !pathInside(this.socketHome, record.socketPath) || !/^[a-f0-9]{24}$/.test(String(record.instance)) || !socket || typeof socket.inode !== "string" || typeof socket.device !== "string") return;
      const registration = record as unknown as Registration;
      if (basename(path) !== `runtime-${registration.instance}.json` || basename(registration.socketPath) !== `${registration.scope}-${registration.instance.slice(0, 12)}.sock`) return;
      const alive = registration.pid === process.pid ? await this.ownRegistrationAlive(registration) : await receiptPidAlive(registration, info.mtimeMs);
      if (!alive) return;
      const actual = await socketIdentity(registration.socketPath).catch(() => undefined); if (!actual || !sameSocket(registration.socket, actual)) return;
      return registration;
    } catch { return; } finally { await file?.close(); }
  }
  /** Only discard an old receipt when its complete, private identity and dead socket can both be proved. */
  private async removeDeadRegistration(path: string, deadline: number): Promise<void> {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0));
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > registrationLimit) return;
      const record = object(JSON.parse(await file.readFile("utf8"))); const socket = object(record?.socket);
      if (!record || record.protocol !== protocol || record.version !== version || !Number.isSafeInteger(record.pid) || (record.pid as number) < 1 || !validScope(record.scope) ||
        typeof record.socketPath !== "string" || !pathInside(this.socketHome, record.socketPath) || !/^[a-f0-9]{24}$/.test(String(record.instance)) || !socket || typeof socket.inode !== "string" || typeof socket.device !== "string") return;
      const registration = record as unknown as Registration;
      if (registration.scope !== this.scope || basename(path) !== `runtime-${registration.instance}.json` || basename(registration.socketPath) !== `${registration.scope}-${registration.instance.slice(0, 12)}.sock`) return;
      const alive = registration.pid === process.pid ? await this.ownRegistrationAlive(registration) : await receiptPidAlive(registration, info.mtimeMs);
      if (alive || await timeout(socketAnswers(registration.socketPath), Math.max(1, remaining(deadline)), "Native runtime receipt probe timed out").catch(() => true)) return;
      const actual = await socketIdentity(registration.socketPath).catch(() => undefined);
      if (actual && !sameSocket(registration.socket, actual)) return;
      const current = await socketIdentity(registration.socketPath).catch(() => undefined);
      if (current && sameSocket(registration.socket, current)) await unlink(registration.socketPath).catch(() => {});
      await unlink(path).catch(() => {});
    } catch { /* A malformed or changing receipt stays untouched. */ } finally { await file?.close(); }
  }
  private async ownRegistrationAlive(record: Registration): Promise<boolean> {
    const stamp = await ownerStamp();
    return (record.bootId === undefined || stamp.bootId === record.bootId) && (record.startedAtMs === undefined || stamp.startedAtMs === record.startedAtMs);
  }
  private invalidatePeer(peer: Peer): void { peer.available = false; peer.snapshots.clear(); peer.connection?.stop(); peer.connection = undefined; }
  private async readPeer(peer: Peer, epoch: number, deadline: number): Promise<void> {
    if (peer.reading || !this.current(epoch) || !(await this.peerStillValid(peer))) { if (!this.current(epoch)) this.invalidatePeer(peer); return; }
    peer.reading = (async () => {
      if (!peer.connection || peer.connection.closed) {
        const connection = new SocketAppServerConnection(peer.registration.socketPath, async message => this.receivePeer(peer, message), closed => {
          if (peer.connection === closed) this.invalidatePeer(peer);
        });
        peer.connection = connection; await timeout(connection.ready, Math.max(1, remaining(deadline)), "Native runtime peer is unavailable");
      }
      if (!this.current(epoch) || remaining(deadline) <= 0 || !peer.connection) return;
      const revision = peer.revision;
      const connection = peer.connection; if (!connection || connection.closed || !this.current(epoch) || remaining(deadline) <= 0) return;
      const result = await timeout(connection.request("runtime/list", {}), Math.max(1, remaining(deadline)), "Native runtime peer read timed out");
      const rows = Array.isArray(result.data) ? result.data : undefined;
      if (!rows || rows.length > snapshotLimit || result.nextCursor !== null) throw new Error("Native runtime peer snapshot is invalid");
      if (!this.current(epoch) || !(await this.peerStillValid(peer))) return;
      const snapshots = new Map<string, NativeRuntimeSnapshot>();
      for (const row of rows) { const snapshot = this.snapshotFrom(row); if (!snapshot || snapshots.has(snapshot.id)) throw new Error("Native runtime peer snapshot is invalid"); snapshots.set(snapshot.id, snapshot); }
      for (const [id, event] of this.peerEvents(peer)) if (event.revision > revision) {
        if (isNotLoaded(event.status)) snapshots.delete(id);
        else snapshots.set(id, { ...(snapshots.get(id) ?? { id }), status: cloneStatus(event.status) });
      }
      peer.snapshots = snapshots; peer.available = true;
    })().catch(() => this.invalidatePeer(peer)).finally(() => { peer.reading = undefined; });
    await peer.reading;
  }
  private async peerStillValid(peer: Peer): Promise<boolean> {
    const record = await this.readRegistration(resolve(this.home, `runtime-${peer.registration.instance}.json`));
    const valid = !!record && record.instance === peer.registration.instance && sameSocket(record.socket, peer.registration.socket);
    if (!valid) this.invalidatePeer(peer);
    return valid;
  }
  private peerEvents(peer: Peer): Map<string, PeerEvent> { return peer.events ??= new Map(); }
  private recordPeerEvent(peer: Peer, id: string, status: RuntimeStatus): void {
    const events = this.peerEvents(peer);
    if (!events.has(id) && events.size >= snapshotLimit) events.delete(events.keys().next().value!);
    events.set(id, { revision: peer.revision, status: cloneStatus(status)! });
  }
  private snapshotFrom(value: unknown): NativeRuntimeSnapshot | undefined {
    const row = object(value); if (!row || !validId(row.id)) return;
    const status = validStatus(row.status); if (has(row, "status") && status === undefined) return;
    const model = has(row, "model") ? boundedText(row.model) : undefined; const reasoningEffort = has(row, "reasoningEffort") ? boundedText(row.reasoningEffort) : undefined;
    const canAcceptDirectInput = has(row, "canAcceptDirectInput") ? (typeof row.canAcceptDirectInput === "boolean" || row.canAcceptDirectInput === null ? row.canAcceptDirectInput : undefined) : undefined;
    if (has(row, "model") && model === undefined || has(row, "reasoningEffort") && reasoningEffort === undefined || has(row, "canAcceptDirectInput") && canAcceptDirectInput === undefined) return;
    return { id: row.id, ...(status !== undefined ? { status: cloneStatus(status) } : {}), ...(model !== undefined ? { model } : {}), ...(reasoningEffort !== undefined ? { reasoningEffort } : {}), ...(canAcceptDirectInput !== undefined ? { canAcceptDirectInput } : {}) };
  }
  private async receivePeer(peer: Peer, message: Message): Promise<void> {
    if (message.id !== undefined || !peer.connection || peer.connection.closed || message.method !== "thread/status/changed") return;
    const params = object(message.params); const id = params?.threadId; const status = validStatus(params?.status); if (!validId(id) || status === undefined) return;
    peer.revision++; this.recordPeerEvent(peer, id, status);
    if (isNotLoaded(status)) peer.snapshots.delete(id);
    else if (peer.snapshots.has(id) || peer.snapshots.size < snapshotLimit) peer.snapshots.set(id, { ...(peer.snapshots.get(id) ?? { id }), status: cloneStatus(status) });
    await Promise.resolve(this.options.emitStatus({ method: "thread/status/changed", params: { threadId: id, status: cloneStatus(status) },
      ...(typeof message.emittedAtMs === "number" ? { emittedAtMs: message.emittedAtMs } : {}) }));
  }
  private overlay(result: Message): Message {
    const data = Array.isArray(result.data) ? result.data : undefined; if (!data) return result;
    let changed = false;
    const rows = data.map(value => {
      const row = object(value); if (!row || !validId(row.id) || !this.notLoaded(row)) return value;
      let snapshot: NativeRuntimeSnapshot | undefined;
      for (const peer of this.peers.values()) if (peer.available && peer.connection && !peer.connection.closed) { const candidate = peer.snapshots.get(row.id); if (candidate && !isNotLoaded(candidate.status)) { snapshot = candidate; break; } }
      if (!snapshot) return value;
      changed = true; return { ...row, ...(snapshot.status !== undefined ? { status: cloneStatus(snapshot.status) } : {}), ...(snapshot.model !== undefined ? { model: snapshot.model } : {}),
        ...(snapshot.reasoningEffort !== undefined ? { reasoningEffort: snapshot.reasoningEffort } : {}), ...(snapshot.canAcceptDirectInput !== undefined ? { canAcceptDirectInput: snapshot.canAcceptDirectInput } : {}) };
    });
    return changed ? { ...result, data: rows } : result;
  }
  private notLoaded(row: Message): boolean { return isNotLoaded(validStatus(row.status)); }
  private setLocal(id: string, snapshot: NativeRuntimeSnapshot): void {
    if (!this.local.has(id) && this.local.size >= snapshotLimit) { const oldest = this.local.keys().next().value; if (oldest) { this.local.delete(oldest); this.localRevision.delete(oldest); } }
    this.local.set(id, snapshot); this.localRevision.set(id, (this.localRevision.get(id) ?? 0) + 1); this.localTombstones.delete(id);
  }
  private deleteLocal(id: string): void {
    this.local.delete(id); const revision = (this.localRevision.get(id) ?? 0) + 1; this.localRevision.set(id, revision); this.localTombstones.set(id, revision);
    if (this.localRevision.size > snapshotLimit) { const oldest = this.localRevision.keys().next().value; if (oldest) { this.localRevision.delete(oldest); this.localTombstones.delete(oldest); } }
  }
}
