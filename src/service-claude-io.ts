import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { canonicalPath } from "./app-background.js";

/** Strict private-file helpers for the Claude consolidation: no symlinks, bounded reads, owned and unshared ancestors. */
export type Plist = Record<string, unknown>;
export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const randomId = (): string => randomBytes(8).toString("hex");
export class UnsafeFile extends Error {}

const noFollow = constants.O_NOFOLLOW ?? 0;
interface DirectoryInfo { isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number | bigint }

function safeDirectory(info: DirectoryInfo): boolean {
  const mode = Number(info.mode); const me = process.getuid?.();
  return info.isDirectory() && !info.isSymbolicLink() && (info.uid === me || info.uid === 0) && (!(mode & 0o022) || (info.uid === 0 && !!(mode & 0o1000)));
}

/** Every ancestor must be a real directory owned by this user or root and not writable by others (a root sticky directory excepted). A missing ancestor rejects with ENOENT. */
export async function assertSafeAncestors(directory: string): Promise<void> {
  let checked: string;
  try { checked = await canonicalPath(resolve(directory)); } catch { throw new UnsafeFile("Unsafe directory ancestry"); }
  let current: string = sep;
  for (const part of checked.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!safeDirectory(await lstat(current))) throw new UnsafeFile("Unsafe directory ancestry");
  }
}

export interface FileRead { bytes: Buffer; mode: number }
/**
 * Reads one regular file without following a link. Returns undefined only when it (or an ancestor) is absent; every other
 * problem throws. `privateOnly` additionally forbids any group or world access.
 */
export async function readRegularFile(path: string, limit: number, privateOnly: boolean): Promise<FileRead | undefined> {
  try { await assertSafeAncestors(dirname(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  let file;
  try { file = await open(path, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new UnsafeFile("Cannot safely open a Claude consolidation file"); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & (privateOnly ? 0o077 : 0o022)) || info.size > limit) {
      throw new UnsafeFile("A Claude consolidation file is not a private regular file");
    }
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, limit + 1, 0);
    if (bytesRead > limit || bytesRead !== info.size) throw new UnsafeFile("A Claude consolidation file changed while it was read");
    const visible = await lstat(path);
    if (visible.dev !== info.dev || visible.ino !== info.ino) throw new UnsafeFile("A Claude consolidation file was replaced while it was read");
    return { bytes: Buffer.from(buffer.subarray(0, bytesRead)), mode: info.mode & 0o777 };
  } finally { await file.close(); }
}

/** `rename` (or exclusive `link`) is the commit point; nothing fallible but the directory sync follows, and that is ignored. */
export async function atomicWrite(path: string, data: Uint8Array | string, mode = 0o600, exclusive = false): Promise<void> {
  await assertSafeAncestors(dirname(path));
  const temporary = `${path}.${randomId()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, "wx", mode);
    await file.chmod(mode); await file.writeFile(data); await file.sync(); await file.close(); file = undefined;
  } catch (error) { await file?.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
  try { if (exclusive) await link(temporary, path); else await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  if (exclusive) await unlink(temporary).catch(() => {});
  try { const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); } } catch { /* Already committed. */ }
}

/**
 * Whether a component can open `log` as a private file: its parent is absent (the supervisor creates it mode 0700 below a
 * safe ancestor) or a private owned directory, and the log is absent or a private owned regular file with one link.
 */
export async function logDestinationSafe(log: string): Promise<boolean> {
  try {
    const parent = dirname(log); const me = process.getuid?.();
    let parentInfo;
    try { parentInfo = await lstat(parent); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      await assertSafeAncestors(dirname(parent));
      return true;
    }
    await assertSafeAncestors(dirname(parent));
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== me || (parentInfo.mode & 0o077)) return false;
    let info;
    try { info = await lstat(log); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
    return info.isFile() && !info.isSymbolicLink() && info.uid === me && info.nlink === 1 && !(info.mode & 0o077);
  } catch { return false; }
}

/** Creates (or accepts) a private directory directly below an existing safe parent. */
export async function ensurePrivateDirectory(path: string, exclusive = false): Promise<void> {
  await assertSafeAncestors(dirname(path));
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || exclusive) throw error; }
  const info = await lstat(path);
  if (!safeDirectory(info) || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new UnsafeFile("Claude consolidation backups must be private");
}

/** Decodes a property list through plutil, bounded in size and time. */
export function decodePlistWithPlutil(bytes: Buffer): Promise<Plist> {
  return new Promise((done, reject) => {
    if (bytes.length > 65536) { reject(new Error("plist")); return; }
    const child = spawn("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { stdio: ["pipe", "pipe", "ignore"] });
    const output: Buffer[] = []; let size = 0; let settled = false;
    const fail = () => { if (!settled) { settled = true; clearTimeout(timer); child.kill("SIGKILL"); reject(new Error("plist")); } };
    const timer = setTimeout(fail, 5000);
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 65536) fail(); else output.push(chunk); });
    child.once("error", fail); child.stdin.once("error", fail);
    child.once("close", code => {
      clearTimeout(timer); if (settled) return; settled = true;
      try {
        if (code !== 0) throw new Error("plist");
        const value: unknown = JSON.parse(Buffer.concat(output).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plist");
        done(value as Plist);
      } catch { reject(new Error("plist")); }
    });
    child.stdin.end(bytes);
  });
}
