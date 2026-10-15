import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { writePrivateJson } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";

export interface ThreadServiceTier { model: string; serviceTier: string | null; revision?: number; emittedAtMs?: number; uncertainBeforeMs?: number }
interface Snapshot { version: 1; threads: Record<string, ThreadServiceTier> }
const maxBytes = 4 * 1024 * 1024; const maxThreads = 16384;
const invalid = () => new Error("Private thread tier store is invalid or unsafe");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0");
const fields = (value: Record<string, unknown>, keys: string[], optional: string[] = []) => keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key));
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function row(value: unknown): ThreadServiceTier {
  if (!object(value) || !fields(value, ["model", "serviceTier"], ["revision", "emittedAtMs", "uncertainBeforeMs"]) || !text(value.model)) throw invalid();
  const tier = value.serviceTier;
  if (tier !== null && (typeof tier !== "string" || !/^[a-z][a-z0-9_-]{0,127}$/.test(tier) || tier === "auto")) throw invalid();
  for (const key of ["revision", "emittedAtMs", "uncertainBeforeMs"]) if (Object.hasOwn(value, key) && !integer(value[key])) throw invalid();
  return { model: value.model, serviceTier: tier === "fast" ? "priority" : tier === "default" || tier === "standard" ? null : tier,
    ...(Object.hasOwn(value, "revision") ? { revision: Number(value.revision) } : {}), ...(Object.hasOwn(value, "emittedAtMs") ? { emittedAtMs: Number(value.emittedAtMs) } : {}),
    ...(Object.hasOwn(value, "uncertainBeforeMs") ? { uncertainBeforeMs: Number(value.uncertainBeforeMs) } : {}) };
}

function snapshot(value: unknown): Snapshot {
  if (!object(value) || !fields(value, ["version", "threads"]) || value.version !== 1 || !object(value.threads)) throw invalid();
  const entries = Object.entries(value.threads);
  if (entries.length > maxThreads) throw invalid();
  const threads: Record<string, ThreadServiceTier> = Object.create(null);
  for (const [id, value] of entries) { if (!text(id)) throw invalid(); threads[id] = row(value); }
  return { version: 1, threads };
}

const serializedBytes = (value: Snapshot): number => Buffer.byteLength(JSON.stringify(value, null, 2) + "\n");
/** What dropping one row saves in the indented file: its lines plus the separator after it (the file always keeps the row being written). */
const rowBytes = (id: string, entry: ThreadServiceTier): number =>
  Buffer.byteLength("    " + JSON.stringify(id) + ": " + JSON.stringify(entry, null, 2).replace(/\n/g, "\n    ") + ",\n");
/** Other chats from oldest to newest record time; rows that were never stamped go first. */
const evictionOrder = (threads: Record<string, ThreadServiceTier>, keep: string): Array<[string, ThreadServiceTier]> =>
  Object.entries(threads).filter(([id]) => id !== keep).sort((a, b) => (a[1].emittedAtMs ?? -1) - (b[1].emittedAtMs ?? -1));

/** Private chat metadata, isolated from native configuration, authentication, and history. */
export class ThreadServiceTiers {
  private readonly directory: string;
  private readonly path: string;
  constructor(stateDirectory: string, nativeHome: string) {
    this.directory = resolve(stateDirectory);
    const scope = createHash("sha256").update(resolve(nativeHome)).digest("hex").slice(0, 16);
    this.path = resolve(this.directory, `desktop-thread-tiers-${scope}.json`);
  }
  private async checkDirectory(): Promise<void> {
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o022)))) throw invalid();
  }
  private async load(): Promise<Snapshot> {
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, threads: Object.create(null) };
      throw invalid();
    } finally { await file?.close(); }
  }
  /** Keeps the serialized store within its byte limit by dropping other chats, never the one just written. */
  private evictForSize(saved: Snapshot, keep: string): void {
    let over = serializedBytes(saved) - maxBytes;
    if (over <= 0) return;
    const oldest = evictionOrder(saved.threads, keep); let next = 0;
    while (over > 0) {
      if (next >= oldest.length) throw invalid();
      // Each row's exact indented size is counted, so this drops no more than needed; the
      // serialization below is the final check and the loop only repeats if it is still over.
      let freed = 0;
      do { const [id, entry] = oldest[next++]; freed += rowBytes(id, entry); delete saved.threads[id]; } while (freed < over && next < oldest.length);
      over = serializedBytes(saved) - maxBytes;
    }
  }
  async read(threadId: string): Promise<ThreadServiceTier | undefined> {
    if (!text(threadId)) throw invalid();
    const value = (await this.load()).threads[threadId];
    return value ? { ...value, revision: value.revision ?? 0 } : undefined;
  }
  /** SDK snapshots use revision CAS; notifications use their source time and uncertainty watermark. */
  async write(threadId: string, value: ThreadServiceTier, expected?: ThreadServiceTier | null, confirmedSnapshotAtMs?: number): Promise<boolean> {
    if (!text(threadId) || (confirmedSnapshotAtMs !== undefined && !integer(confirmedSnapshotAtMs))) throw invalid();
    const selected = row(value); const previous = expected === undefined || expected === null ? expected : row(expected);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkDirectory();
    return withPrivateFileLock(this.path, async () => {
      const saved = await this.load(); const current = saved.threads[threadId];
      if (selected.emittedAtMs === undefined && previous !== undefined && (previous === null ? !!current : !current || current.model !== previous.model || current.serviceTier !== previous.serviceTier ||
        (previous.revision !== undefined && (current.revision ?? 0) !== previous.revision) || (previous.emittedAtMs !== undefined && current.emittedAtMs !== previous.emittedAtMs) ||
        (previous.uncertainBeforeMs !== undefined && current.uncertainBeforeMs !== previous.uncertainBeforeMs))) return false;
      let emittedAtMs = current?.emittedAtMs;
      let uncertainBeforeMs = selected.uncertainBeforeMs === undefined ? current?.uncertainBeforeMs : Math.max(current?.uncertainBeforeMs ?? 0, selected.uncertainBeforeMs);
      if (selected.emittedAtMs === undefined && confirmedSnapshotAtMs !== undefined) {
        if (emittedAtMs !== undefined && emittedAtMs - confirmedSnapshotAtMs > 1000) {
          uncertainBeforeMs = Math.max(uncertainBeforeMs ?? 0, emittedAtMs); emittedAtMs = confirmedSnapshotAtMs;
        } else emittedAtMs = Math.max(emittedAtMs ?? 0, confirmedSnapshotAtMs);
      }
      if (selected.emittedAtMs !== undefined) {
        if (uncertainBeforeMs !== undefined && selected.emittedAtMs <= uncertainBeforeMs && selected.serviceTier !== null) return false;
        if (emittedAtMs !== undefined && selected.emittedAtMs < emittedAtMs) return false;
        if (current && selected.emittedAtMs === emittedAtMs && (selected.model !== current.model || selected.serviceTier !== current.serviceTier)) {
          if (current.serviceTier === null && selected.serviceTier !== null) return false;
          // Ambiguous non-Standard ties retain the current model and resolve speed to Standard.
          if (current.serviceTier !== null && selected.serviceTier !== null) { selected.model = current.model; selected.serviceTier = null; }
        }
        emittedAtMs = selected.emittedAtMs;
      }
      if (current && current.model === selected.model && current.serviceTier === selected.serviceTier && current.emittedAtMs === emittedAtMs && current.uncertainBeforeMs === uncertainBeforeMs) return true;
      if (!current) {
        // A full store drops the chat whose record was stamped longest ago, like the reasoning store.
        if (Object.keys(saved.threads).length >= maxThreads) {
          const oldest = evictionOrder(saved.threads, threadId); let next = 0;
          while (Object.keys(saved.threads).length >= maxThreads) {
            if (next >= oldest.length) throw invalid();
            delete saved.threads[oldest[next++][0]];
          }
        }
      }
      const revision = (current?.revision ?? 0) + 1; if (!integer(revision)) throw invalid();
      saved.threads[threadId] = { model: selected.model, serviceTier: selected.serviceTier, revision, ...(emittedAtMs !== undefined ? { emittedAtMs } : {}), ...(uncertainBeforeMs !== undefined ? { uncertainBeforeMs } : {}) };
      this.evictForSize(saved, threadId);
      await writePrivateJson(this.path, saved);
      return true;
    });
  }
}
