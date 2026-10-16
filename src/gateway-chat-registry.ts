import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { withPrivateFileLock } from "./private-file-lock.js";

/** Why this build first saw the chat: a new chat, a fork, a resumed chat, or a sub-agent it spawned. */
export type GatewayChatOrigin = "start" | "fork" | "started" | "subagent";
export interface GatewayChat { id: string; atMs: number; origin: GatewayChatOrigin }

/** How many chats the registry holds; the oldest stamps leave first. */
export const gatewayChatMaxEntries = 65536;
/** The longest id the registry keeps. Codex chat ids are 36-character UUIDs, so this leaves room without letting the file balloon. */
export const gatewayChatMaxIdLength = 128;
/**
 * What a registry file may weigh, checked before it is read. A compact entry takes about 50 bytes plus its id, so a registry
 * at the entry cap is roughly 6 MB with Codex ids and under 12 MB with the longest id allowed; this leaves room to spare.
 * A file past this size is one this class never wrote, so it is read as unsafe.
 */
const maxBytes = 32 * 1024 * 1024;
const originNames = new Set<string>(["start", "fork", "started", "subagent"]);
const message = "Gateway chat registry is invalid or unsafe";
/** A caller, or a place on disk, the registry will not work with. Nothing here says the file's content is bad. */
const refused = () => new Error(message);
/** The file's own content cannot be trusted: not UTF-8 or JSON, the wrong shape, mode, owner or size, or a link. Read as empty, and a record sets it aside. */
class UnreadableContent extends Error { constructor() { super(message); } }
const invalid = () => new UnreadableContent();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= gatewayChatMaxIdLength && !value.includes("\0");
const fields = (value: Record<string, unknown>, keys: string[]) => keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key));
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** Chats are never keyed by anything a caller could hide model names or content in: id, time, and origin only. */
function entry(value: unknown): GatewayChat {
  if (!object(value) || !fields(value, ["id", "atMs", "origin"]) || !text(value.id) || !integer(value.atMs) || typeof value.origin !== "string" || !originNames.has(value.origin)) throw invalid();
  return { id: value.id, atMs: value.atMs, origin: value.origin as GatewayChatOrigin };
}
/** A repeated id folds onto its newest stamp; a longer list than the cap is not a file this class wrote. */
function snapshot(value: unknown): Map<string, GatewayChat> {
  if (!object(value) || !fields(value, ["version", "chats"]) || value.version !== 1 || !Array.isArray(value.chats) || value.chats.length > gatewayChatMaxEntries) throw invalid();
  const chats = new Map<string, GatewayChat>();
  for (const item of value.chats) { const chat = entry(item); const saved = chats.get(chat.id); if (!saved || saved.atMs <= chat.atMs) chats.set(chat.id, chat); }
  return chats;
}
/** Oldest first; a tie falls back to the id so a rewritten file keeps one stable order. */
const byStamp = (a: GatewayChat, b: GatewayChat): number => a.atMs - b.atMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Drops the oldest stamps until the registry fits `cap`, never the entry that was just written. */
function makeRoom(chats: Map<string, GatewayChat>, keep: string, cap: number): GatewayChat[] {
  const list = [...chats.values()].sort(byStamp);
  if (list.length <= cap) return list;
  const dropped = list.length - cap; const others = list.filter(chat => chat.id !== keep);
  if (others.length < dropped) throw refused();
  return [...others.slice(dropped), list.find(chat => chat.id === keep)!].sort(byStamp);
}

/** What one read of the registry file found. `bad` means the file is there but its content cannot be trusted; it reads as empty. */
interface Loaded { key: string; chats: Map<string, GatewayChat>; bad: boolean; ids?: Set<string> }
/** The stamp of a registry file that does not exist yet. */
const absent = "absent";
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
/** Writes compact JSON next to the target and renames it into place, so a reader sees the old file or the new one, never half. */
async function writeCompact(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path); await chmod(path, 0o600);
  } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

/**
 * Which chats the gateway itself started, kept apart from native configuration, authentication, and history so a router
 * can tell a gateway chat from a native one without reading either. It holds ids and times only, never a model name,
 * a prompt, or a tool argument. One file per native home, so a second Codex installation keeps its own list.
 *
 * Reads are cached per instance and keyed by the file's identity (device, inode, size, change and modify times), so a
 * lookup costs one `lstat` unless some writer, here or in another process, replaced the file. A file whose content is bad
 * reads as empty and is set aside as `<scope>.json.unreadable` (one copy) by the next record. A file that cannot be read for
 * any other reason (permissions, descriptor limits, I/O errors) reads as empty too, but a record then throws and writes
 * nothing, so a passing fault never costs the list.
 */
export class GatewayChatRegistry {
  private readonly directory: string;
  private readonly path: string;
  private readonly cap: number;
  private reported = false;
  private cache?: Loaded;
  constructor(stateDirectory: string, nativeHome: string, private readonly onUnreadable?: () => void, maxEntries = gatewayChatMaxEntries,
    /** The file opener, so a test can count reads or fail one. */ private readonly opener: typeof open = open) {
    if (!integer(maxEntries) || maxEntries < 1) throw refused();
    this.directory = join(resolve(stateDirectory), "gateway-chats");
    const scope = createHash("sha256").update(resolve(nativeHome)).digest("hex").slice(0, 16);
    this.path = resolve(this.directory, `${scope}.json`);
    this.cap = maxEntries;
  }
  private async checkDirectory(): Promise<void> {
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o022)))) throw refused();
  }
  /** Creates the folder private. One that exists is tightened when it is ours and refused when it is not. */
  private async secureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw refused();
    if (process.platform !== "win32") {
      if (info.uid !== process.getuid?.()) throw refused();
      if (info.mode & 0o077) await chmod(this.directory, 0o700);
    }
    await this.checkDirectory();
  }
  /** Who the file is right now, from one `lstat`. A missing file or folder is `absent`; any other failure is the caller's to handle. */
  private async stamp(): Promise<string> {
    try {
      await this.checkDirectory();
      const info = await lstat(this.path, { bigint: true });
      return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
    } catch (error) {
      if (code(error) === "ENOENT") return absent;
      throw error;
    }
  }
  /** The file's chats, from memory when its stamp is unchanged. Throws for anything that is not the content's fault. */
  private async read(): Promise<Loaded> {
    const key = await this.stamp();
    if (this.cache?.key === key) return this.cache;
    const loaded = key === absent ? { key, chats: new Map<string, GatewayChat>(), bad: false } : await this.parse(key);
    return (this.cache = loaded);
  }
  private async parse(key: string): Promise<Loaded> {
    const bad = (): Loaded => ({ key, chats: new Map(), bad: true });
    let file;
    try { file = await this.opener(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)); }
    catch (error) {
      if (code(error) === "ENOENT") return { key: absent, chats: new Map(), bad: false };
      if (code(error) === "ELOOP") return bad();
      throw error;
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxBytes || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600))) return bad();
      // One extra byte detects growth without allowing an unbounded allocation or read.
      const bytes = Buffer.alloc(info.size + 1); let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > info.size) return bad();
      try { return { key, chats: snapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)))), bad: false }; }
      catch { return bad(); }
    } finally { await file.close(); }
  }
  /** What a reader sees: the file's chats, or nothing at all when it cannot be trusted or read, reported once. */
  private async view(): Promise<Loaded> {
    try {
      const loaded = await this.read();
      if (loaded.bad) this.report();
      return loaded;
    } catch {
      this.cache = undefined;
      this.report();
      return { key: "", chats: new Map(), bad: false };
    }
  }
  /** `gateway_registry_unreadable`: the caller reports it, and one broken read per registry is enough to know. */
  private report(): void {
    if (this.reported) return;
    this.reported = true;
    this.onUnreadable?.();
  }
  /** Remembers a chat. The record is on disk when the promise resolves; a repeat of an id keeps the newest stamp. */
  async record(id: string, origin: GatewayChatOrigin, atMs = Date.now()): Promise<void> {
    if (!text(id) || !originNames.has(origin) || !integer(atMs)) throw refused();
    await this.secureDirectory();
    await withPrivateFileLock(this.path, async () => {
      // A directory or a device in the file's place is not ours to clear, and renaming over one would fail and leave a
      // temporary file behind. A link is a path we own, so the atomic rename below simply replaces it.
      const where = await lstat(this.path).catch(() => undefined);
      if (where && !where.isFile() && !where.isSymbolicLink()) throw refused();
      // A read that fails for any reason but the file's content ends the record here: nothing is overwritten on a guess.
      const loaded = await this.read();
      let chats = new Map(loaded.chats);
      if (loaded.bad) {
        this.report();
        // The bad file is kept for a look, one copy deep, instead of being overwritten.
        await rename(this.path, `${this.path}.unreadable`);
        this.cache = undefined; chats = new Map();
      }
      // An event no newer than what is stored neither moves the stamp nor changes the origin recorded with it.
      if ((chats.get(id)?.atMs ?? -1) < atMs) chats.set(id, { id, atMs, origin });
      const list = makeRoom(chats, id, this.cap);
      await writeCompact(this.path, { version: 1, chats: list });
      const next = list.length === chats.size ? chats : new Map(list.map(chat => [chat.id, chat] as const));
      this.cache = await this.stamp().then(key => ({ key, chats: next, bad: false }), () => undefined);
    });
  }
  async has(id: string): Promise<boolean> {
    return text(id) && (await this.view()).chats.has(id);
  }
  /** The whole list as a set, for a classifier that answers in one pass without reading the file per chat. */
  async snapshot(): Promise<ReadonlySet<string>> {
    const loaded = await this.view();
    return (loaded.ids ??= new Set(loaded.chats.keys()));
  }
  /** Brings the in-memory list up to date, so a router can refresh once per request and then ask `hasCached` with no I/O. */
  async refresh(): Promise<void> {
    await this.view();
  }
  /** Whether the list as of the last read, record or refresh holds the chat. Synchronous, and false before the first of those. */
  hasCached(id: string): boolean {
    return text(id) && !!this.cache && !this.cache.bad && this.cache.chats.has(id);
  }
}
