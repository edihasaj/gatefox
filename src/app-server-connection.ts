import { spawn } from "node:child_process";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { telemetry } from "./telemetry.js";
import { reportException } from "./error-report.js";

export type Message = Record<string, unknown>;
export type Id = string | number;
export type EngineLabel = "native" | "gateway";
/** Fixed vocabulary for stops the adapter started itself; an engine-initiated exit reports "none". */
export type EngineStopReason = "session_end" | "idle" | "replaced" | "stdin_error" | "stream_error" | "spawn_error";
export const object = (value: unknown): Message => value && typeof value === "object" && !Array.isArray(value) ? value as Message : {};
export const isId = (value: unknown): value is Id => typeof value === "string" || typeof value === "number";

/** The client input stream keeps its old hard limit; an engine stream drops oversized frames instead. */
const CLIENT_FRAME_LIMIT = 16 * 1024 * 1024;
export const ENGINE_FRAME_LIMIT = 64 * 1024 * 1024;
const methodField = /^[A-Za-z]+(\/[A-Za-z]+)*$/;
/** Only a dropped frame's first bytes are kept, and only to identify the request it answers. */
const FRAME_HEAD = 128;
/** How long a broken pipe waits for an engine that may already be on its way out. */
const PIPE_EXIT_GRACE_MS = 500;
/** A dropped frame that begins like an answer to one of our requests; a server request names a method instead. */
const frameHeadId = /^\{"id":(\d+)/;

/** The frame's size band; a dropped frame is never buffered, only counted. */
function sizeMiBBucket(bytes: number): "64" | "128" | "256" | "more" {
  const mib = bytes / 1024 / 1024;
  return mib <= 128 ? "64" : mib <= 256 ? "128" : mib <= 512 ? "256" : "more";
}

/**
 * Bound bytes before decoding, including frames that never contain a newline.
 * Without an engine label (the client input stream) an oversized frame ends the stream as before.
 * With one, the adapter never kills an engine for a recoverable problem: bytes of an oversized
 * frame are discarded until the next newline, `engine_frame_dropped` is recorded, and reading continues.
 */
export async function* jsonLines(input: Readable, engine?: EngineLabel, onDroppedFrame?: (head: string) => void): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8"); const limit = engine ? ENGINE_FRAME_LIMIT : CLIENT_FRAME_LIMIT;
  let frame = ""; let bytes = 0; let discarding = false; let head = "";
  /** An oversized frame is over: record its band and first bytes, then start the next one clean. */
  const dropped = () => {
    telemetry("engine_frame_dropped", { engine: engine!, sizeMiB: sizeMiBBucket(bytes) }); onDroppedFrame?.(head);
    frame = ""; bytes = 0; head = ""; decoder.end();
  };
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // The bytes that belong to the frame in progress are kept as a head even when the frame turns out to be oversized.
    const keepHead = (from: number, to: number) => { if (!discarding && head.length < FRAME_HEAD) head += buffer.subarray(from, Math.min(from + FRAME_HEAD - head.length, to)).toString("latin1"); };
    let start = 0;
    for (let end = 0; end < buffer.length; end++) {
      if (buffer[end] !== 10) continue;
      if (discarding) { bytes += end - start; dropped(); discarding = false; }
      else {
        keepHead(start, end); bytes += end - start;
        // The frame ended inside this chunk: it is oversized but complete, so the next line still stands on its own.
        if (bytes > limit) { if (!engine) throw new Error("App-server frame exceeds 16 MiB"); dropped(); }
        else { frame += decoder.write(buffer.subarray(start, end)); frame += decoder.end(); const line = frame; frame = ""; bytes = 0; head = ""; yield line; }
      }
      start = end + 1;
    }
    bytes += buffer.length - start;
    if (discarding) continue; // The frame began in an earlier chunk; its head is already kept.
    keepHead(start, buffer.length);
    if (bytes > limit) {
      if (!engine) throw new Error("App-server frame exceeds 16 MiB");
      discarding = true; frame = ""; decoder.end();
    } else if (start < buffer.length) frame += decoder.write(buffer.subarray(start));
  }
  if (discarding) dropped();
  else { frame += decoder.end(); if (frame.trim()) throw new Error("App-server stream ended inside a JSON frame"); }
}

/** One bounded JSON-RPC connection. The caller owns routing and public request IDs. */
export class AppServerConnection {
  private readonly child;
  private sequence = 0;
  private stopping = false;
  private stopReason?: EngineStopReason;
  private readonly startedAt = Date.now();
  private closedAt?: number;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private killTimer?: NodeJS.Timeout;
  private pipeFailureTimer?: NodeJS.Timeout;
  private readonly requests = new Map<Id, { resolve: (value: Message) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Child close can precede forwarding of buffered terminal notifications. */
  readonly drained: Promise<void>;
  closed = false;
  constructor(executable: string, args: string[], onMessage: (message: Message) => Promise<void>, onExit: (connection: AppServerConnection) => void, env = process.env, readonly engine: EngineLabel = "native") {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], env }); this.child = child;
    this.child.stderr.pipe(process.stderr);
    this.exited = new Promise(resolve => this.child.once("close", (code, signal) => {
      this.closed = true; this.closedAt = Date.now(); this.exitCode = code; this.exitSignal = signal;
      clearTimeout(this.killTimer); clearTimeout(this.pipeFailureTimer); this.pipeFailureTimer = undefined;
      for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error("Codex app-server exited")); }
      this.requests.clear(); onExit(this); resolve({ code, signal });
    }));
    this.child.once("error", () => { process.stderr.write("gateway: Original Codex executable is unavailable\n"); this.stop("spawn_error"); });
    this.child.stdin.on("error", () => this.pipeFailed("stdin_error"));
    this.drained = (async () => {
      try {
        for await (const line of jsonLines(child.stdout, this.engine, head => this.droppedFrame(head))) {
          let message: Message;
          try { message = object(JSON.parse(line)); }
          catch { telemetry("engine_frame_invalid", { engine: this.engine }); continue; }
          if (typeof message.method === "string") {
            // A recoverable handler failure must never stop the engine: report it and keep reading.
            try { await onMessage(message); }
            catch (error) {
              reportException(error, "engine_message");
              const method = message.method;
              telemetry("engine_message_failed", { engine: this.engine, ...(method.length <= 64 && methodField.test(method) ? { method } : {}) });
              // A server request the adapter could not pass on must not leave the engine waiting for an answer.
              if (isId(message.id)) this.send({ id: message.id, error: { code: -32603, message: "The adapter could not deliver this request" } });
            }
          }
          else if (isId(message.id) && this.requests.has(message.id)) {
            const pending = this.requests.get(message.id)!; this.requests.delete(message.id); clearTimeout(pending.timer);
            if (message.error) { const details = object(message.error); pending.reject(Object.assign(new Error(String(details.message || "Codex request failed")), { code: details.code, data: details.data })); }
            else pending.resolve(object(message.result));
          }
        }
      } catch (error) { if (!this.stopping) process.stderr.write(`gateway: ${error instanceof Error ? error.message : "App-server stream failed"}\n`); this.pipeFailed("stream_error"); }
    })();
  }
  /** What the exit telemetry may say once the process is gone; no paths, ids or output are included. */
  get exitFacts(): { code: number | null; signal: NodeJS.Signals | null; uptimeMs: number; initiatedBy: "adapter" | "engine"; reason: EngineStopReason | "none" } {
    return { code: this.exitCode, signal: this.exitSignal, uptimeMs: (this.closedAt ?? Date.now()) - this.startedAt,
      initiatedBy: this.stopReason ? "adapter" : "engine", reason: this.stopReason ?? "none" };
  }
  /** A broken pipe is not always the adapter's doing: an engine that leaves inside the grace was exiting by itself. */
  private pipeFailed(reason: EngineStopReason): void {
    if (this.stopping || this.closed || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.pipeFailureTimer ??= setTimeout(() => {
      this.pipeFailureTimer = undefined;
      if (this.stopping || this.closed || this.child.exitCode !== null || this.child.signalCode !== null) return;
      this.stop(reason);
    }, PIPE_EXIT_GRACE_MS).unref();
  }
  /** The response of a dropped oversized frame never arrives, so its caller learns so at once. */
  private droppedFrame(head: string): void {
    const matched = frameHeadId.exec(head);
    const id = matched && !head.includes('"method"') ? Number(matched[1]) : Number.NaN;
    const pending = Number.isFinite(id) ? this.requests.get(id) : undefined;
    if (!pending) return;
    this.requests.delete(id); clearTimeout(pending.timer);
    pending.reject(new Error("Codex app-server response frame was too large to read"));
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
  stop(reason: EngineStopReason = "session_end"): void {
    if (this.stopping || this.closed) return; this.stopping = true; this.stopReason = reason;
    this.child.stdin.end(); this.child.kill("SIGTERM");
    // Closing an owned child must not wait for an unconsumed stdout pipe while
    // the client is already gone or forwarding is blocked on backpressure.
    this.child.stdout.destroy(); this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), 1500).unref();
  }
}

export async function emitMessage(message: Message): Promise<void> {
  if (!process.stdout.write(JSON.stringify(message) + "\n")) await once(process.stdout, "drain");
}
