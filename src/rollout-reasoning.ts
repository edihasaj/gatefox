import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { isModelName, isReasoningEffort, isReasoningSummary } from "./thread-reasoning.js";

export interface RolloutReasoning { effort: string; summary?: string; model?: string }
const isObj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const object = (value: unknown): Record<string, unknown> => isObj(value) ? value : {};
const eff = (value: unknown): string | undefined => isReasoningEffort(value) ? value : undefined;
const defaultChunk = 256 * 1024; const defaultMax = 16 * 1024 * 1024; const maxLineBytes = 2 * 1024 * 1024;
// Records that carry a chat's reasoning. Everything else is skipped before it is parsed.
const markers = ["turn_context", "thread_settings_applied"];

/**
 * The reasoning the chat's own rollout last recorded, read from its tail backwards.
 * Only effort, summary and their model leave this function; nothing is logged.
 */
export async function readRolloutReasoning(path: unknown, threadId: unknown, nativeHome: string, options: { chunk?: number; max?: number } = {}): Promise<RolloutReasoning | undefined> {
  if (!isModelName(threadId) || !isModelName(path)) return;
  const file = basename(resolve(String(path)));
  if (!file.startsWith("rollout-") || !file.endsWith(`${threadId}.jsonl`)) return;
  const chunk = Math.max(4 * 1024, Math.min(Math.trunc(options.chunk ?? defaultChunk), 4 * 1024 * 1024));
  const max = Math.max(chunk, Math.trunc(options.max ?? defaultMax));
  let handle;
  try {
    const requested = resolve(String(path));
    const own = await lstat(requested);
    if (!own.isFile()) return;
    if (process.platform !== "win32" && (own.uid !== process.getuid?.() || (own.mode & 0o022))) return;
    const home = await realpath(resolve(nativeHome));
    const target = await realpath(requested);
    if (!["sessions", "archived_sessions"].some(name => target.startsWith(resolve(home, name) + sep))) return;
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const info = await handle.stat();
    // A long rollout is scanned from its end, so its latest settings are found without reading all of it.
    if (!info.isFile()) return;
    if (await realpath(requested) !== target) return;
    let effort: string | undefined; let summary: string | undefined; let model: string | undefined;
    const record = (entry: Record<string, unknown>, owner: Record<string, unknown>) => {
      const value = eff(entry.effort) ?? eff(entry.reasoning_effort) ?? eff(object(object(entry.collaboration_mode).settings).reasoning_effort);
      if (effort === undefined && value !== undefined) { effort = value; if (isModelName(entry.model) || isModelName(owner.model)) model = String(entry.model ?? owner.model); }
      const selected = isReasoningSummary(entry.summary) ? entry.summary : isReasoningSummary(entry.reasoning_summary) ? entry.reasoning_summary : undefined;
      if (summary === undefined && selected !== undefined) summary = selected;
    };
    const inspect = (bytes: Buffer) => {
      let text: string;
      // A torn record is skipped; a chat's settings cannot be recovered from it.
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return; }
      if (!markers.some(marker => text.includes(marker))) return;
      let value: unknown; try { value = JSON.parse(text); } catch { return; }
      if (!isObj(value) || typeof value.type !== "string") return;
      const payload = object(value.payload);
      if (value.type === "turn_context") record(payload, payload);
      else if (value.type === "event_msg" && payload.type === "thread_settings_applied") {
        // A copied snapshot retains its parent's ID; only this chat's settings qualify.
        if (payload.thread_id !== threadId) return;
        const settings = object(payload.thread_settings);
        record(settings, settings);
      }
    };
    let right = info.size; let carry = Buffer.alloc(0); let dropped = false; let scanned = 0; let found = false;
    while (right > 0 && !found) {
      // A record longer than the line bound cannot be parsed, so skip past it.
      if (!dropped && carry.length > maxLineBytes) { carry = Buffer.alloc(0); dropped = true; }
      const left = Math.max(0, right - chunk);
      const block = Buffer.alloc(right - left); let read = 0;
      while (read < block.length) {
        const next = await handle.read(block, read, block.length - read, left + read);
        if (!next.bytesRead) break;
        read += next.bytesRead;
      }
      if (read !== block.length) return;
      scanned += read;
      if (scanned > max) return;
      let end = block.length;
      for (;;) {
        const newline = block.lastIndexOf(10, end - 1);
        if (dropped) {
          if (newline < 0) break;
          dropped = false; carry = Buffer.alloc(0); end = newline;
          continue;
        }
        if (newline < 0) { carry = Buffer.concat([block.subarray(0, end), carry]); break; }
        const line = Buffer.concat([block.subarray(newline + 1, end), carry]);
        carry = Buffer.alloc(0); end = newline;
        if (line.length) inspect(line);
        if (effort !== undefined && summary !== undefined) { found = true; break; }
      }
      right = left;
    }
    // The file's first record has no newline before it.
    if (!found && !dropped && carry.length) inspect(carry);
    if (effort === undefined) return;
    return { effort, ...(summary !== undefined ? { summary } : {}), ...(model !== undefined ? { model } : {}) };
  } catch { return; }
  finally { await handle?.close(); }
}
