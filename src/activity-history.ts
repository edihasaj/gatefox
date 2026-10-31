import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

export type ActivityState = "running" | "waiting" | "completed" | "failed" | "interrupted" | "unknown";
export interface ActivityTurn {
  id: string;
  status: "inProgress" | "completed" | "failed" | "interrupted";
  completedAt?: string;
  errorClass?: string;
}
export interface ActivityRow {
  threadId: string;
  name?: string;
  model?: string;
  requestedModel?: string;
  providerId?: string;
  isSubagent?: boolean;
  state: ActivityState;
  waitingFor?: "approval" | "input";
  source: "sdk" | "recorded";
  observedAt: string;
  turn?: ActivityTurn;
}
export const activityId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const terminal = new Set(["completed", "failed", "interrupted"]);
const errors = new Set(["none", "stream_disconnected", "idle_timeout", "deadline", "usage_limit", "rate_limit", "context_window", "attachment", "authentication", "overloaded", "tool_call", "cancelled", "other"]);
export const activityError = (value: unknown): string | undefined => typeof value === "string" && errors.has(value) ? value : undefined;
const bytesPerFile = 2 * 1024 * 1024;

/** A bounded, content-free fallback. An old start or terminal event never proves current liveness. */
export async function recordedActivity(stateDirectory: string, now = Date.now()): Promise<{ rows: ActivityRow[]; partial: boolean }> {
  const rows = new Map<string, ActivityRow>();
  let partial = false;
  for (const day of [new Date(now - 86400_000), new Date(now)]) {
    let file;
    try {
      file = await open(join(stateDirectory, "telemetry", `events-${day.toISOString().slice(0, 10)}.jsonl`), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077) { partial = true; continue; }
      const start = Math.max(0, stat.size - bytesPerFile), data = Buffer.alloc(Math.min(stat.size, bytesPerFile));
      const { bytesRead } = await file.read(data, 0, data.length, start);
      let lines = data.toString("utf8", 0, bytesRead).split("\n");
      if (start) { lines = lines.slice(1); partial = true; }
      for (const line of lines) {
        if (!line) continue;
        if (line.length > 16384) { partial = true; continue; }
        let event;
        try { event = JSON.parse(line); } catch { partial = true; continue; }
        if (!event || !["executor_turn_settled", "turn_completed", "turn_empty_completion"].includes(event.event) ||
            !activityId(event.threadId) || !activityId(event.turnId) || !terminal.has(event.status)) continue;
        const at = typeof event.at === "string" ? Date.parse(event.at) : NaN;
        if (!Number.isFinite(at) || at < now - 86400_000 || at > now) continue;
        const previous = rows.get(event.threadId);
        if (previous && Date.parse(previous.observedAt) > at) continue;
        const errorClass = activityError(event.errorClass);
        rows.delete(event.threadId);
        rows.set(event.threadId, { threadId: event.threadId, state: "unknown", source: "recorded", observedAt: new Date(at).toISOString(),
          turn: { id: event.turnId, status: event.status, ...(errorClass ? { errorClass } : {}) } });
        if (rows.size > 100) rows.delete(rows.keys().next().value!);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") partial = true; }
    finally { await file?.close().catch(() => {}); }
  }
  return { rows: [...rows.values()], partial };
}
