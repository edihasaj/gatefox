import { createServer, type Server, type Socket } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { chmod } from "node:fs/promises";
import { inlineImage } from "../protocol/images.js";

/** Largest NDJSON frame either side accepts. */
export const maxRelayFrame = 16 * 1024 * 1024;
export type RelayContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type RelayFailure = "relay_lost" | "unknown_call" | "frame_too_large";

/** MCP result content for a caller's tool output: exact text, inline images as image blocks. */
export function relayContent(output: unknown): RelayContent[] {
  if (typeof output === "string") return [{ type: "text", text: output }];
  const content = (Array.isArray(output) ? output : []).flatMap((part): RelayContent[] => {
    const value = (part && typeof part === "object" ? part : {}) as { type?: unknown; text?: unknown; image_url?: unknown; detail?: unknown };
    if (value.type === "input_image") { const image = inlineImage(value.image_url, value.detail); return [{ type: "image", data: image.data, mimeType: image.mediaType }]; }
    return typeof value.text === "string" ? [{ type: "text", text: value.text }] : [];
  });
  return content.length ? content : [{ type: "text", text: "" }];
}

/** Splits a UTF-8 stream into JSON frames; a frame over the bound stops the stream. */
export function frameReader(onFrame: (frame: Record<string, unknown>) => void, onOversize: () => void): (chunk: string) => void {
  let buffer = "";
  return chunk => {
    // Only the new chunk is searched, so a long frame costs linear time.
    let start = 0;
    for (let end = chunk.indexOf("\n"); end >= 0; start = end + 1, end = chunk.indexOf("\n", start)) {
      const line = buffer + chunk.slice(start, end); buffer = "";
      if (line.length > maxRelayFrame) { onOversize(); return; }
      try { const frame = JSON.parse(line) as unknown; if (frame && typeof frame === "object" && !Array.isArray(frame)) onFrame(frame as Record<string, unknown>); } catch { /* A malformed frame is ignored. */ }
    }
    buffer += chunk.slice(start);
    if (buffer.length > maxRelayFrame) { buffer = ""; onOversize(); }
  };
}

interface Pending { name: string; rpcId?: unknown; output?: RelayContent[]; answered?: boolean }
interface Call { rpcId: unknown; name: string; toolUseId?: string }

/**
 * The gateway end of one session's tool relay: a Unix socket that accepts exactly one
 * client, the session's MCP child, after it presents the session key. The child
 * forwards each tools/call as {call, name, toolUseId}; arguments never cross. The
 * gateway answers with the caller's own output once Codex sends it. A call can arrive
 * while the message that made it is still streaming, so calls stay unmatched until the
 * request ends; once the session waits on outputs, a call it never emitted is a failure.
 */
export class ClaudeRelay {
  private server?: Server; private client?: Socket; private closed = false; private streaming = true;
  private expected = new Map<string, Pending>(); private early: Call[] = [];
  private readonly ready = new Set<(ok: boolean) => void>(); private greeted = false;
  constructor(private readonly key: string, private readonly onFailure: (reason: RelayFailure) => void) {}

  async listen(path: string): Promise<void> {
    const server = this.server = createServer(socket => this.accept(socket));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { server.off("error", reject); resolve(); }); });
    await chmod(path, 0o600);
  }

  /** Resolves true once the MCP child has presented the key. */
  waitReady(timeoutMs: number): Promise<boolean> {
    if (this.greeted || this.closed) return Promise.resolve(this.greeted && !this.closed);
    return new Promise(resolve => {
      const done = (ok: boolean) => { clearTimeout(timer); this.ready.delete(done); resolve(ok); };
      const timer = setTimeout(() => done(false), timeoutMs); this.ready.add(done);
    });
  }

  /** The calls this request returned to the caller. Early calls must all be among them. */
  expect(calls: Array<{ id: string; name: string }>): boolean {
    this.expected = new Map(calls.map(call => [call.id, { name: call.name }])); this.streaming = false;
    const early = this.early; this.early = [];
    return early.every(call => this.match(call));
  }

  /** The caller's outputs: answered now if the CLI already asked, otherwise when it does. */
  deliver(outputs: Map<string, RelayContent[]>): void {
    this.streaming = true;
    for (const [id, output] of outputs) {
      const pending = this.expected.get(id);
      if (!pending || pending.answered) continue;
      pending.output = output; if (pending.rpcId !== undefined) this.answer(pending);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.client?.destroy(); this.server?.close();
    for (const done of [...this.ready]) done(false);
  }

  private accept(socket: Socket): void {
    if (this.client || this.closed) { socket.destroy(); return; }
    socket.setEncoding("utf8");
    // The key must arrive first and promptly; anyone else is dropped without effect.
    const timer = setTimeout(() => socket.destroy(), 5000);
    let accepted = false;
    const read = frameReader(frame => {
      if (!accepted) {
        clearTimeout(timer);
        const hello = typeof frame.hello === "string" ? Buffer.from(frame.hello) : Buffer.alloc(0); const key = Buffer.from(this.key);
        if (hello.length !== key.length || !timingSafeEqual(hello, key) || this.client) { socket.destroy(); return; }
        accepted = true; this.client = socket; this.greeted = true;
        for (const done of [...this.ready]) done(true);
        return;
      }
      if (frame.call !== undefined && typeof frame.name === "string") this.call({ rpcId: frame.call, name: frame.name, toolUseId: typeof frame.toolUseId === "string" ? frame.toolUseId : undefined });
    }, () => { socket.destroy(); if (accepted) this.fail("frame_too_large"); });
    socket.on("data", read);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { clearTimeout(timer); if (accepted) this.fail("relay_lost"); });
  }

  private call(call: Call): void {
    if (this.match(call)) return;
    if (this.streaming && !this.early.some(other => call.toolUseId !== undefined && other.toolUseId === call.toolUseId)) { this.early.push(call); return; }
    this.fail("unknown_call");
  }

  /** Matches by tool_use id, or first-in-first-out among unanswered calls of that name when the id is missing. */
  private match(call: Call): boolean {
    const pending = call.toolUseId !== undefined ? this.expected.get(call.toolUseId)
      : [...this.expected.values()].find(entry => entry.name === call.name && entry.rpcId === undefined);
    if (!pending || pending.rpcId !== undefined || pending.name !== call.name) return false;
    pending.rpcId = call.rpcId;
    if (pending.output) this.answer(pending);
    return true;
  }

  private answer(pending: Pending): void {
    pending.answered = true;
    this.client?.write(JSON.stringify({ result: pending.rpcId, content: pending.output }) + "\n");
  }

  private fail(reason: RelayFailure): void { if (!this.closed) { this.close(); this.onFailure(reason); } }
}
