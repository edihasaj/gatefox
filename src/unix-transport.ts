import { createServer } from "node:http";
import { mkdir, lstat, chmod } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import type { Message } from "./app-server-connection.js";

export function unixSocketPath(listen: string): string {
  if (!listen.startsWith("unix://")) throw new Error("Choose stdio:// or a private unix:// socket");
  const path = listen.slice(7) || resolve(process.env.CODEX_HOME || resolve(homedir(), ".codex"), "app-server-control/app-server-control.sock");
  if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path) > 103) throw new Error("Unix socket requires an absolute path of at most 103 bytes");
  return path;
}

/** Private filesystem permissions protect SSH's local WebSocket transport. */
export async function serveUnix(path: string, signal: AbortSignal,
  session: (input: Readable, emit: (message: Message) => Promise<void>, signal: AbortSignal) => Promise<unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o022)) throw new Error("Unix socket directory must be owned by this user and not writable by others");
  try { await lstat(path); throw new Error("Unix socket path is occupied; the existing listener was not replaced"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
  const active = new Set<Promise<unknown>>(); const controllers = new Set<AbortController>();
  server.on("upgrade", (req, socket, head) => {
    if (signal.aborted || active.size >= 8 || req.headers.origin || !["/", "/rpc"].includes(req.url || "")) { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, ws => {
      const control = new AbortController(); controllers.add(control);
      const input = new Readable({ read() { ws.resume(); } });
      ws.on("error", () => { control.abort(); input.destroy(); });
      ws.on("close", () => { control.abort(); input.destroy(); });
      ws.on("message", (data, binary) => {
        if (binary) { ws.close(1003, "Text JSON-RPC frames required"); return; }
        if (!input.push(Buffer.concat([Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), Buffer.from("\n")]))) ws.pause();
      });
      const emit = (message: Message) => new Promise<void>((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) { reject(new Error("Unix client disconnected")); return; }
        if (ws.bufferedAmount > 16 * 1024 * 1024) { ws.close(1009, "Client output queue exceeded"); reject(new Error("Unix client output queue exceeded")); return; }
        ws.send(JSON.stringify(message), error => error ? reject(error) : resolve());
      });
      const task = session(input, emit, control.signal).catch(() => { ws.close(1011, "Gateway connection failed"); })
        .finally(() => { controllers.delete(control); active.delete(task); input.destroy(); ws.terminate(); });
      active.add(task);
    });
  });
  const close = () => { for (const controller of controllers) controller.abort(); for (const ws of sockets.clients) ws.terminate(); server.close(); };
  try {
    server.listen(path); await once(server, "listening"); await chmod(path, 0o600);
    const closed = once(server, "close"); signal.addEventListener("abort", close, { once: true });
    if (signal.aborted) close();
    await closed;
  } finally { signal.removeEventListener("abort", close); close(); await Promise.allSettled([...active]); sockets.close(); }
}
