import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { CompactionUsage } from "./compaction-state.js";

const maxBytes = 64 * 1024 * 1024; const maxLineBytes = 64 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Read only public counters from an SDK-provided rollout; never infer a model. */
export async function readCompactionUsage(nativeHome: string, threadId: string, sdkPath: string): Promise<CompactionUsage | undefined> {
  let file;
  try {
    if (!threadId || threadId.length > 1024 || typeof sdkPath !== "string") return;
    const home = await realpath(resolve(nativeHome)); const path = await realpath(resolve(sdkPath));
    if (!["sessions", "archived_sessions"].some(name => path.startsWith(resolve(home, name) + sep))) return;
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o022)))) return;
    if (await realpath(resolve(sdkPath)) !== path) return;
    let matched = false; let known: CompactionUsage | undefined; let watermark = -1; let carry = Buffer.alloc(0); let skipped = false; let total = 0;
    const metadata = (bytes: Buffer): boolean => {
      // Skip prompt/tool/message records before JSON parsing their bodies.
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const kind = /"type"\s*:\s*"([^"\\]+)"/.exec(text)?.[1];
      if (!["session_meta", "event_msg", "compacted"].includes(kind ?? "")) return true;
      if (kind === "compacted") {
        if (!matched) return false;
        const at = Date.parse(/"timestamp"\s*:\s*"([^"\\]+)"/.exec(text)?.[1] ?? "");
        if (!integer(at)) return false;
        watermark = Math.max(watermark, at); known = undefined; return true;
      }
      if (kind === "event_msg") {
        const eventType = /"payload"\s*:\s*\{\s*"type"\s*:\s*"([^"\\]+)"/.exec(text)?.[1];
        if (!["token_count", "thread_rolled_back"].includes(eventType ?? "")) return true;
      }
      const value: unknown = JSON.parse(text);
      if (!object(value) || !object(value.payload)) return false;
      if (value.type === "session_meta") { if (value.payload.id !== threadId) return false; matched = true; return true; }
      if (!matched) return false;
      const at = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : NaN;
      if (!integer(at)) return false;
      if (value.payload.type === "thread_rolled_back") { watermark = Math.max(watermark, at); known = undefined; return true; }
      const counts = object(value.payload.info) ? value.payload.info : {};
      const last = object(counts.last_token_usage) ? counts.last_token_usage : {};
      if (at < watermark) return true;
      watermark = at;
      if (!integer(last.total_tokens) || !integer(counts.model_context_window) || !counts.model_context_window) { known = undefined; return true; }
      known = { lastTokens: last.total_tokens, contextWindow: counts.model_context_window, emittedAtMs: at }; return true;
    };
    for await (const value of file.createReadStream({ autoClose: false, highWaterMark: maxLineBytes })) {
      const chunk = value as Buffer; total += chunk.length; if (total > maxBytes) return;
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset); const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
        if (!skipped && carry.length + part.length <= maxLineBytes) carry = Buffer.concat([carry, part]);
        else { carry = Buffer.alloc(0); skipped = true; known = undefined; }
        if (end < 0) break;
        if (!skipped && carry.length && !metadata(carry)) return;
        carry = Buffer.alloc(0); skipped = false; offset = end + 1;
      }
    }
    // An incomplete last record cannot establish fresh counters.
    if (carry.length || skipped || !matched) return;
    return known;
  } catch { return; }
  finally { await file?.close(); }
}
