import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type GatewayConfig, writePrivateJson } from "./config.js";
import { object, type Message } from "./app-server-connection.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";
import { gatewayEngineHome, gatewayEnvironment } from "./gateway-engine-home.js";
import { archiveStaleReceipt, privateDirectory, removeOwnedSocket, sdkIdentity, socketIdentity, type HostIdentity, type EngineOwner } from "./execution-host-storage.js";
import { normalizeCodexFeatureArgs } from "./codex-feature-compat.js";
import { trimGatewayFeatureArgs, trimmedGatewayFeatures } from "./gateway-feature-schema.js";
import { gatewaySdkRuntime, type GatewaySdkRuntime } from "./gateway-sdk-runtime.js";
import { spawnStamp } from "./boot-identity.js";

export interface ExecutionDescriptor { revision: string; args: string[]; settings: Message; catalog: { models: Message[] }; aliases: string[]; gatewaySdkSha256?: string }
export interface ExecutionRecord { revision: string; socketPath: string; aliases: string[]; selectedModelCompaction?: true }
/**
 * The fixed text of a refused gateway SDK mismatch between an adapter and this host (two releases running side by side). The
 * host passes it through unchanged and the adapter shows it, so a user reads what is happening instead of a masked failure.
 */
export const releaseSkewMessage = "This Mac's gateway service is still moving to a newer release; retry in a moment";
/** A generation request whose gateway SDK is not the one this host runs; `adapterSha256` is the SDK the adapter named. */
export class ReleaseSkewError extends Error {
  constructor(readonly adapterSha256: string) { super(releaseSkewMessage); }
}
/** Whether an error is the host's release-skew refusal, as the adapter receives it over the control connection. */
export function isReleaseSkew(error: unknown): boolean {
  return error instanceof Error && error.message === releaseSkewMessage;
}
export function executionDescriptor(value: unknown): ExecutionDescriptor {
  const input = object(value); const catalog = object(input.catalog);
  if (typeof input.revision !== "string" || !/^[a-f0-9]{64}$/.test(input.revision) || !Array.isArray(input.args) || input.args.length > 256 || !input.args.every(arg => typeof arg === "string" && !arg.includes("\0") && Buffer.byteLength(arg) < 65536)
    || !input.args.includes("app-server") || input.args.includes("proxy") || !input.settings || Array.isArray(input.settings) || typeof input.settings !== "object"
    || !Array.isArray(catalog.models) || !catalog.models.length || catalog.models.length > 256 || catalog.models.some(model => !model || typeof model !== "object" || Array.isArray(model))
    || !Array.isArray(input.aliases) || !input.aliases.length || input.aliases.length > 256 || input.aliases.some(alias => typeof alias !== "string" || !alias || alias.length > 1024 || alias.includes("\0")) || new Set(input.aliases).size !== input.aliases.length
    || (input.gatewaySdkSha256 !== undefined && (typeof input.gatewaySdkSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.gatewaySdkSha256)))) throw new Error("Invalid execution generation descriptor");
  const descriptor = { revision: input.revision, args: input.args, settings: input.settings, catalog: { models: catalog.models }, aliases: input.aliases,
    ...(input.gatewaySdkSha256 ? { gatewaySdkSha256: input.gatewaySdkSha256 } : {}) } as ExecutionDescriptor;
  if (Buffer.byteLength(JSON.stringify(descriptor)) > 4 * 1024 * 1024) throw new Error("Execution descriptor exceeds 4 MiB");
  return descriptor;
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
}
export function descriptorFingerprint(descriptor: ExecutionDescriptor): string { return createHash("sha256").update(canonicalJson(descriptor)).digest("hex"); }
export function executionArgs(input: string[], socket: string, catalog: string, settings: Message = {}): string[] {
  // Older connected adapters can still supply legacy flags to a newer host.
  // The SDK started here is the pinned gateway SDK, which rejects feature tables newer than itself.
  const args = trimmedGatewayFeatures("spawn", stats => trimGatewayFeatureArgs(normalizeCodexFeatureArgs(input, settings), stats));
  const forwarded: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--listen") { index++; continue; }
    if (arg.startsWith("--listen=")) continue;
    if (["-c", "--config"].includes(arg) && args[index + 1]?.startsWith("model_catalog_json=")) { index++; continue; }
    if (arg.startsWith("--config=model_catalog_json=")) continue;
    forwarded.push(arg);
  }
  return [...forwarded, "--listen", `unix://${socket}`, "-c", `model_catalog_json=${JSON.stringify(catalog)}`];
}
/**
 * How long `codex --version` may take. macOS assesses a newly written executable the first time it runs: the pinned 335 MB
 * gateway SDK of a just-installed release took 2.9 s on an M5 Pro before printing anything, and 0.01 s from the second run on.
 * The service's first host start after an install is that first run; on a slower or busier Mac it can outlive a 5 s limit,
 * fail as `sdk_invalid` and pass on the retry a second later. The limit only bounds a binary that hangs.
 */
export const sdkVersionTimeoutMs = 15_000;
/** The gateway SDK every gateway generation runs. The app engines verified for native sharing are in native-engine-versions.ts. */
export const gatewayEngineVersions: readonly string[] = ["0.162.0-alpha.17.2"];
export async function validateExecutionSdk(codex: string, accepted: readonly string[] = gatewayEngineVersions): Promise<void> {
  const child = spawn(codex, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  let output = ""; child.stdout.on("data", chunk => { output += String(chunk); if (output.length > 4096) child.kill("SIGTERM"); });
  const timer = setTimeout(() => child.kill("SIGKILL"), sdkVersionTimeoutMs).unref();
  try {
    await new Promise<void>((resolve, reject) => { child.once("error", () => reject(new Error("Execution host SDK is unavailable"))); child.once("close", code => code === 0 ? resolve() : reject(new Error("Execution host SDK version check failed"))); });
    if (!accepted.some(version => output.trim() === `codex-cli ${version}`)) throw new Error("Execution host requires the pinned Codex SDK version");
  } finally { clearTimeout(timer); }
}

/** A JSON object read from a file, or undefined when the file does not hold one. */
async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error instanceof SyntaxError) return; throw error; }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class ExecutionEngine {
  private child?: ChildProcess;
  private admin?: SocketAppServerConnection;
  private adminProbe?: Promise<Set<string>>;
  private exited: Promise<void> = Promise.resolve();
  private stopped = false;
  private stopDone?: Promise<void>;
  readonly record: ExecutionRecord;
  readonly owner: EngineOwner;
  readonly fingerprint: string;
  closed = false;
  /**
   * `codexValidated` says whether the host pinned the app's codex at start. A host that pinned its runtime instead never
   * checked that binary, so it must not spawn it for a descriptor that names no runtime.
   */
  constructor(readonly descriptor: ExecutionDescriptor, private identity: HostIdentity, hostHome: string, private readonly resolveRuntime: () => Promise<GatewaySdkRuntime | undefined> = gatewaySdkRuntime,
    private readonly codexValidated = true) {
    this.record = { revision: descriptor.revision, socketPath: resolve(hostHome, `e-${descriptor.revision.slice(0, 16)}.sock`), aliases: [...descriptor.aliases] };
    this.owner = { revision: descriptor.revision, socketPath: this.record.socketPath, pid: 0 };
    this.fingerprint = descriptorFingerprint(descriptor);
  }
  async start(config: GatewayConfig, changed: () => Promise<void>): Promise<void> {
    const descriptor = this.descriptor; const directory = resolve(config.stateDirectory, "desktop-generations", `shared-v1-${descriptor.revision}`);
    const runtime = descriptor.gatewaySdkSha256 ? await this.resolveRuntime() : undefined;
    if (descriptor.gatewaySdkSha256 && runtime?.binarySha256 !== descriptor.gatewaySdkSha256) {
      // Another release's SDK is the release skew of a service and an adapter that moved at different times (see docs/services.md).
      // A host with no runtime of its own cannot tell which side is older, so that case keeps its masked refusal.
      if (runtime) throw new ReleaseSkewError(descriptor.gatewaySdkSha256);
      throw new Error("Execution generation requires a matching installed gateway SDK; its ownership was preserved");
    }
    if (runtime) this.record.selectedModelCompaction = true;
    await privateDirectory(directory);
    const metadata = resolve(directory, "execution-generation.json");
    // The runtime's checksum is already part of the fingerprint, so an app update that changes the native codex must not orphan its generations.
    const expected = { version: 1, managed: "subscription-gateway-execution-generation", revision: descriptor.revision, fingerprint: this.fingerprint, nativeHome: this.identity.nativeHome, sdkSha256: runtime?.binarySha256 ?? this.identity.sdkSha256 };
    const saved = await lstat(metadata).catch(error => { if (error.code === "ENOENT") return; throw error; });
    if (saved) {
      if (!saved.isFile() || saved.isSymbolicLink() || saved.uid !== process.getuid?.() || (saved.mode & 0o077)) throw new Error("Execution generation identity changed; existing files were preserved");
      // A record this code wrote and that names another identity protects that generation's files. One that is not such a
      // record at all (truncated, garbled, foreign) proves nothing: it is moved aside and rewritten, so the revision is not lost.
      const recorded = saved.size > 4096 ? undefined : await readJson(metadata);
      if (!recorded || recorded.managed !== expected.managed) { await archiveStaleReceipt(metadata, "generation", "invalid_receipt"); await writePrivateJson(metadata, expected); }
      else if (JSON.stringify(runtime ? { ...recorded, sdkSha256: expected.sdkSha256 } : recorded) !== JSON.stringify(expected)) throw new Error("Execution generation identity changed; existing files were preserved");
    } else await writePrivateJson(metadata, expected);
    const home = await gatewayEngineHome(directory, descriptor.settings, { nativeHome: this.identity.nativeHome, sharedWriterLocks: true, preserveConfig: true });
    const catalog = resolve(directory, "catalog.json");
    let existing: unknown;
    try { existing = JSON.parse(await readFile(catalog, "utf8")); }
    catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (error instanceof SyntaxError) await archiveStaleReceipt(catalog, "generation", "invalid_receipt"); // Garbled: kept aside, then rewritten.
    }
    if (existing === undefined) await writePrivateJson(catalog, descriptor.catalog);
    else if (JSON.stringify(existing) !== JSON.stringify(descriptor.catalog)) throw new Error("Execution generation catalog changed; existing files were preserved");
    // The runtime is guarded by its checksum above. Only a generation that spawns the app's own codex depends on that binary staying put.
    if (!runtime) {
      if (!this.codexValidated) throw new Error("Execution generation requires this release's gateway SDK; its ownership was preserved");
      const sdk = await sdkIdentity(this.identity.codex);
      if (sdk.sdkSha256 !== this.identity.sdkSha256) throw new Error("Execution host SDK changed; restart during a maintenance window");
    }
    if (this.stopped) throw new Error("Execution host is closing");
    const occupied = await lstat(this.record.socketPath).catch(error => { if (error.code === "ENOENT") return; throw error; });
    if (occupied) throw new Error("Execution generation socket is occupied; its listener was preserved");
    const child = spawn(runtime?.executable || this.identity.codex, executionArgs(descriptor.args, this.record.socketPath, catalog, descriptor.settings), { stdio: "ignore", env: gatewayEnvironment(home), detached: false });
    this.child = child;
    this.exited = new Promise(resolve => {
      child.once("error", () => { this.closed = true; });
      child.once("close", () => { this.closed = true; this.owner.pid = 0; this.admin?.stop(); void changed().catch(() => {}); resolve(); });
    });
    this.owner.pid = child.pid || 0; Object.assign(this.owner, child.pid ? await spawnStamp(child.pid) : {}); await changed();
    const deadline = Date.now() + 10000;
    for (;;) {
      if (this.closed || this.stopped) throw new Error("Execution SDK exited before initialization");
      const info = await lstat(this.record.socketPath).catch(error => { if (error.code === "ENOENT") return; throw error; });
      if (info) {
        // Real SDK listeners publish a symlink to their protected physical socket.
        // Only direct owned sockets may be chmodded; validate SDK links without mutation.
        if (info.isSocket() && info.uid === process.getuid?.()) await chmod(this.record.socketPath, 0o600);
        this.owner.socket = await socketIdentity(this.record.socketPath);
        if (!this.owner.socket) throw new Error("Execution SDK socket disappeared during startup");
        await changed(); break;
      }
      if (Date.now() >= deadline) throw new Error("Execution SDK socket startup timed out");
      await delay(25);
    }
    await this.loadedThreads();
  }
  async loadedThreads(): Promise<Set<string>> {
    if (this.closed) return new Set();
    if (this.stopped) throw new Error("Execution host is closing");
    return this.adminProbe ||= this.inspectLoadedThreads().finally(() => { this.adminProbe = undefined; });
  }
  private async inspectLoadedThreads(): Promise<Set<string>> {
    // The SDK can auto-subscribe initialized clients to broadcast-created chats.
    // Probe transiently; never answer callbacks because ordinary first response wins.
    const admin = new SocketAppServerConnection(this.record.socketPath, async () => {}); this.admin = admin;
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([(async () => {
        await admin.ready;
        await admin.request("initialize", { clientInfo: { name: "codex_app_server_daemon", version: "1" }, capabilities: { experimentalApi: true } });
        admin.send({ method: "initialized", params: {} });
        const threads = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
        for (let page = 0; page < 128; page++) {
          const result = await admin.request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
          if (!Array.isArray(result.data) || result.data.some(id => typeof id !== "string")) throw new Error("Execution SDK returned invalid loaded-chat metadata");
          for (const id of result.data) threads.add(id as string);
          if (result.nextCursor == null) return threads;
          if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) throw new Error("Execution SDK returned invalid loaded-chat pagination");
          cursor = result.nextCursor; cursors.add(cursor);
        }
        throw new Error("Execution SDK loaded-chat pagination exceeded its bound");
      })(), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Execution SDK loaded-chat inspection timed out")), 10000).unref(); })]);
    } finally {
      clearTimeout(timeout); admin.stop(); await admin.exited;
      if (this.admin === admin) this.admin = undefined;
    }
  }
  stop(): Promise<void> { return this.stopDone ||= this.stopOwned(); }
  private async stopOwned(): Promise<void> {
    this.stopped = true; this.admin?.stop(); this.child?.kill("SIGTERM");
    await Promise.race([this.exited, delay(1500)]);
    if (!this.closed) this.child?.kill("SIGKILL");
    await Promise.race([this.exited, delay(1000)]);
    if (this.child && !this.closed) throw new Error("Execution SDK did not stop; ownership was preserved");
    await this.adminProbe?.catch(() => {});
    if (this.owner.socket) await removeOwnedSocket(this.record.socketPath, this.owner.socket);
  }
}
