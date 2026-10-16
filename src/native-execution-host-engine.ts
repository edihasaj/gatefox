import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { object, type Message } from "./app-server-connection.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";
import { privateDirectory, removeOwnedSocket, sameSocketIdentity, sdkIdentity, sdkSocketTarget, socketIdentity, type EngineOwner, type HostIdentity, type NativeDeath } from "./execution-host-storage.js";
import { spawnStamp } from "./boot-identity.js";

export interface NativeExecutionDescriptor { args: string[]; cwd: string }
export interface NativeExecutionRecord { kind: "native"; revision: string; socketPath: string; pid: number; instanceId: string }

export function nativeDescriptor(value: unknown): NativeExecutionDescriptor {
  const input = object(value);
  if (!Array.isArray(input.args) || input.args.length > 256
    || !Array.from(input.args).every(arg => typeof arg === "string" && !arg.includes("\0") && Buffer.byteLength(arg) < 65536)
    || !input.args.includes("app-server") || input.args.includes("proxy")
    || typeof input.cwd !== "string" || !isAbsolute(input.cwd) || input.cwd.includes("\0") || Buffer.byteLength(input.cwd) >= 65536) {
    throw new Error("Invalid native execution descriptor");
  }
  const descriptor = { args: [...input.args], cwd: input.cwd } as NativeExecutionDescriptor;
  if (Buffer.byteLength(JSON.stringify(input)) > 4 * 1024 * 1024) throw new Error("Native execution descriptor exceeds 4 MiB");
  return descriptor;
}

function nativeTransportArgs(args: string[]): string[] {
  const forwarded: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--listen") { index++; continue; }
    if (arg.startsWith("--listen=") || arg === "--stdio") continue;
    forwarded.push(arg);
  }
  return forwarded;
}

export function nativeDescriptorFingerprint(descriptor: NativeExecutionDescriptor): string {
  // The desktop supplies an analytics default; the relay does not. It is not a
  // session setting, and explicit analytics configuration still takes priority.
  // Ignore only this default for compatibility; preserve the first launch argv.
  const args = nativeTransportArgs(descriptor.args).filter(arg => arg !== "--analytics-default-enabled");
  return createHash("sha256").update(JSON.stringify({ args, cwd: descriptor.cwd })).digest("hex");
}

const providerSetting = "model_providers.subscription_gateway.";
const valueFlags = ["-c", "--config", "--enable", "--disable"];

/** Splits launch args into the gateway provider registration and the client's own settings. */
export function nativeLaunchSettings(args: string[]): { provider: string[]; client: string[] } {
  const forwarded = nativeTransportArgs(args).filter(arg => arg !== "--analytics-default-enabled");
  const command = forwarded.indexOf("app-server"); if (command >= 0) forwarded.splice(command, 1);
  const provider: string[] = []; const client: string[] = [];
  for (let index = 0; index < forwarded.length; index++) {
    const arg = forwarded[index]!;
    if (!valueFlags.includes(arg) || index + 1 >= forwarded.length) { client.push(arg); continue; }
    const value = forwarded[++index]!;
    (["-c", "--config"].includes(arg) && value.startsWith(providerSetting) ? provider : client).push(`${arg} ${value}`);
  }
  return { provider, client };
}

function settingMap(client: string[]): { settings: Map<string, string>; other: string[] } | undefined {
  const settings = new Map<string, string>(); const other: string[] = [];
  for (const token of client) {
    const space = token.indexOf(" "); const flag = token.slice(0, space); const value = token.slice(space + 1);
    if (space < 0 || !valueFlags.includes(flag)) { other.push(token); continue; }
    const equals = value.indexOf("=");
    const [key, setting] = ["-c", "--config"].includes(flag) ? (equals > 0 ? [`config:${value.slice(0, equals).trim()}`, value.slice(equals + 1).trim()] : [`config:${value}`, ""]) : [`feature:${value}`, flag];
    if (settings.has(key) && settings.get(key) !== setting) return;
    settings.set(key, setting);
  }
  return { settings, other };
}

/**
 * Compares two launches of the same native home. Clients add settings
 * (relay: none, SSH: Code Mode, desktop: Code Mode plus bundled plugins), so a
 * request that only adds keys can enrich the writer. Changing a value, a
 * profile, or any non-setting flag is a conflict.
 */
export function compareNativeLaunch(running: NativeExecutionDescriptor, requested: NativeExecutionDescriptor): "same" | "subset" | "superset" | "conflict" {
  if (nativeDescriptorFingerprint(running) === nativeDescriptorFingerprint(requested)) return "same";
  const a = nativeLaunchSettings(running.args); const b = nativeLaunchSettings(requested.args);
  if (running.cwd !== requested.cwd || JSON.stringify(a.provider) !== JSON.stringify(b.provider)) return "conflict";
  const has = settingMap(a.client); const wants = settingMap(b.client);
  if (!has || !wants || JSON.stringify(has.other) !== JSON.stringify(wants.other)) return "conflict";
  for (const [key, value] of wants.settings) if (has.settings.has(key) && has.settings.get(key) !== value) return "conflict";
  if ([...wants.settings.keys()].every(key => has.settings.has(key))) return "subset";
  if ([...has.settings.keys()].every(key => wants.settings.has(key))) return "superset";
  return "conflict";
}

export function nativeExecutionArgs(args: string[], socket: string, managedRelay: boolean): string[] {
  if (managedRelay && args.some(arg => arg === "--remote-control" || arg.startsWith("--remote-control="))) throw new Error("Native execution remote-control flag conflicts with managed relay ownership");
  return [...nativeTransportArgs(args), "--listen", `unix://${socket}`];
}
export function nativeExecutionEnvironment(nativeHome: string, managedRelay: boolean): NodeJS.ProcessEnv {
  return { ...process.env, CODEX_HOME: nativeHome, ...(managedRelay ? { CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1" } : {}) };
}

/** The host owns this native-home writer; frontend connection lifetimes do not. */
export class NativeExecutionEngine {
  private child?: ChildProcess;
  private readonly admins = new Set<SocketAppServerConnection>();
  private socketCapture?: Promise<boolean>;
  private exited: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;
  private stopDone?: Promise<void>;
  readonly descriptor: NativeExecutionDescriptor;
  readonly record: NativeExecutionRecord;
  readonly owner: EngineOwner;
  readonly fingerprint: string;
  closed = false;
  death?: NativeDeath;

  constructor(descriptor: NativeExecutionDescriptor, private readonly identity: HostIdentity, hostHome: string, private readonly managedRelay: boolean) {
    this.descriptor = nativeDescriptor(descriptor);
    Object.freeze(this.descriptor.args); Object.freeze(this.descriptor);
    this.fingerprint = nativeDescriptorFingerprint(this.descriptor);
    this.record = { kind: "native", revision: this.fingerprint, socketPath: resolve(hostHome, "native.sock"), pid: 0, instanceId: randomUUID() };
    nativeExecutionArgs(this.descriptor.args, this.record.socketPath, managedRelay);
    this.owner = { revision: this.record.revision, socketPath: this.record.socketPath, pid: 0 };
  }

  async start(changed: () => Promise<void>): Promise<void> {
    if (this.started || this.stopped) throw new Error("Native execution engine cannot start again");
    this.started = true;
    await privateDirectory(dirname(this.record.socketPath));
    const sdk = await sdkIdentity(this.identity.codex);
    if (sdk.sdkSha256 !== this.identity.sdkSha256) throw new Error("Execution host SDK changed; restart during a maintenance window");
    if (this.identity.nativeSdkExecutable && (await sdkIdentity(this.identity.nativeSdkExecutable)).sdkSha256 !== this.identity.nativeSdkSha256) throw new Error("Native execution SDK changed; restart during a maintenance window");
    if (this.stopped) throw new Error("Execution host is closing");
    // Preserve both an advertised listener and any unrecorded physical SDK socket.
    for (const path of [this.record.socketPath, await sdkSocketTarget(this.record.socketPath)]) {
      const occupied = await lstat(path).catch(error => { if (error.code === "ENOENT") return; throw error; });
      if (occupied) throw new Error("Native execution socket is occupied; its listener was preserved");
    }
    if (this.stopped) throw new Error("Execution host is closing");
    const child = spawn(this.identity.nativeSdkExecutable ?? this.identity.codex, nativeExecutionArgs(this.descriptor.args, this.record.socketPath, this.managedRelay), {
      cwd: this.descriptor.cwd, env: nativeExecutionEnvironment(this.identity.nativeHome, this.managedRelay), stdio: "ignore", detached: false,
    });
    this.child = child;
    this.exited = new Promise(resolve => {
      // A failed spawn also emits close. Kill failures are not proof of process death.
      child.on("error", () => {});
      child.once("close", () => {
        if (child.pid) this.death = { revision: this.record.revision, pid: child.pid, instanceId: this.record.instanceId, exitedAtMs: Date.now(), intentional: this.stopped };
        this.closed = true; this.owner.pid = 0; this.record.pid = 0;
        for (const admin of this.admins) admin.stop();
        void changed().catch(() => {}); resolve();
      });
    });
    this.owner.pid = child.pid || 0; this.record.pid = this.owner.pid;
    if (child.pid) Object.assign(this.owner, await spawnStamp(child.pid));
    await changed();
    const deadline = Date.now() + 10000;
    for (;;) {
      if (this.closed || this.stopped) throw new Error("Native execution SDK exited before initialization");
      this.socketCapture = this.captureSocket();
      let captured: boolean;
      try { captured = await this.socketCapture; } finally { this.socketCapture = undefined; }
      if (this.closed || this.stopped) throw new Error("Native execution SDK exited before initialization");
      if (captured) { await changed(); break; }
      if (Date.now() >= deadline) throw new Error("Native execution socket startup timed out");
      await delay(25);
    }
    await this.withAdmin(async () => {});
  }

  private async captureSocket(): Promise<boolean> {
    const info = await lstat(this.record.socketPath).catch(error => { if (error.code === "ENOENT") return; throw error; });
    if (!info) return false;
    // SDK rendezvous links are validated without mutation; only owned sockets are chmodded.
    if (info.isSocket() && info.uid === process.getuid?.()) await chmod(this.record.socketPath, 0o600);
    const socket = await socketIdentity(this.record.socketPath);
    if (!socket) throw new Error("Native execution socket disappeared during startup");
    this.owner.socket = socket; return true;
  }

  async loadedThreads(): Promise<Set<string>> {
    if (this.closed) return new Set();
    return this.withAdmin(async admin => {
      const threads = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
      for (let page = 0; page < 128; page++) {
        const result = await admin.request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result.data) || result.data.length > 100
          || result.data.some(id => typeof id !== "string" || !id || id.includes("\0") || Buffer.byteLength(id) >= 65536)) {
          throw new Error("Native execution SDK returned invalid loaded-chat metadata");
        }
        for (const id of result.data) threads.add(id as string);
        if (result.nextCursor == null) return threads;
        if (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor.includes("\0")
          || Buffer.byteLength(result.nextCursor) >= 65536 || cursors.has(result.nextCursor)) {
          throw new Error("Native execution SDK returned invalid loaded-chat pagination");
        }
        cursor = result.nextCursor; cursors.add(cursor);
      }
      throw new Error("Native execution SDK loaded-chat pagination exceeded its bound");
    });
  }

  /** Loaded chats whose SDK status is not proven idle; replacement waits for zero. */
  async busyThreads(): Promise<number> {
    const threads = await this.loadedThreads();
    if (!threads.size) return 0;
    return this.withAdmin(async admin => {
      let busy = 0;
      for (const threadId of threads) {
        const status = object(object((await admin.request("thread/read", { threadId, includeTurns: false })).thread).status).type;
        if (!["idle", "notLoaded", "systemError"].includes(String(status))) busy++;
      }
      return busy;
    });
  }

  private async withAdmin<T>(probe: (admin: SocketAppServerConnection) => Promise<T>): Promise<T> {
    if (!this.child || this.closed || this.stopped) throw new Error("Native execution administration is unavailable; loaded chats were preserved");
    const socket = await socketIdentity(this.record.socketPath);
    if (!socket || !this.owner.socket || !sameSocketIdentity(socket, this.owner.socket)) throw new Error("Native execution socket ownership changed; its listener was preserved");
    if (this.closed || this.stopped) throw new Error("Native execution administration is unavailable; loaded chats were preserved");
    if (this.admins.size >= 8) throw new Error("Native execution administration connection limit reached");
    // Initializing a persistent SDK client auto-subscribes it to new threads.
    // Each probe is transient and ignores server requests: the real frontend owns replies.
    const admin = new SocketAppServerConnection(this.record.socketPath, async () => {}, connection => { this.admins.delete(connection); });
    this.admins.add(admin);
    try {
      await this.bounded(admin.ready);
      await this.bounded(admin.request("initialize", { clientInfo: { name: "codex_app_server_daemon", version: "1" }, capabilities: { experimentalApi: true } }));
      admin.send({ method: "initialized", params: {} });
      return await this.bounded(probe(admin));
    } finally {
      admin.stop();
      // Bound our retiring sockets through local transport closure. SDK-side
      // subscription cleanup can finish after that local close notification.
      await this.bounded(admin.exited);
    }
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Native execution administration timed out")), 10000).unref();
      })]);
    } finally { clearTimeout(timer); }
  }

  stop(): Promise<void> { return this.stopDone ||= this.stopOwned(); }
  private async stopOwned(): Promise<void> {
    this.stopped = true;
    for (const admin of this.admins) admin.stop();
    // Finish an in-flight identity capture while the SDK is still alive. Waiting
    // for all of start() here would deadlock its caller's failed-start cleanup.
    await this.socketCapture?.catch(() => {});
    this.child?.kill("SIGTERM");
    await Promise.race([this.exited, delay(1500)]);
    if (!this.closed) this.child?.kill("SIGKILL");
    await Promise.race([this.exited, delay(1000)]);
    if (this.child && !this.closed) throw new Error("Native execution SDK did not stop; ownership was preserved");
    this.closed = true;
    if (this.owner.socket) await removeOwnedSocket(this.record.socketPath, this.owner.socket);
  }
}
