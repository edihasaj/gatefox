import { object, type Message } from "./app-server-connection.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";
import { sameSocketIdentity, socketIdentity, type SocketIdentity } from "./execution-host-storage.js";
import { telemetry } from "./telemetry.js";
import { errorClass } from "./turn-telemetry.js";

export interface TurnPollConnection {
  readonly ready: Promise<void>;
  request(method: string, params: Message): Promise<Message>;
  send(message: Message): void;
  stop(): void;
}
export interface TurnTrackerOptions {
  socketPath: string; engine: "gateway" | "native"; expected: () => SocketIdentity | undefined;
  intervalMs?: number; timeoutMs?: number;
  connection?: (path: string) => TurnPollConnection;
  verify?: (path: string, expected: SocketIdentity | undefined) => Promise<boolean>;
}
export interface TurnTracker { poll(): Promise<void>; stop(): void; }

type Chat = { active: boolean; updatedAt?: number; watermark: number; cursor?: string; pendingWatermark: number; pending: boolean; scanUpdatedAt?: number; headDirty: boolean; historyOrder: number };
type Operation = { cancelled: boolean; connection: TurnPollConnection; requests: number; turnPages: number; deadline: number };
const maxInspectedChats = 32, maxRemembered = 4096, maxListPages = 8, maxTurnPages = 16, maxRequests = 96;
const settled = new Set(["idle", "systemError", "notLoaded"]);
const ended = new Set(["completed", "failed", "interrupted"]);
const chatId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0");
const milliseconds = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) * 1000 : undefined;
function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key); map.set(key, value); while (map.size > maxRemembered) map.delete(map.keys().next().value!);
}
async function sameSocket(path: string, expected: SocketIdentity | undefined): Promise<boolean> {
  const actual = await socketIdentity(path); return !!actual && !!expected && sameSocketIdentity(actual, expected);
}

/** Bounded, read-only terminal-turn sampling for an engine that can outlive every desktop window. */
export function trackExecutorTurns(options: TurnTrackerOptions): TurnTracker {
  const create = options.connection ?? (path => new SocketAppServerConnection(path, async () => {}));
  const verify = options.verify ?? sameSocket, timeoutMs = options.timeoutMs ?? 10_000;
  // SDK timestamps are whole epoch seconds. Floor this so a same-second terminal outcome remains eligible.
  const startupBoundary = Math.floor(Date.now() / 1000) * 1000;
  const ancientHistoryBoundary = startupBoundary - 60_000;
  const chats = new Map<string, Chat>(), seen = new Map<string, true>();
  let stopped = false, running: Promise<void> | undefined, current: Operation | undefined, loadedOffset = 0, watchedOffset = 0, historyOrder = 0, loadedCursor: string | undefined;

  const close = (connection: TurnPollConnection | undefined) => { try { connection?.stop(); } catch { /* Closing diagnostics is best effort. */ } };
  const alive = (op: Operation) => !stopped && !op.cancelled && current === op && Date.now() < op.deadline;
  const call = async (op: Operation, method: string, params: Message): Promise<Message | undefined> => {
    if (!alive(op) || op.requests >= maxRequests) return undefined;
    op.requests += 1;
    try { const result = await op.connection.request(method, params); return alive(op) ? result : undefined; } catch { return undefined; }
  };
  const pick = (ids: string[], count: number, offset: "loadedOffset" | "watchedOffset") => {
    if (!ids.length || !count) return [] as string[];
    const start = (offset === "loadedOffset" ? loadedOffset : watchedOffset) % ids.length;
    const chosen = Array.from({ length: Math.min(count, ids.length) }, (_, index) => ids[(start + index) % ids.length]!);
    if (offset === "loadedOffset") loadedOffset = (start + chosen.length) % ids.length;
    else watchedOffset = (start + chosen.length) % ids.length;
    return chosen;
  };
  const state = (id: string): Chat => chats.get(id) ?? { active: false, watermark: startupBoundary, pendingWatermark: startupBoundary, pending: true, headDirty: false, historyOrder: 0 };

  const inspectTurns = async (op: Operation, threadId: string, chat: Chat, updatedAt: number | undefined): Promise<{ complete: boolean; terminal: boolean }> => {
    if (chat.cursor) { if (chat.scanUpdatedAt !== updatedAt) chat.headDirty = true; }
    else { chat.scanUpdatedAt = updatedAt; chat.headDirty = false; }
    let cursor = chat.cursor, pages = 0, highest = chat.pendingWatermark, complete = false;
    let terminal = false;
    while (alive(op) && pages++ < maxTurnPages && op.turnPages < maxTurnPages) {
      op.turnPages += 1;
      chat.historyOrder = ++historyOrder;
      const page = await call(op, "thread/turns/list", { threadId, limit: 50, sortDirection: "desc", itemsView: "notLoaded", ...(cursor ? { cursor } : {}) });
      if (!page || !Array.isArray(page.data)) return { complete: false, terminal };
      let older = false;
      for (const raw of page.data) {
        const turn = object(raw), id = turn.id, completedAt = milliseconds(turn.completedAt);
        if (!chatId(id) || typeof turn.status !== "string" || !ended.has(turn.status) || completedAt === undefined) continue;
        if (completedAt < chat.watermark) { older = true; continue; }
        highest = Math.max(highest, completedAt); terminal ||= completedAt >= startupBoundary;
        if (completedAt < startupBoundary || seen.has(id) || !alive(op)) continue;
        remember(seen, id, true);
        const startedAt = milliseconds(turn.startedAt), error = object(turn.error), message = typeof error.message === "string" ? error.message : undefined;
        telemetry("executor_turn_settled", { engine: options.engine, threadId, turnId: id, status: turn.status,
          errorClass: message ? errorClass(message) : undefined, durationMs: startedAt === undefined ? undefined : Math.max(0, completedAt - startedAt) });
      }
      chat.pendingWatermark = Math.max(chat.pendingWatermark, highest);
      const next = page.nextCursor;
      if (older || next == null) { complete = true; break; }
      if (typeof next !== "string" || !next || next === cursor) return { complete: false, terminal };
      cursor = next; chat.cursor = cursor;
    }
    if (!complete) return { complete: false, terminal };
    chat.cursor = undefined; chat.watermark = Math.max(chat.watermark, chat.pendingWatermark, highest); chat.pendingWatermark = chat.watermark;
    if (chat.headDirty) { chat.headDirty = false; return { complete: false, terminal }; }
    return { complete: true, terminal };
  };
  const inspect = async (op: Operation) => {
    try { await op.connection.ready; } catch { return; }
    // Initialize is a request, but this connection never handles inbound engine requests or subscribes to chats.
    if (!await call(op, "initialize", { clientInfo: { name: "codex_app_server_daemon", version: "1" }, capabilities: { experimentalApi: true } })) return;
    if (!alive(op)) return;
    try { op.connection.send({ method: "initialized", params: {} }); } catch { return; }
    const loaded: string[] = []; const cursorSeen = new Set<string>(); let cursor = loadedCursor;
    for (let page = 0; alive(op) && page < maxListPages; page++) {
      const result = await call(op, "thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!result || !Array.isArray(result.data) || !result.data.every(chatId)) return;
      loaded.push(...result.data as string[]);
      if (result.nextCursor == null) { loadedCursor = undefined; break; }
      if (typeof result.nextCursor !== "string" || !result.nextCursor || cursorSeen.has(result.nextCursor)) return;
      cursorSeen.add(result.nextCursor); cursor = result.nextCursor;
      loadedCursor = cursor;
    }
    if (!alive(op)) return;
    const loadedSet = new Set(loaded);
    const watched = [...chats].filter(([id, chat]) => !loadedSet.has(id) && (chat.active || chat.cursor || chat.pending)).map(([id]) => id);
    const watchedIds = pick(watched, Math.min(16, maxInspectedChats), "watchedOffset");
    const selected = new Set(watchedIds);
    for (const id of pick(loaded, maxInspectedChats - selected.size, "loadedOffset")) selected.add(id);
    const ordered = [...selected].sort((left, right) => (chats.get(left)?.historyOrder ?? 0) - (chats.get(right)?.historyOrder ?? 0));
    for (const threadId of ordered) {
      if (!alive(op)) return;
      const result = await call(op, "thread/read", { threadId, includeTurns: false });
      if (!result) continue; // Transient reads retain an unloaded active watch.
      const thread = object(object(result).thread), status = object(thread.status).type;
      const updatedAt = milliseconds(thread.updatedAt), previous = chats.get(threadId), chat = state(threadId);
      const changed = !previous || previous.updatedAt !== updatedAt;
      if (status === "active") {
        const scan = (chat.pending || changed || !!chat.cursor) ? await inspectTurns(op, threadId, chat, updatedAt) : { complete: true, terminal: false };
        if (!alive(op)) return;
        chat.active = true; chat.pending = !scan.complete; chat.updatedAt = updatedAt; remember(chats, threadId, chat); continue;
      }
      const unloadedWatch = !!previous?.active && !loadedSet.has(threadId);
      if (typeof status !== "string" || (!settled.has(status) && !unloadedWatch)) continue;
      const definitelyOld = !previous && updatedAt !== undefined && updatedAt < ancientHistoryBoundary;
      const shouldRead = !definitelyOld && (chat.pending || unloadedWatch || !previous || previous.active || changed || !!chat.cursor);
      const scan = shouldRead ? await inspectTurns(op, threadId, chat, updatedAt) : { complete: true, terminal: false };
      if (!alive(op)) return;
      chat.pending = !scan.complete;
      // notLoaded is only absence from a client cache. Keep an active watch until a recent terminal outcome is conclusive.
      chat.active = unloadedWatch && status === "notLoaded" && !scan.terminal;
      chat.updatedAt = updatedAt;
      if (loadedSet.has(threadId) || chat.active || chat.cursor || chat.pending) remember(chats, threadId, chat); else chats.delete(threadId);
    }
  };
  const poll = (): Promise<void> => running ||= (async () => {
    let expected: SocketIdentity | undefined;
    try { expected = options.expected(); if (stopped || !await verify(options.socketPath, expected) || stopped) return; } catch { return; }
    let connection: TurnPollConnection;
    try { connection = create(options.socketPath); } catch { return; }
    const op: Operation = { cancelled: false, connection, requests: 0, turnPages: 0, deadline: Date.now() + timeoutMs };
    current = op;
    const work = inspect(op); void work.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([work.catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); timer.unref(); })]);
    if (timer) clearTimeout(timer);
    op.cancelled = true;
    if (current === op) current = undefined;
    close(connection);
  })().finally(() => { running = undefined; });
  const interval = setInterval(() => { void poll(); }, options.intervalMs ?? 30_000); interval.unref();
  return { poll, stop() { stopped = true; if (current) { current.cancelled = true; close(current.connection); current = undefined; } clearInterval(interval); } };
}
