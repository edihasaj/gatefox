import { spawn } from "node:child_process";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

export type Message = Record<string, unknown>;
export type Id = string | number;
export const object = (value: unknown): Message => value && typeof value === "object" && !Array.isArray(value) ? value as Message : {};
export const isId = (value: unknown): value is Id => typeof value === "string" || typeof value === "number";

/** Bound bytes before decoding, including frames that never contain a newline. */
export async function* jsonLines(input: Readable): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8"); let frame = ""; let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let end = 0; end < buffer.length; end++) {
      if (buffer[end] !== 10) continue;
      bytes += end - start;
      if (bytes > 16 * 1024 * 1024) throw new Error("App-server frame exceeds 16 MiB");
      frame += decoder.write(buffer.subarray(start, end)); frame += decoder.end();
      yield frame; frame = ""; bytes = 0; start = end + 1;
    }
    bytes += buffer.length - start;
    if (bytes > 16 * 1024 * 1024) throw new Error("App-server frame exceeds 16 MiB");
    frame += decoder.write(buffer.subarray(start));
  }
  frame += decoder.end();
  if (frame.trim()) throw new Error("App-server stream ended inside a JSON frame");
}

/** One bounded JSON-RPC connection. The caller owns routing and public request IDs. */
export class AppServerConnection {
  private readonly child;
  private sequence = 0;
  private stopping = false;
  private killTimer?: NodeJS.Timeout;
  private readonly requests = new Map<Id, { resolve: (value: Message) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Child close can precede forwarding of buffered terminal notifications. */
  readonly drained: Promise<void>;
  closed = false;
  constructor(executable: string, args: string[], onMessage: (message: Message) => Promise<void>, onExit: (connection: AppServerConnection) => void, env = process.env) {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], env }); this.child = child;
    this.child.stderr.pipe(process.stderr);
    this.exited = new Promise(resolve => this.child.once("close", (code, signal) => {
      this.closed = true; clearTimeout(this.killTimer);
      for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error("Codex app-server exited")); }
      this.requests.clear(); onExit(this); resolve({ code, signal });
    }));
    this.child.once("error", () => { process.stderr.write("gateway: Original Codex executable is unavailable\n"); this.stop(); });
    this.child.stdin.on("error", () => this.stop());
    this.drained = (async () => {
      try {
        for await (const line of jsonLines(child.stdout)) {
          let message: Message; try { message = object(JSON.parse(line)); } catch { throw new Error("Codex app-server returned invalid JSON"); }
          if (typeof message.method === "string") await onMessage(message);
          else if (isId(message.id) && this.requests.has(message.id)) {
            const pending = this.requests.get(message.id)!; this.requests.delete(message.id); clearTimeout(pending.timer);
            if (message.error) { const details = object(message.error); pending.reject(Object.assign(new Error(String(details.message || "Codex request failed")), { code: details.code, data: details.data })); }
            else pending.resolve(object(message.result));
          }
        }
      } catch (error) { if (!this.stopping) process.stderr.write(`gateway: ${error instanceof Error ? error.message : "App-server stream failed"}\n`); this.stop(); }
    })();
  }
  send(message: Message): void { if (!this.stopping && !this.closed) this.child.stdin.write(JSON.stringify(message) + "\n"); }
  request(method: string, params: Message): Promise<Message> {
    return new Promise((resolve, reject) => {
      if (this.stopping || this.closed) { reject(new Error("Codex app-server is closed")); return; }
      if (this.requests.size >= 256) { reject(new Error("Too many pending Codex requests")); return; }
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error("Codex app-server request timed out")); }, 120000).unref();
      this.requests.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  stop(): void {
    if (this.stopping || this.closed) return; this.stopping = true;
    this.child.stdin.end(); this.child.kill("SIGTERM");
    // Closing an owned child must not wait for an unconsumed stdout pipe while
    // the client is already gone or forwarding is blocked on backpressure.
    this.child.stdout.destroy(); this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), 1500).unref();
  }
}

export async function emitMessage(message: Message): Promise<void> {
  if (!process.stdout.write(JSON.stringify(message) + "\n")) await once(process.stdout, "drain");
}
