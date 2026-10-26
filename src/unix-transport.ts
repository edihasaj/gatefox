import { createServer } from "node:http";
import { mkdir, lstat, chmod, link, unlink, rename, readFile, open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import type { Message } from "./app-server-connection.js";
import { writePrivateJson } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { releasePattern, releaseState } from "./self-update.js";
import { ownerStamp } from "./boot-identity.js";
import { isManagedSshSocket, previousLease, repairSshLease, sweepSshLeftovers, type SshLeasePrevious, type SshSocketReplacement } from "./ssh-socket.js";
import { DEVICE_HEADER, isDevicePseudonym } from "./ssh-proxy-header.js";
import { telemetry } from "./telemetry.js";

/** What the process owning a listener uses to retire it after an install. */
export interface UnixListenerControl {
  /** WebSocket sessions running now; a listener with sessions must keep serving them. */
  sessions(): number;
  /** Stop taking new sessions, so the listener finishes what it has and serves nothing new, and
   * drop the public alias while this listener owns it. A false return means the alias was already
   * gone or belonged to another listener: this one retires either way, but it moved nothing, so
   * the caller must not log a self upgrade for it. */
  retire(): Promise<boolean>;
}

/**
 * A publish failed before the rename: put the ownership record back as it was, then drop the
 * staged link. The link goes only once the record reads as it did before. While the record still
 * names the listener that failed to publish, the staged link is what lets the next bootstrap
 * recognise the half-finished swap and repair it, so it must not be removed first.
 */
async function abandonPublish(leasePath: string, staged: string, before: string | undefined): Promise<void> {
  const current = () => readFile(leasePath, "utf8").catch(() => undefined);
  if (await current() !== before) {
    if (before === undefined) await unlink(leasePath).catch(() => {});
    else await writeRecord(leasePath, before).catch(() => {});
  }
  if (await current() === before) await unlink(staged).catch(() => {});
}

/** Replace a private record with exact text, through a temporary file and a rename. */
async function writeRecord(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
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
 * the listener can watch for an install and retire it; see `codex-shim`. Its second argument
 * reports whether the publish dropped a listener this call was told to replace.
 * `replace` carries a deferred swap decided by `reuseSshSocket`: the public alias currently
 * held by another listener, which an atomic rename may replace, but only inside the publish
 * lock below, so nothing is displaced unless this process actually binds and publishes its own socket.
 */
export async function serveUnix(path: string, signal: AbortSignal,
  session: (input: Readable, emit: (message: Message) => Promise<void>, signal: AbortSignal) => Promise<unknown>,
  release: string | null | undefined = releaseState()?.running,
  onListen?: (listener: UnixListenerControl, replaced: boolean) => void,
  replace?: SshSocketReplacement): Promise<void> {
  const occupied = () => new Error("Unix socket path is occupied; the existing listener was not replaced");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o022)) throw new Error("Unix socket directory must be owned by this user and not writable by others");
  // A pending replacement may keep an existing alias: serve it to the check under the publish
  // lock, which verifies the inode/device, socket kind, and ownership before renaming over it.
  try { const alias = await lstat(path, { bigint: true }); if (!replace || String(alias.ino) !== replace.inode || String(alias.dev) !== replace.device) throw occupied(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Node unlinks its bind path on close. Bind privately, then expose a hard link
  // so retiring this listener cannot unlink a newer desktop bootstrap's socket.
  const boundPath = unixSocketPath("unix://" + resolve(dirname(path), `.gw-${randomBytes(6).toString("hex")}`));
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
  const active = new Set<Promise<unknown>>(); const shutdowns = new Set<() => void>(); let sessionSequence = 0;
  let retiring = false; let leaseTimer: NodeJS.Timeout | undefined; let inode: string | undefined; let device: string | undefined;
  server.on("upgrade", (req, socket, head) => {
    if (retiring || signal.aborted || active.size >= 8 || req.headers.origin || !["/", "/rpc"].includes(req.url || "")) { socket.destroy(); return; }
    const supplied: string[] = [];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index].toLowerCase() === DEVICE_HEADER) supplied.push(req.rawHeaders[index + 1] || "");
    }
    const clientDevice = supplied.length === 1 && isDevicePseudonym(supplied[0]) ? supplied[0] : undefined;
    sockets.handleUpgrade(req, socket, head, ws => {
      const control = new AbortController(); const sessionId = ++sessionSequence, started = performance.now();
      let cause: "transport_closed" | "socket_error" | "binary_frame" | "output_limit" | "session_failed" | "session_ended" | "listener_shutdown" | undefined;
      const input = new Readable({ read() { ws.resume(); } });
      const shutdown = () => { cause ??= "listener_shutdown"; control.abort(); input.destroy(); }; shutdowns.add(shutdown);
      ws.on("error", () => { cause ??= "socket_error"; control.abort(); input.destroy(); });
      ws.on("close", closeCode => {
        cause ??= "transport_closed";
        telemetry("unix_session_end", { sessionId, cause, closeCode, durationMs: performance.now() - started });
        control.abort(); input.destroy();
      });
      ws.on("message", (data, binary) => {
        if (binary) { cause ??= "binary_frame"; ws.close(1003, "Text JSON-RPC frames required"); return; }
        if (!input.push(Buffer.concat([Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), Buffer.from("\n")]))) ws.pause();
      });
      // This private, post-upgrade notification is not a WebSocket frame supplied by the client.
      // It gives shimSession the same first-message contract without corrupting the native handshake.
      if (clientDevice) input.push(Buffer.from(JSON.stringify({ method: "gateway/client", params: { device: clientDevice } }) + "\n"));
      const emit = (message: Message) => new Promise<void>((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) { reject(new Error("Unix client disconnected")); return; }
        if (ws.bufferedAmount > 16 * 1024 * 1024) { cause ??= "output_limit"; ws.close(1009, "Client output queue exceeded"); reject(new Error("Unix client output queue exceeded")); return; }
        ws.send(JSON.stringify(message), error => error ? reject(error) : resolve());
      });
      const task = session(input, emit, control.signal).catch(() => { cause ??= "session_failed"; ws.close(1011, "Gateway connection failed"); })
        .finally(() => { cause ??= "session_ended"; shutdowns.delete(shutdown); active.delete(task); input.destroy(); ws.terminate(); if (retiring && !active.size) close(); });
      active.add(task);
    });
  });
  const close = () => { for (const shutdown of shutdowns) shutdown(); for (const ws of sockets.clients) ws.terminate(); server.close(); };
  const retire = async () => {
    // Under the lock a bootstrap also takes, so a newer listener's alias is never removed here.
    // `gone`: the alias is already another listener's or was removed. `held`: the lock or the
    // unlink failed, so the alias may still be ours.
    const alias = await withPrivateFileLock(path + ".gateway-lease", async () => {
      const current = await lstat(path, { bigint: true }).catch(() => undefined);
      if (!current || String(current.ino) !== inode || String(current.dev) !== device) return "gone" as const;
      return await unlink(path).then(() => "dropped" as const, () => "held" as const);
    }).catch(() => "held" as const);
    // A failed attempt claims nothing: the alias is left as it was so the watcher tries again later.
    if (alias === "held") return false;
    // Whether this listener dropped its own alias or a bootstrap had already dropped it, it stops
    // serving from now on. `gone` reports false, because the move belongs to whoever replaced it:
    // a bootstrap logs that as `ssh_listener_replaced`, and an idle listener must not log the same
    // replacement again as `self_upgrade` once its own upgrade watcher gets to it.
    retiring = true; if (!active.size) close();
    return alias === "dropped";
  };
  try {
    server.listen(boundPath); await once(server, "listening"); await chmod(boundPath, 0o600);
    const bound = await lstat(boundPath, { bigint: true }); inode = String(bound.ino); device = String(bound.dev);
    let replaced = false;
    // Asked before the lock is taken: it may run `ps`. A machine that cannot answer records fewer fields, never a guess.
    const stamp = await ownerStamp();
    await withPrivateFileLock(path + ".gateway-lease", async () => {
      // The atomic swap: the retired listener's alias is replaced here, never before this lock, so
      // a bind that fails for any other reason leaves the old listener published and serving.
      const alias = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (alias) {
        if (!replace || String(alias.ino) !== replace.inode || String(alias.dev) !== replace.device
          || !alias.isSocket() || alias.uid !== BigInt(process.getuid!())) throw occupied();
        replaced = true;
      }
      // Stage the new alias beside the old one and rename it over the old one, so the public
      // path never stops resolving: a client connecting mid-swap reaches the old listener or the
      // new one, never ENOENT. The ownership record is written before the rename, because the
      // alias is the readiness signal and a reader must find the record as soon as it appears.
      // The release name is capped, so the record stays well under the 4096 byte limit readers enforce.
      const leasePath = path + ".gateway-lease"; const staged = boundPath + ".alias";
      // A swap a crashed bootstrap left half done is repaired first: the record then names the real
      // owner of the alias, which the sweep below must not destroy the evidence for, and which
      // `before` and `previous` below must describe. A failed repair stops the publish for the same reason.
      if (alias) await repairSshLease(path);
      // What crashed bootstraps left behind never blocks this one; a failure here is not a reason to stop.
      // Only an SSH listener sweeps: a pending replacement, or the managed control folder. A custom
      // `--listen` socket shares its folder with nothing of ours, and must never remove another alias's files.
      if (replace || isManagedSshSocket(path)) await sweepSshLeftovers(path, [basename(boundPath)]).catch(() => {});
      const before = await readFile(leasePath, "utf8").catch(() => undefined);
      // The record of the listener being displaced rides inside the new one. If this process dies
      // between the two steps below, the alias is still the old listener's while the record names
      // this one, and the next bootstrap uses `previous` to recognise that and repair it.
      const displaced: SshLeasePrevious | undefined = alias ? previousLease(before, dirname(path), alias) : undefined;
      await link(boundPath, staged);
      try {
        await writePrivateJson(leasePath,
          { inode, device, boundPath, ...(typeof release === "string" && releasePattern.test(release) ? { release } : {}), ...stamp, pid: process.pid, ...(displaced ? { previous: displaced } : {}) });
        await rename(staged, path);
      } catch (error) {
        await abandonPublish(leasePath, staged, before);
        throw error;
      }
    });
    onListen?.({ sessions: () => active.size, retire }, replaced);
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
    // Under the same lock as retire() and the publish, so the alias is never removed from between
    // a newer listener's check and its own swap.
    if (inode !== undefined) await withPrivateFileLock(path + ".gateway-lease", async () => {
      if (await lstat(path, { bigint: true }).then(info => String(info.ino) === inode && String(info.dev) === device, () => false)) await unlink(path).catch(() => {});
    }).catch(() => {});
  }
}
