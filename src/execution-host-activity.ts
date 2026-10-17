import { object, type Message } from "./app-server-connection.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";
import { sameSocketIdentity, socketIdentity, type SocketIdentity } from "./execution-host-storage.js";

/**
 * What one engine's loaded chats are doing, read from the engine itself. The host never sees turn notifications: adapters
 * talk to engine sockets directly, and a persistent host client would be subscribed to new chats by the SDK and keep them
 * loaded. So each check opens one transient admin connection, as the loaded-chat probes do, and asks the pinned SDK
 * (codex 0.162.0-alpha.17.2, protocol v2) for each loaded chat's live `thread/read` status and, unless the chat has been
 * untouched for well over `quietMs`, its newest turn from `thread/turns/list`. Anything it cannot read counts as `unknown`,
 * which a quiet check treats as not quiet.
 */
export interface EngineActivity {
  /** Loaded chats (ids, so the host can tell which chat stopped running between two checks). */
  loaded: string[];
  /** Loaded chats with a turn running, or waiting for an approval or for user input. */
  running: string[];
  /** Loaded chats whose state could not be read. */
  unknown: number;
  /** When the newest turn of any loaded chat ended (ms since the epoch), when one did. */
  lastEndedAtMs?: number;
}

/**
 * The pinned SDK touches a chat's `updatedAt` whenever it appends to the chat's saved history, at most 5 s apart
 * (codex-rs thread-store `THREAD_UPDATED_AT_TOUCH_INTERVAL`). A saved chat untouched for longer than the quiet time plus this
 * margin ended its last turn before that, so its newest turn is not read: `thread/turns/list` replays the whole saved history.
 */
const touchMarginMs = 60_000;
/** Statuses that prove no turn runs; `systemError` is what the pinned SDK keeps after a failed turn. */
const settled = new Set(["idle", "systemError", "notLoaded"]);
const ended = new Set(["completed", "interrupted", "failed"]);
/** A host with more loaded chats than this in one engine is not judged quiet: reading them all would hold acquires too long. */
const maxChats = 256;
const timeoutMs = 10_000;
const seconds = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
const chatId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0");

/** One chat: running, settled with the time its newest turn ended (or the chat last changed), or unreadable. */
async function chatActivity(admin: SocketAppServerConnection, threadId: string, quietMs: number): Promise<{ running: boolean; endedAtMs?: number } | undefined> {
  const thread = object(object(await admin.request("thread/read", { threadId, includeTurns: false })).thread);
  const status = object(thread.status).type;
  if (status === "active") return { running: true };
  if (typeof status !== "string" || !settled.has(status)) return;
  const updatedAtMs = seconds(thread.updatedAt);
  // A throwaway chat has no saved history, so its `updatedAt` proves nothing about its turns.
  if (updatedAtMs !== undefined && thread.ephemeral !== true && Date.now() - updatedAtMs > quietMs + touchMarginMs) return { running: false, endedAtMs: updatedAtMs };
  // The newest turn, with the live one merged in by the SDK; a chat whose turns cannot be listed falls back to its last change.
  const page = await admin.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }).catch(() => undefined);
  if (!page || !Array.isArray(page.data)) return updatedAtMs === undefined ? undefined : { running: false, endedAtMs: updatedAtMs };
  if (!page.data.length) return { running: false, endedAtMs: updatedAtMs };
  const turn = object(page.data[0]);
  if (turn.status === "inProgress") return { running: true };
  if (typeof turn.status !== "string" || !ended.has(turn.status)) return;
  const endedAtMs = seconds(turn.completedAt) ?? seconds(turn.startedAt) ?? updatedAtMs;
  return endedAtMs === undefined ? undefined : { running: false, endedAtMs };
}

/**
 * Reads one engine's activity through a transient admin connection that never answers server requests (the real frontend
 * owns replies). `expected` is the socket identity the host recorded at the engine's start: a socket that changed since is
 * not this engine's, so nothing is asked. The whole read is bounded; a timeout or any transport failure rejects.
 */
export async function engineActivity(socketPath: string, expected: SocketIdentity | undefined, quietMs: number): Promise<EngineActivity> {
  const socket = await socketIdentity(socketPath);
  if (!socket || !expected || !sameSocketIdentity(socket, expected)) throw new Error("Execution engine socket ownership changed; its listener was preserved");
  const admin = new SocketAppServerConnection(socketPath, async () => {}); let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([(async () => {
      await admin.ready;
      await admin.request("initialize", { clientInfo: { name: "codex_app_server_daemon", version: "1" }, capabilities: { experimentalApi: true } });
      admin.send({ method: "initialized", params: {} });
      const loaded: string[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= 128) throw new Error("Execution SDK loaded-chat pagination exceeded its bound");
        const result: Message = await admin.request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result.data) || !result.data.every(chatId)) throw new Error("Execution SDK returned invalid loaded-chat metadata");
        loaded.push(...result.data as string[]);
        if (loaded.length > maxChats) throw new Error("Execution SDK has too many loaded chats to judge");
        if (result.nextCursor == null) break;
        if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) throw new Error("Execution SDK returned invalid loaded-chat pagination");
        cursor = result.nextCursor; cursors.add(cursor);
      }
      const activity: EngineActivity = { loaded: [...new Set(loaded)], running: [], unknown: 0 };
      for (const threadId of activity.loaded) {
        const chat = await chatActivity(admin, threadId, quietMs).catch(() => undefined);
        if (!chat) { activity.unknown++; continue; }
        if (chat.running) { activity.running.push(threadId); continue; }
        if (chat.endedAtMs !== undefined) activity.lastEndedAtMs = Math.max(activity.lastEndedAtMs ?? 0, chat.endedAtMs);
      }
      return activity;
    })(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Execution SDK activity inspection timed out")), timeoutMs).unref(); })]);
  } finally { clearTimeout(timer); admin.stop(); await admin.exited; }
}
