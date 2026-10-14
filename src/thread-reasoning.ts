import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { writePrivateJson } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";

/** The reasoning a chat last ran with, kept so a reload can restore it. */
export interface ThreadReasoning { model: string; effort: string; summary?: string; atMs: number }
export interface ThreadReasoningSelection { model: string; effort?: string | null; summary?: string | null; atMs: number }
interface Snapshot { version: 1; threads: Record<string, ThreadReasoning> }

const maxBytes = 4 * 1024 * 1024; const maxThreads = 16384;
const summaries = new Set(["auto", "concise", "detailed", "none"]);
export const isReasoningEffort = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
export const isReasoningSummary = (value: unknown): value is string => typeof value === "string" && summaries.has(value);
export const isModelName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0");

const invalid = () => new Error("Private thread reasoning store is invalid or unsafe");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const fields = (value: Record<string, unknown>, keys: string[], optional: string[] = []) => keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key));

function row(value: unknown): ThreadReasoning {
  if (!object(value) || !fields(value, ["model", "effort", "atMs"], ["summary"]) || !isModelName(value.model)) throw invalid();
  if (!isReasoningEffort(value.effort) || !integer(value.atMs)) throw invalid();
  if (Object.hasOwn(value, "summary") && !isReasoningSummary(value.summary)) throw invalid();
  return { model: value.model, effort: value.effort, ...(isReasoningSummary(value.summary) ? { summary: value.summary } : {}), atMs: Number(value.atMs) };
}

function snapshot(value: unknown): Snapshot {
  if (!object(value) || !fields(value, ["version", "threads"]) || value.version !== 1 || !object(value.threads)) throw invalid();
  const entries = Object.entries(value.threads);
  if (entries.length > maxThreads) throw invalid();
  const threads: Record<string, ThreadReasoning> = Object.create(null);
  for (const [id, entry] of entries) { if (!isModelName(id)) throw invalid(); threads[id] = row(entry); }
  return { version: 1, threads };
}

/** Private per-chat reasoning, isolated from native configuration and authentication. */
export class ThreadReasoningStore {
  private readonly directory: string;
  private readonly path: string;
  constructor(stateDirectory: string, nativeHome: string) {
    this.directory = resolve(stateDirectory);
    const scope = createHash("sha256").update(resolve(nativeHome)).digest("hex").slice(0, 16);
    this.path = resolve(this.directory, `desktop-thread-reasoning-${scope}.json`);
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
  async read(threadId: string): Promise<ThreadReasoning | undefined> {
    if (!isModelName(threadId)) throw invalid();
    return (await this.load()).threads[threadId];
  }
  /** The newest observation wins; an unknown effort or summary never erases a saved one for the same model. */
  async write(threadId: string, value: ThreadReasoningSelection): Promise<boolean> {
    if (!isModelName(threadId) || !object(value) || !isModelName(value.model) || !integer(value.atMs)) throw invalid();
    if (value.effort !== undefined && value.effort !== null && !isReasoningEffort(value.effort)) throw invalid();
    if (value.summary !== undefined && value.summary !== null && !isReasoningSummary(value.summary)) throw invalid();
    const effort = value.effort ?? undefined; const summary = value.summary ?? undefined;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkDirectory();
    return withPrivateFileLock(this.path, async () => {
      const saved = await this.load(); const current = saved.threads[threadId];
      if (current && current.atMs >= value.atMs) return false;
      // A selection for another model says nothing about this one, so nothing carries over.
      const carried = current && current.model === value.model ? current : undefined;
      const keptEffort = effort ?? carried?.effort;
      if (!keptEffort) return false;
      const keptSummary = summary ?? carried?.summary;
      const selected: ThreadReasoning = { model: value.model, effort: keptEffort, ...(keptSummary ? { summary: keptSummary } : {}), atMs: value.atMs };
      if (current && current.model === selected.model && current.effort === selected.effort && current.summary === selected.summary) return true;
      if (!current) {
        // A bounded store drops the chats observed longest ago.
        while (Object.keys(saved.threads).length >= maxThreads) {
          let oldest: string | undefined; let atMs = Number.POSITIVE_INFINITY;
          for (const [id, entry] of Object.entries(saved.threads)) if (entry.atMs < atMs) { atMs = entry.atMs; oldest = id; }
          if (oldest === undefined) throw invalid();
          delete saved.threads[oldest];
        }
      }
      saved.threads[threadId] = selected;
      if (Buffer.byteLength(JSON.stringify(saved, null, 2) + "\n") > maxBytes) throw invalid();
      await writePrivateJson(this.path, saved);
      return true;
    });
  }
}
