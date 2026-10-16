import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { writePrivateJson } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";

/** Why this build first saw the chat: a new chat, a fork, a resumed chat, or a sub-agent it spawned. */
export type GatewayChatOrigin = "start" | "fork" | "started" | "subagent";
export interface GatewayChat { id: string; atMs: number; origin: GatewayChatOrigin }

/** How many chats the registry holds; the oldest stamps leave first. */
export const gatewayChatMaxEntries = 65536;
/**
 * What a registry file may weigh, checked before it is read. Codex chat ids are about 40 characters, so a registry at the
 * entry cap is roughly 7 MB and this leaves room to spare; the cap on entries is what governs. A file past this size is
 * one this class never wrote (only an id of some 450 characters or more could make it), so it is refused as unsafe.
 */
const maxBytes = 32 * 1024 * 1024;
const originNames = new Set<string>(["start", "fork", "started", "subagent"]);
const invalid = () => new Error("Gateway chat registry is invalid or unsafe");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0");
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
  if (others.length < dropped) throw invalid();
  return [...others.slice(dropped), list.find(chat => chat.id === keep)!].sort(byStamp);
}

/**
 * Which chats the gateway itself started, kept apart from native configuration, authentication, and history so a router
 * can tell a gateway chat from a native one without reading either. It holds ids and times only, never a model name,
 * a prompt, or a tool argument. One file per native home, so a second Codex installation keeps its own list.
 */
export class GatewayChatRegistry {
  private readonly directory: string;
  private readonly path: string;
  private readonly cap: number;
  private reported = false;
  constructor(stateDirectory: string, nativeHome: string, private readonly onUnreadable?: () => void, maxEntries = gatewayChatMaxEntries) {
    if (!integer(maxEntries) || maxEntries < 1) throw invalid();
    this.directory = join(resolve(stateDirectory), "gateway-chats");
    const scope = createHash("sha256").update(resolve(nativeHome)).digest("hex").slice(0, 16);
    this.path = resolve(this.directory, `${scope}.json`);
    this.cap = maxEntries;
  }
  private async checkDirectory(): Promise<void> {
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o022)))) throw invalid();
  }
  /** A missing file is an empty registry, not a failure. Anything else that cannot be trusted is reported once and read as empty. */
  private async load(): Promise<Map<string, GatewayChat>> {
    let file;
    try {
      await this.checkDirectory();
      file = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const info = await file.stat();
      if (!info.isFile() || info.size > maxBytes || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600))) throw invalid();
      // One extra byte detects growth without allowing an unbounded allocation or read.
      const bytes = Buffer.alloc(info.size + 1); let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > info.size) throw invalid();
      return snapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      this.report();
      return new Map();
    } finally { await file?.close(); }
  }
  /** `gateway_registry_unreadable`: the caller reports it, and one broken read per registry is enough to know. */
  private report(): void {
    if (this.reported) return;
    this.reported = true;
    this.onUnreadable?.();
  }
  /** Remembers a chat. The record is on disk when the promise resolves; a repeat of an id keeps the newest stamp. */
  async record(id: string, origin: GatewayChatOrigin, atMs = Date.now()): Promise<void> {
    if (!text(id) || !originNames.has(origin) || !integer(atMs)) throw invalid();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkDirectory();
    await withPrivateFileLock(this.path, async () => {
      // A directory or a device in the file's place is not ours to clear, and renaming over one would fail and leave a
      // temporary file behind. A link is a path we own, so the atomic rename below simply replaces it.
      const where = await lstat(this.path).catch(() => undefined);
      if (where && !where.isFile() && !where.isSymbolicLink()) throw invalid();
      const chats = await this.load();
      // An event no newer than what is stored neither moves the stamp nor changes the origin recorded with it.
      if ((chats.get(id)?.atMs ?? -1) < atMs) chats.set(id, { id, atMs, origin });
      await writePrivateJson(this.path, { version: 1, chats: makeRoom(chats, id, this.cap) });
    });
  }
  async has(id: string): Promise<boolean> {
    return text(id) && (await this.load()).has(id);
  }
  /** The whole list as a set, for a classifier that answers in one pass without reading the file per chat. */
  async snapshot(): Promise<ReadonlySet<string>> {
    return new Set((await this.load()).keys());
  }
}
