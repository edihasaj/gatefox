import { isAbsolute } from "node:path";
import { connect } from "node:net";
import WebSocket, { type RawData } from "ws";
import { isId, object, type Id, type Message } from "./app-server-connection.js";
import { telemetry } from "./telemetry.js";
import { reportException } from "./error-report.js";

const FRAME_LIMIT = 16 * 1024 * 1024;
const PENDING_LIMIT = 256;
type Pending = { resolve: (value: Message) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Exit = { code: number | null; signal: NodeJS.Signals | null };

/** An independent RPC client of an already-owned engine. Closing it never stops the engine. */
export class SocketAppServerConnection {
  private readonly socket: WebSocket;
  private sequence = 0;
  private stopping = false;
  private failed = false;
  private connectTimer?: NodeJS.Timeout;
  private closeTimer?: NodeJS.Timeout;
  private readonly requests = new Map<Id, Pending>();
  private readonly queued: string[] = [];
  private queuedBytes = 0;
  private incomingCount = 0;
  private incomingBytes = 0;
  private dispatch = Promise.resolve();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveExit!: (value: Exit) => void;
  readonly ready: Promise<void>;
  readonly exited: Promise<Exit>;
  closed = false;

  constructor(socketPath: string, private readonly onMessage: (message: Message) => Promise<void>, private readonly onExit: (connection: SocketAppServerConnection) => void = () => {},
    private readonly options: { drainOnClose?: boolean } = {}) {
    if (!isAbsolute(socketPath) || /[:\0]/u.test(socketPath)) throw new Error("Codex app-server socket path must be absolute and contain no colon or NUL");
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // A caller may use request() without awaiting ready; transport failure must still be handled.
    void this.ready.catch(() => {});
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    const urlPath = socketPath.split("/").map(part => encodeURIComponent(part)).join("/");
    this.socket = new WebSocket(`ws+unix://${urlPath}:/`, {
      maxPayload: FRAME_LIMIT, perMessageDeflate: false, handshakeTimeout: 10000,
      // URL parsing escapes spaces/non-ASCII; the actual Unix path must retain its bytes.
      createConnection: () => connect(socketPath),
    });
    this.connectTimer = setTimeout(() => this.fail("Codex app-server socket connection timed out"), 10000).unref();
    this.socket.once("open", () => {
      clearTimeout(this.connectTimer);
      if (this.stopping) { this.socket.close(); return; }
      this.resolveReady();
      const queued = this.queued.splice(0); this.queuedBytes = 0;
      try { for (const frame of queued) this.write(frame); }
      catch { this.fail("Codex app-server socket send failed"); }
    });
    this.socket.on("message", (data, binary) => this.receive(data, binary));
    this.socket.on("error", () => this.fail("Codex app-server socket failed"));
    this.socket.once("close", code => this.finish(code));
  }
  /** Natural close may precede forwarding of already-received terminal events. */
  get drained(): Promise<void> { return this.exited.then(() => this.dispatch).catch(() => {}); }

  send(message: Message): void {
    if (this.stopping || this.closed) return;
    const frame = JSON.stringify(message);
    const bytes = Buffer.byteLength(frame);
    if (bytes > FRAME_LIMIT) throw new Error("App-server frame exceeds 16 MiB");
    if (this.socket.readyState === WebSocket.CONNECTING) {
      if (this.queued.length >= PENDING_LIMIT || this.queuedBytes + bytes > FRAME_LIMIT) throw new Error("Codex app-server socket send queue is full");
      this.queued.push(frame); this.queuedBytes += bytes;
    } else this.write(frame);
  }

  request(method: string, params: Message, timeoutMs = 120_000): Promise<Message> {
    return new Promise((resolve, reject) => {
      if (this.stopping || this.closed) { reject(new Error("Codex app-server is closed")); return; }
      if (this.requests.size >= PENDING_LIMIT) { reject(new Error("Too many pending Codex requests")); return; }
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error("Codex app-server request timed out")); }, timeoutMs).unref();
      this.requests.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { this.requests.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    if (this.closed) return;
    this.rejectOutstanding(new Error("Codex app-server is closed"));
    clearTimeout(this.connectTimer);
    if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
    else if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000);
    this.closeTimer = setTimeout(() => this.socket.terminate(), 1500).unref();
  }

  private write(frame: string): void {
    if (this.stopping || this.closed) return;
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server socket is not open");
    if (this.socket.bufferedAmount + Buffer.byteLength(frame) > FRAME_LIMIT) throw new Error("Codex app-server socket send queue is full");
    this.socket.send(frame, error => { if (error) this.fail("Codex app-server socket send failed"); });
  }

  private receive(data: RawData, binary: boolean): void {
    if (this.stopping || this.closed) return;
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (binary || buffer.length > FRAME_LIMIT) { this.fail("Codex app-server returned an invalid frame"); return; }
    let message: Message;
    try {
      const value: unknown = JSON.parse(buffer.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      message = object(value);
    } catch { this.fail("Codex app-server returned invalid JSON"); return; }
    if (typeof message.method === "string") {
      if (this.incomingCount >= PENDING_LIMIT || this.incomingBytes + buffer.length > FRAME_LIMIT) { this.fail("Codex app-server message queue is full"); return; }
      this.incomingCount++; this.incomingBytes += buffer.length;
      this.dispatch = this.dispatch.then(async () => { if (!this.stopping && (!this.closed || this.options.drainOnClose)) await this.onMessage(message); })
        .catch(error => {
          // A callback failure does not establish that the shared transport or engine failed.
          reportException(error, "engine_message");
          const method = message.method as string;
          telemetry("engine_message_failed", { transport: "socket", ...(method.length <= 64 && /^[A-Za-z]+(\/[A-Za-z]+)*$/.test(method) ? { method } : {}) });
          if (isId(message.id)) {
            try { this.send({ id: message.id, error: { code: -32603, message: "The adapter could not deliver this request" } }); }
            catch { this.fail("Codex app-server socket send failed"); }
          }
        })
        .finally(() => { this.incomingCount--; this.incomingBytes -= buffer.length; });
    } else if (isId(message.id)) {
      // Responses bypass notification dispatch: a handler may itself await an RPC request.
      const pending = this.requests.get(message.id);
      if (!pending) return;
      this.requests.delete(message.id); clearTimeout(pending.timer);
      if (message.error) {
        const details = object(message.error);
        pending.reject(Object.assign(new Error(String(details.message || "Codex request failed")), { code: details.code, data: details.data }));
      } else pending.resolve(object(message.result));
    }
  }

  private rejectOutstanding(error: Error): void {
    this.rejectReady(error);
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error); }
    this.requests.clear(); this.queued.length = 0; this.queuedBytes = 0;
  }

  private fail(message: string): void {
    if (this.closed || this.stopping) return;
    this.failed = true;
    this.rejectOutstanding(new Error(message));
    this.stop();
  }

  private finish(code: number): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectTimer); clearTimeout(this.closeTimer);
    this.rejectOutstanding(new Error("Codex app-server socket closed"));
    this.resolveExit({ code: this.failed || code !== 1000 ? 1 : 0, signal: null });
    try { this.onExit(this); } catch { /* The socket is closed even if its owner's cleanup fails. */ }
  }
}
