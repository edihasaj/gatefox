import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import { ProviderError } from "./provider.js";

type Message = Record<string, unknown>;
const limit = 16 * 1024 * 1024;
/** Bounds in milliseconds; tests shorten them. */
export const rpcLimits = {
  /** How long the CLI's output may stay open and silent after the CLI process has exited, before the gateway closes it. */
  exitGraceMs: 500,
};
export const record = (value: unknown): Message => value && typeof value === "object" && !Array.isArray(value) ? value as Message : {};

/** SDK stdio framing. Bound headers and payload before parsing JSON. */
export async function* copilotFrames(input: Readable, onChunk?: () => void): AsyncGenerator<Message> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    onChunk?.();
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (buffer.length) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) { if (buffer.length > 8192) throw new ProviderError("invalid_stream", "Copilot RPC header exceeds 8 KiB"); break; }
      if (end > 8192) throw new ProviderError("invalid_stream", "Copilot RPC header exceeds 8 KiB");
      const lengths = [...buffer.subarray(0, end).toString("ascii").matchAll(/^Content-Length:\s*(\d+)\s*$/gmi)];
      const size = Number(lengths[0]?.[1]);
      if (lengths.length !== 1 || !Number.isSafeInteger(size) || size < 1 || size > limit) throw new ProviderError("invalid_stream", "Copilot RPC length is invalid");
      if (buffer.length < end + 4 + size) break;
      let message: Message;
      try { message = record(JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString("utf8"))); }
      catch { throw new ProviderError("invalid_stream", "Copilot RPC returned invalid JSON"); }
      if (message.jsonrpc !== "2.0") throw new ProviderError("invalid_stream", "Copilot RPC version is invalid");
      buffer = buffer.subarray(end + 4 + size); yield message;
    }
  }
  if (buffer.length) throw new ProviderError("incomplete", "Copilot RPC ended inside a frame");
}

/** One subscription CLI process. Never forward its diagnostics or execute host requests. */
export class CopilotRPC {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly events = new Readable({ objectMode: true, highWaterMark: 256, read() {} });
  private readonly pending = new Map<number, { resolve: (value: Message) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sequence = 0; private stopping = false; private queuedBytes = 0;
  /** How many chunks of the CLI's output were read so far: after the CLI exits, a change shows that output is still arriving. */
  private chunks = 0;
  /** Why the connection ended; `notifications` throws it after the events read before it. */
  private failure?: ProviderError;
  /** Whether the CLI's output is still being read: its event stream ends only once everything it wrote was read. */
  private reading = true;
  readonly exited: Promise<void>;
  constructor(env: NodeJS.ProcessEnv, cwd: string, child?: ChildProcessWithoutNullStreams) {
    this.child = child || spawn("copilot", ["--headless", "--stdio", "--no-auto-update", "--disable-builtin-mcps", "--no-custom-instructions", "--no-remote", "--no-remote-export", "--log-dir", cwd], { env, cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.child.stderr.resume(); this.events.on("error", () => {});
    this.exited = new Promise(resolve => this.child.once("close", () => { this.fail(new ProviderError("cli_failed", "Copilot CLI closed before completion")); resolve(); }));
    // Node reports `close` only once every stdio pipe has closed. A process outside the CLI's group can hold the CLI's output open
    // after the CLI has gone (a helper it detached), so `exited` and the event stream would wait for it without limit. Once the CLI
    // has exited, its output is given `exitGraceMs` to say anything more; after that much silence the pipes are closed from this
    // side. Silence is counted in ticks, not by the clock: a process that was held up for longer than the grace has had one tick,
    // not all of them, and reads what is waiting for it before it can close anything.
    // Output that never falls silent is bounded the same way: at most 100 ticks since the CLI exited, however busy its output was.
    this.child.once("exit", () => {
      const tick = Math.max(5, Math.floor(rpcLimits.exitGraceMs / 10)); let seen = this.chunks; let silent = 0; let total = 0;
      const timer = setInterval(() => {
        const arrived = this.chunks !== seen; if (arrived) { seen = this.chunks; silent = 0; } else silent++;
        if (++total < 100 && (arrived || silent < 10)) return;
        clearInterval(timer);
        this.failure ??= new ProviderError("cli_failed", "Copilot CLI closed before completion");
        for (const stream of [this.child.stdout, this.child.stdin, this.child.stderr]) stream.destroy();
      }, tick).unref();
      this.child.once("close", () => clearInterval(timer));
    });
    this.child.once("error", () => this.fail(new ProviderError("cli_failed", "Copilot CLI is unavailable; run gateway doctor")));
    this.child.stdin.on("error", () => this.fail(new ProviderError("cli_failed", "Copilot CLI connection failed")));
    void this.read();
  }
  private async read(): Promise<void> {
    try {
      for await (const message of copilotFrames(this.child.stdout, () => { this.chunks++; })) {
        if (typeof message.method === "string") {
          if (message.id !== undefined) { this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Gateway does not execute host requests" } }); continue; }
          if (message.method !== "session.event") continue;
          const bytes = Buffer.byteLength(JSON.stringify(message)); this.queuedBytes += bytes;
          if (this.queuedBytes > limit || !this.events.push({ message, bytes })) throw new ProviderError("output_too_large", "Copilot event backlog exceeds its limit");
        } else if (typeof message.id === "number") {
          const pending = this.pending.get(message.id); if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(message.id);
          if (message.error) pending.reject(new ProviderError("cli_failed", "Copilot CLI rejected a gateway request"));
          else pending.resolve(record(message.result));
        }
      }
    } catch (error) { this.fail(error instanceof ProviderError ? error : new ProviderError("invalid_stream", "Copilot RPC stream failed")); }
    finally { this.reading = false; this.endEvents(); }
  }
  private send(message: Message): void {
    if (this.stopping) return;
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body) > limit) throw new ProviderError("request_too_large", "Copilot RPC request exceeds 16 MiB", 413);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
  request(method: string, params: Message = {}, timeout = 15000): Promise<Message> {
    if (this.stopping) return Promise.reject(new ProviderError("cli_failed", "Copilot CLI connection is closed"));
    if (this.pending.size >= 32) return Promise.reject(new ProviderError("busy", "Too many pending Copilot requests"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ProviderError("timeout", "Copilot CLI request timed out", 504)); }, timeout).unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new ProviderError("invalid_request", "Copilot request is invalid", 400)); }
    });
  }
  /** The CLI's session events in order. Events it sent before the connection failed come first, then the failure is thrown. */
  async *notifications(): AsyncGenerator<Message> {
    for await (const entry of this.events) { this.queuedBytes -= entry.bytes; yield entry.message; }
    throw this.failure ?? new ProviderError("cli_failed", "Copilot CLI closed before completion");
  }
  private fail(error: ProviderError): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear();
    this.failure ??= error; this.endEvents();
    // A connection that failed (a backlog, an invalid frame, a closed pipe) may belong to a session that holds a tool request:
    // it ends with SIGKILL, never SIGTERM, whose graceful exit lets the runtime fail that request and make a model call.
    this.kill();
  }
  /**
   * Ends the event stream once the connection has failed and everything the CLI wrote was read. Destroying it would drop
   * events not yet consumed, such as the usage of a model call the CLI reported just before it stopped.
   */
  private endEvents(): void { if (this.failure && !this.reading && !this.events.destroyed) this.events.push(null); }
  get pid(): number | undefined { return this.child.pid; }
  /** Whether the connection is over: stopped by the gateway, or the process has exited. */
  get closed(): boolean { return this.stopping || this.child.exitCode !== null || this.child.signalCode !== null; }
  /** Signals the CLI's whole process group (it is its own group leader), or just the process if the group is gone. */
  private signal(name: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid && this.child.exitCode === null && this.child.signalCode === null) { try { process.kill(-pid, name); return; } catch { /* Fall back to the process itself. */ } }
    try { this.child.kill(name); } catch { /* Already gone. */ }
  }
  /** Ends the process and anything it started at once, with no grace: a session that must not make another model call. */
  kill(): void { this.stopping = true; this.signal("SIGKILL"); }
  stop(): void {
    if (this.stopping) return; this.stopping = true;
    this.child.stdin.end(); this.signal("SIGTERM");
    const timer = setTimeout(() => this.signal("SIGKILL"), 1500).unref();
    this.child.once("close", () => clearTimeout(timer));
  }
}
