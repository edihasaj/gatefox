import { createServer } from "node:http";
import { mkdir, lstat, chmod, link, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import type { Message } from "./app-server-connection.js";
import { writePrivateJson } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { releasePattern, releaseState } from "./self-update.js";

/** What the process owning a listener uses to retire it after an install. */
export interface UnixListenerControl {
  /** WebSocket sessions running now; a listener with sessions must keep serving them. */
  sessions(): number;
  /** Stop taking new sessions and drop the public alias, but only while this listener owns it. */
  retire(): Promise<boolean>;
}

export function unixSocketPath(listen: string): string {
  if (!listen.startsWith("unix://")) throw new Error("Choose stdio:// or a private unix:// socket");
  const path = listen.slice(7) || resolve(process.env.CODEX_HOME || resolve(homedir(), ".codex"), "app-server-control/app-server-control.sock");
  if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path) > 103) throw new Error("Unix socket requires an absolute path of at most 103 bytes");
  return path;
}

/**
 * Private filesystem permissions protect SSH's local WebSocket transport.
 * `release` records which gateway release this listener runs, so a later bootstrap on the
 * installed release can tell a stale listener from a current one. Omit it to derive it from
 * where this module was loaded, and pass `null` to record none (a checkout run).
 * `onListen` receives the control handle once the socket is public, so the process that owns
 * the listener can watch for an install and retire it; see `codex-shim`.
 */
export async function serveUnix(path: string, signal: AbortSignal,
  session: (input: Readable, emit: (message: Message) => Promise<void>, signal: AbortSignal) => Promise<unknown>,
  release: string | null | undefined = releaseState()?.running,
  onListen?: (listener: UnixListenerControl) => void): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o022)) throw new Error("Unix socket directory must be owned by this user and not writable by others");
  try { await lstat(path); throw new Error("Unix socket path is occupied; the existing listener was not replaced"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Node unlinks its bind path on close. Bind privately, then expose a hard link
  // so retiring this listener cannot unlink a newer desktop bootstrap's socket.
  const boundPath = unixSocketPath("unix://" + resolve(dirname(path), `.gw-${randomBytes(6).toString("hex")}`));
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
  const active = new Set<Promise<unknown>>(); const controllers = new Set<AbortController>();
  let retiring = false; let leaseTimer: NodeJS.Timeout | undefined; let inode: string | undefined; let device: string | undefined;
  server.on("upgrade", (req, socket, head) => {
    if (retiring || signal.aborted || active.size >= 8 || req.headers.origin || !["/", "/rpc"].includes(req.url || "")) { socket.destroy(); return; }
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
        .finally(() => { controllers.delete(control); active.delete(task); input.destroy(); ws.terminate(); if (retiring && !active.size) close(); });
      active.add(task);
    });
  });
  const close = () => { for (const controller of controllers) controller.abort(); for (const ws of sockets.clients) ws.terminate(); server.close(); };
  const retire = async () => {
    // Under the lock a bootstrap also takes, so a newer listener's alias is never removed here.
    const dropped = await withPrivateFileLock(path + ".gateway-lease", async () => {
      const current = await lstat(path, { bigint: true }).catch(() => undefined);
      if (!current || String(current.ino) !== inode || String(current.dev) !== device) return true;
      return await unlink(path).then(() => true, () => false);
    }).catch(() => false);
    if (!dropped) return false;
    retiring = true; if (!active.size) close();
    return true;
  };
  try {
    server.listen(boundPath); await once(server, "listening"); await chmod(boundPath, 0o600);
    const bound = await lstat(boundPath, { bigint: true }); inode = String(bound.ino); device = String(bound.dev);
    await withPrivateFileLock(path + ".gateway-lease", async () => {
      try { await lstat(path); throw new Error("Unix socket path is occupied; the existing listener was not replaced"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // Publish the ownership record first. The alias is the readiness signal. The release
      // name is capped, so the record stays well under the 4096 byte limit readers enforce.
      await writePrivateJson(path + ".gateway-lease",
        { inode, device, boundPath, ...(typeof release === "string" && releasePattern.test(release) ? { release } : {}) });
      await link(boundPath, path);
    });
    onListen?.({ sessions: () => active.size, retire });
    leaseTimer = setInterval(() => {
      void lstat(path, { bigint: true }).then(info => String(info.ino) === inode && String(info.dev) === device, () => false).then(owned => {
        if (!owned) { retiring = true; if (!active.size) close(); }
      });
    }, 1000).unref();
    const closed = once(server, "close"); signal.addEventListener("abort", close, { once: true });
    if (signal.aborted) close();
    await closed;
  } finally {
    clearInterval(leaseTimer); signal.removeEventListener("abort", close); close();
    await Promise.allSettled([...active]); sockets.close();
    if (inode !== undefined && await lstat(path, { bigint: true }).then(info => String(info.ino) === inode && String(info.dev) === device, () => false)) await unlink(path).catch(() => {});
  }
}
