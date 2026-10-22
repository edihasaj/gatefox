import type { Message } from "./app-server-connection.js";

/** The display-only item kinds safe to restore from the SDK's recorded completion. */
const displayTypes = new Set(["agentMessage", "reasoning", "plan"]);

/**
 * Replays only SDK-proven completed display items. Legacy histories do not offer
 * `thread/items/list`, so a failed or malformed read is intentionally a no-op.
 */
export async function replayCompletedDisplayItems(
  request: (method: string, params: Message) => Promise<Message>, emit: (message: Message) => Promise<void>,
  current: () => boolean, threadId: string, turnId: string, completed: { has(id: string): boolean; add(id: string): void },
): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < 8 && current(); page++) {
    const result = await request("thread/items/list", { threadId, turnId, limit: 100, sortDirection: "asc", ...(cursor ? { cursor } : {}) }).catch(() => undefined);
    if (!result || !Array.isArray(result.data)) return false;
    for (const raw of result.data) {
      if (!current() || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      const entry = raw as Message; const item = entry.item;
      if (entry.turnId !== turnId) continue;
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const typed = item as Message; const id = typeof typed.id === "string" ? typed.id : undefined;
      const completedAtMs = typeof entry.completedAtMs === "number" && Number.isFinite(entry.completedAtMs) ? entry.completedAtMs : undefined;
      if (!id || completedAtMs === undefined || !displayTypes.has(String(typed.type))) continue;
      const key = `${threadId}\0${turnId}\0${id}`;
      if (completed.has(key)) continue;
      completed.add(key); await emit({ method: "item/completed", params: { threadId, turnId, item: typed, completedAtMs } });
    }
    if (result.nextCursor == null) return true;
    if (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor === cursor) return false;
    cursor = result.nextCursor;
  }
  return false;
}
