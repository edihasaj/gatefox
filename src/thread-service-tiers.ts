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

/**
 * A chat whose tier the SDK kept but the store cannot hold ("auto", "Fast", a long id) has an unknown tier. It is
 * recorded as a marker row under this separate key and the chat's own row is removed. Both are ordinary rows, so a
 * 0.4.0 build still reads the whole file; it never looks the marker up and sees the chat as having no record,
 * which is exactly an unknown tier. The marker also holds the watermark that keeps an older notification from
 * bringing a tier back.
 */
const markerKey = (threadId: string) => `tier-unknown:${createHash("sha256").update(threadId).digest("hex")}`;
/** A pending record. An undefined tier means unknown. */
interface Pending { model: string; serviceTier: string | null | undefined; emittedAtMs?: number; uncertainBeforeMs?: number }
interface ChatState { live?: ThreadServiceTier; marker?: ThreadServiceTier; unknown: boolean; known?: ThreadServiceTier; base?: ThreadServiceTier }
/** The newer of the chat's own row and its marker wins; a tie is unknown, which forwards no tier. */
function chatState(saved: Snapshot, threadId: string): ChatState {
  const live = saved.threads[threadId]; const marker = saved.threads[markerKey(threadId)];
  const unknown = !!marker && (!live || (marker.emittedAtMs ?? 0) >= (live.emittedAtMs ?? 0));
  return { live, marker, unknown, known: unknown ? undefined : live, base: unknown ? marker : live };
}

/** Whether the private store can hold this tier. The SDK keeps other strings ("auto", "Fast", a long value) that the store rejects. */
export const storableServiceTier = (tier: unknown): tier is string | null => tier === null || (typeof tier === "string" && /^[a-z][a-z0-9_-]{0,127}$/.test(tier) && tier !== "auto");

function row(value: unknown): ThreadServiceTier {
  if (!object(value) || !fields(value, ["model", "serviceTier"], ["revision", "emittedAtMs", "uncertainBeforeMs"]) || !text(value.model)) throw invalid();
  const tier = value.serviceTier;
  if (!storableServiceTier(tier)) throw invalid();
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
  async read(threadId: string): Promise<ThreadServiceTier | undefined> {
    if (!text(threadId)) throw invalid();
    const value = chatState(await this.load(), threadId).known;
    return value ? { ...value, revision: value.revision ?? 0 } : undefined;
  }
  /** SDK snapshots use revision CAS; notifications use their source time and uncertainty watermark. */
  async write(threadId: string, value: ThreadServiceTier, expected?: ThreadServiceTier | null, confirmedSnapshotAtMs?: number): Promise<boolean> {
    if (!text(threadId) || (confirmedSnapshotAtMs !== undefined && !integer(confirmedSnapshotAtMs))) throw invalid();
    const selected = row(value); const previous = expected === undefined || expected === null ? expected : row(expected);
    return this.apply(threadId, selected, previous, confirmedSnapshotAtMs);
  }
  /**
   * Records that the chat's tier is unknown, through the same locked, timestamp-ordered path as a known tier. The
   * chat's own row is removed, so a later session start forwards no tier, and an older notification stays rejected.
   */
  async markUnknown(threadId: string, value: { model: string; emittedAtMs?: number }, expected?: ThreadServiceTier | null, confirmedSnapshotAtMs?: number): Promise<boolean> {
    if (!text(threadId) || !text(value.model) || (value.emittedAtMs !== undefined && !integer(value.emittedAtMs)) || (confirmedSnapshotAtMs !== undefined && !integer(confirmedSnapshotAtMs))) throw invalid();
    const previous = expected === undefined || expected === null ? expected : row(expected);
    return this.apply(threadId, { model: value.model, serviceTier: undefined, ...(value.emittedAtMs !== undefined ? { emittedAtMs: value.emittedAtMs } : {}) }, previous, confirmedSnapshotAtMs);
  }
  private async apply(threadId: string, selected: Pending, previous: ThreadServiceTier | null | undefined, confirmedSnapshotAtMs?: number): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkDirectory();
    return withPrivateFileLock(this.path, async () => {
      const saved = await this.load(); const { live, marker, known, base } = chatState(saved, threadId);
      if (selected.emittedAtMs === undefined && previous !== undefined && (previous === null ? !!known : !known || known.model !== previous.model || known.serviceTier !== previous.serviceTier ||
        (previous.revision !== undefined && (known.revision ?? 0) !== previous.revision) || (previous.emittedAtMs !== undefined && known.emittedAtMs !== previous.emittedAtMs) ||
        (previous.uncertainBeforeMs !== undefined && known.uncertainBeforeMs !== previous.uncertainBeforeMs))) return false;
      // The chat's known tier; undefined while it is unknown or has no record.
      const currentTier = known?.serviceTier;
      let emittedAtMs = base?.emittedAtMs;
      let uncertainBeforeMs = selected.uncertainBeforeMs === undefined ? base?.uncertainBeforeMs : Math.max(base?.uncertainBeforeMs ?? 0, selected.uncertainBeforeMs);
      if (selected.emittedAtMs === undefined && confirmedSnapshotAtMs !== undefined) {
        if (emittedAtMs !== undefined && emittedAtMs - confirmedSnapshotAtMs > 1000) {
          uncertainBeforeMs = Math.max(uncertainBeforeMs ?? 0, emittedAtMs); emittedAtMs = confirmedSnapshotAtMs;
        } else emittedAtMs = Math.max(emittedAtMs ?? 0, confirmedSnapshotAtMs);
      }
      if (selected.emittedAtMs !== undefined) {
        if (uncertainBeforeMs !== undefined && selected.emittedAtMs <= uncertainBeforeMs && selected.serviceTier !== null) return false;
        if (emittedAtMs !== undefined && selected.emittedAtMs < emittedAtMs) return false;
        if (base && selected.emittedAtMs === emittedAtMs && (selected.model !== base.model || selected.serviceTier !== currentTier)) {
          if (currentTier === null && selected.serviceTier !== null) return false;
          // Ambiguous non-Standard ties, including an unknown tier, retain the current model and resolve speed to Standard.
          if (currentTier !== null && selected.serviceTier !== null) { selected.model = base.model; selected.serviceTier = null; }
        }
        emittedAtMs = selected.emittedAtMs;
      }
      if (base && base.model === selected.model && currentTier === selected.serviceTier && base.emittedAtMs === emittedAtMs && base.uncertainBeforeMs === uncertainBeforeMs) return true;
      if (!live && !marker && Object.keys(saved.threads).length >= maxThreads) throw invalid();
      // The revision never repeats across a swap between the chat's row and its marker, so a stale CAS cannot match.
      const revision = Math.max(live?.revision ?? 0, marker?.revision ?? 0) + 1; if (!integer(revision)) throw invalid();
      const next: ThreadServiceTier = { model: selected.model, serviceTier: selected.serviceTier ?? null, revision, ...(emittedAtMs !== undefined ? { emittedAtMs } : {}), ...(uncertainBeforeMs !== undefined ? { uncertainBeforeMs } : {}) };
      if (selected.serviceTier === undefined) { delete saved.threads[threadId]; saved.threads[markerKey(threadId)] = next; }
      else { saved.threads[threadId] = next; delete saved.threads[markerKey(threadId)]; }
      if (Buffer.byteLength(JSON.stringify(saved, null, 2) + "\n") > maxBytes) throw invalid();
      await writePrivateJson(this.path, saved);
      return true;
    });
  }
}
