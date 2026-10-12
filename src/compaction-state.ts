import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { writePrivateJson } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";

export interface CompactionUsage { lastTokens: number; contextWindow: number; emittedAtMs: number }
export type CompactionStatus = "started" | "itemCompleted" | "completed" | "failed" | "interrupted";
export interface CompactionState {
  emittedAtMs: number;
  usage?: CompactionUsage;
  compaction?: { turnId: string; status: CompactionStatus; emittedAtMs: number };
}
export interface CompactionTarget { effectiveContextWindow: number; autoCompactTokenLimit: number; compactionHash?: string | null }
export type CompactionDecision = { action: "none" } | { action: "compact"; reason: "failed" | "downshift" } | { action: "reject"; reason: "unsupported-compaction-hash" };
interface Snapshot { version: 1; threads: Record<string, CompactionState> }
type Observation = { kind: "usage"; at: number; usage?: CompactionUsage } |
  { kind: "started" | "itemCompleted"; at: number; turnId: string } |
  { kind: "terminal"; at: number; turnId: string; status: "completed" | "failed" | "interrupted" } |
  { kind: "reset"; at: number };
const maxBytes = 4 * 1024 * 1024; const maxThreads = 4096;
const invalid = () => new Error("Private compaction metadata is invalid or unsafe");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0");
const fields = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
function usage(value: unknown): CompactionUsage | undefined {
  if (!object(value) || !fields(value, ["lastTokens", "contextWindow", "emittedAtMs"]) || !integer(value.lastTokens) ||
    !integer(value.contextWindow) || !value.contextWindow || !integer(value.emittedAtMs)) return;
  return { lastTokens: value.lastTokens, contextWindow: value.contextWindow, emittedAtMs: value.emittedAtMs };
}
function row(value: unknown): CompactionState {
  if (!object(value) || !fields(value, ["emittedAtMs", "usage", "compaction"]) || !integer(value.emittedAtMs)) throw invalid();
  const result: CompactionState = { emittedAtMs: value.emittedAtMs };
  if (Object.hasOwn(value, "usage")) { const selected = usage(value.usage); if (!selected || selected.emittedAtMs > result.emittedAtMs) throw invalid(); result.usage = selected; }
  if (Object.hasOwn(value, "compaction")) {
    const selected = value.compaction;
    if (!object(selected) || !fields(selected, ["turnId", "status", "emittedAtMs"]) || !text(selected.turnId) ||
      !["started", "itemCompleted", "completed", "failed", "interrupted"].includes(String(selected.status)) ||
      !integer(selected.emittedAtMs) || selected.emittedAtMs > result.emittedAtMs) throw invalid();
    result.compaction = { turnId: selected.turnId, status: selected.status as CompactionStatus, emittedAtMs: selected.emittedAtMs };
  }
  return result;
}

/** Recovery happens only on the caller's next user turn, never in the background. */
export function compactionDecision(state: CompactionState | undefined, target: CompactionTarget, sourceCompactionHash?: string | null): CompactionDecision {
  if ((sourceCompactionHash ?? null) !== (target.compactionHash ?? null)) return { action: "reject", reason: "unsupported-compaction-hash" };
  if (state?.compaction?.status === "failed") return { action: "compact", reason: "failed" };
  const known = usage(state?.usage);
  if (!known || !integer(target.effectiveContextWindow) || !target.effectiveContextWindow ||
    !integer(target.autoCompactTokenLimit) || !target.autoCompactTokenLimit) return { action: "none" };
  return known.contextWindow > target.effectiveContextWindow && known.lastTokens >= target.autoCompactTokenLimit
    ? { action: "compact", reason: "downshift" } : { action: "none" };
}

function reduce(current: CompactionState | undefined, event: Observation): CompactionState {
  if (current && event.at < current.emittedAtMs) return current;
  const next: CompactionState = { ...current, emittedAtMs: event.at };
  if (event.kind === "reset") { delete next.usage; delete next.compaction; return next; }
  if (event.kind === "usage") {
    if (current && current.emittedAtMs === event.at && !current.usage) delete next.usage;
    else if (event.usage && current?.usage?.emittedAtMs === event.at &&
      (current.usage.lastTokens !== event.usage.lastTokens || current.usage.contextWindow !== event.usage.contextWindow)) delete next.usage;
    else if (event.usage) next.usage = event.usage;
    else delete next.usage;
    return next;
  }
  const previous = current?.compaction;
  if (event.kind === "started") {
    if (previous?.turnId === event.turnId && previous.emittedAtMs >= event.at && previous.status !== "started") return current!;
    next.compaction = { turnId: event.turnId, status: "started", emittedAtMs: event.at };
  } else if (event.kind === "itemCompleted") {
    delete next.usage;
    next.compaction = { turnId: event.turnId, status: "itemCompleted", emittedAtMs: event.at };
  } else if (event.kind === "terminal" && previous?.turnId === event.turnId) {
    // A completed compaction item already establishes history replacement.
    // A later interrupted/failed turn must not invent failed replacement work.
    const status = previous.status === "itemCompleted" && event.status === "failed" ? previous.status : event.status;
    if (previous.status === "completed" && event.status !== "completed") return next;
    if (previous.status === "interrupted" && event.status === "failed") return next;
    next.compaction = { turnId: event.turnId, status, emittedAtMs: event.at };
  }
  return next;
}
function observation(message: unknown): { threadId: string; event: Observation; flush: boolean } | undefined {
  if (!object(message) || !integer(message.emittedAtMs) || !object(message.params) || !text(message.params.threadId)) return;
  const params = message.params; const threadId = params.threadId as string; const at = message.emittedAtMs;
  if (message.method === "thread/tokenUsage/updated") {
    const tokenUsage = object(params.tokenUsage) ? params.tokenUsage : {};
    const last = object(tokenUsage.last) ? tokenUsage.last : {};
    const selected = usage({ lastTokens: last.totalTokens, contextWindow: tokenUsage.modelContextWindow, emittedAtMs: at });
    return { threadId, event: { kind: "usage", at, ...(selected ? { usage: selected } : {}) }, flush: false };
  }
  const turnId = text(params.turnId) ? params.turnId : object(params.turn) && text(params.turn.id) ? params.turn.id : undefined;
  if (turnId && ["item/started", "item/completed"].includes(String(message.method)) && object(params.item) && params.item.type === "contextCompaction") {
    return { threadId, event: { kind: message.method === "item/started" ? "started" : "itemCompleted", turnId, at }, flush: false };
  }
  if (turnId && message.method === "turn/completed" && object(params.turn) && ["completed", "failed", "interrupted"].includes(String(params.turn.status))) {
    return { threadId, event: { kind: "terminal", turnId, at, status: params.turn.status as "completed" | "failed" | "interrupted" }, flush: true };
  }
}

/** Coalesced, account-home-scoped public counters and compaction lifecycle only. */
export class CompactionStateStore {
  private readonly directory: string;
  private readonly path: string;
  private readonly pending = new Map<string, Observation[]>();
  constructor(stateDirectory: string, nativeHome: string) {
    this.directory = resolve(stateDirectory);
    const scope = createHash("sha256").update(resolve(nativeHome)).digest("hex").slice(0, 16);
    this.path = resolve(this.directory, `desktop-compaction-${scope}.json`);
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
      const bytes = Buffer.alloc(info.size + 1); let length = 0;
      while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
      if (length > info.size) throw invalid();
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
      if (!object(parsed) || !fields(parsed, ["version", "threads"]) || parsed.version !== 1 || !object(parsed.threads) || Object.keys(parsed.threads).length > maxThreads) throw invalid();
      const threads: Record<string, CompactionState> = Object.create(null);
      for (const [id, value] of Object.entries(parsed.threads)) { if (!text(id)) throw invalid(); threads[id] = row(value); }
      return { version: 1, threads };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, threads: Object.create(null) };
      throw invalid();
    } finally { await file?.close(); }
  }
  private queue(threadId: string, event: Observation): void {
    if (!text(threadId)) throw invalid();
    const entries = this.pending.get(threadId) ?? [];
    if (!this.pending.has(threadId) && this.pending.size >= maxThreads) throw invalid();
    if (event.kind === "usage") {
      let index = entries.length - 1;
      while (index >= 0 && entries[index].kind !== "usage") index--;
      const previous = index >= 0 ? entries[index] : undefined;
      if (previous && previous.at > event.at) return;
      if (previous?.kind === "usage" && previous.at === event.at && (!previous.usage || !event.usage ||
        previous.usage.lastTokens !== event.usage.lastTokens || previous.usage.contextWindow !== event.usage.contextWindow)) event = { kind: "usage", at: event.at };
      // Keep lifecycle barriers in order while replacing older pending counters.
      if (index >= 0) entries.splice(index, 1);
    }
    if (entries.length >= 32) throw invalid();
    entries.push(event); this.pending.set(threadId, entries);
  }
  async read(threadId: string): Promise<CompactionState | undefined> {
    if (!text(threadId)) throw invalid();
    let selected = (await this.load()).threads[threadId];
    for (const event of this.pending.get(threadId) ?? []) selected = reduce(selected, event);
    return selected ? structuredClone(selected) : undefined;
  }
  async observe(message: unknown): Promise<void> {
    const selected = observation(message); if (!selected) return;
    this.queue(selected.threadId, selected.event);
    if (selected.flush) await this.flush(selected.threadId);
  }
  seedUsage(threadId: string, value: CompactionUsage): void {
    const selected = usage(value); if (!selected) throw invalid();
    this.queue(threadId, { kind: "usage", at: selected.emittedAtMs, usage: selected });
  }
  async reset(threadId: string, emittedAtMs = Date.now()): Promise<void> {
    if (!integer(emittedAtMs)) throw invalid();
    this.queue(threadId, { kind: "reset", at: emittedAtMs }); await this.flush(threadId);
  }
  private async flush(threadId: string): Promise<void> {
    const entries = [...(this.pending.get(threadId) ?? [])]; if (!entries.length) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await this.checkDirectory();
    await withPrivateFileLock(this.path, async () => {
      const saved = await this.load(); let selected = saved.threads[threadId];
      for (const event of entries) selected = reduce(selected, event);
      if (selected) {
        if (!Object.hasOwn(saved.threads, threadId) && Object.keys(saved.threads).length >= maxThreads) throw invalid();
        saved.threads[threadId] = row(selected);
        if (Buffer.byteLength(JSON.stringify(saved, null, 2) + "\n") > maxBytes) throw invalid();
        await writePrivateJson(this.path, saved);
      }
    });
    const remaining = this.pending.get(threadId)?.filter(event => !entries.includes(event)) ?? [];
    if (remaining.length) this.pending.set(threadId, remaining); else this.pending.delete(threadId);
  }
}
