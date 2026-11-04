import { setTimeout as delay } from "node:timers/promises";
import type { Message } from "./app-server-connection.js";
import type { ExecutionHostClient, NativeLaunchRecord } from "./execution-host-client.js";
import type { NativeRpcConnection } from "./shared-native-connection.js";

/** How long a lost native socket waits for the host control connection to close too, which is what marks a host restart. */
export const hostLossGraceMs = 1_000;
/** How long one repair keeps trying to find the restarted host before the session ends as it used to. */
export const reconnectDeadlineMs = 90_000;
const retryMs = 1_000;

export interface NativeHostReconnect {
  /** The control connection that was current when the native socket was lost. */
  old: ExecutionHostClient;
  /** Whether the session may still continue: not closing and no native turn running (a cut turn ends the session as before). */
  eligible(): boolean;
  discover(signal: AbortSignal): Promise<ExecutionHostClient>;
  acquire(client: ExecutionHostClient): Promise<NativeLaunchRecord>;
  /** A socket to the acquired engine, wired to the adapter's handlers. */
  connect(record: NativeLaunchRecord): NativeRpcConnection;
  /** The desktop app's own `initialize`, replayed to the new engine. */
  initialized?: Message;
  /** The native chats this session had loaded; each is resumed on the new engine so the app's next request finds it. */
  threads: string[];
  signal: AbortSignal;
  deadlineMs?: number;
}
export interface ReconnectedHost { client: ExecutionHostClient; record: NativeLaunchRecord; connection: NativeRpcConnection; resumed: number; failed: number }

/**
 * Finds the restarted execution host and joins its native engine as the same desktop session. Only a host restart qualifies:
 * a native socket lost while the host control connection stays open (the engine alone stopped) returns `undefined` after a
 * short grace, so that loss keeps its existing exit and death handling.
 */
export async function reconnectNativeHost(options: NativeHostReconnect): Promise<ReconnectedHost | undefined> {
  if (!options.eligible() || !options.initialized) return undefined;
  if (!options.old.closed) await Promise.race([options.old.exited.catch(() => undefined), delay(hostLossGraceMs, undefined, { ref: false })]);
  if (!options.old.closed) return undefined;
  const deadline = Date.now() + (options.deadlineMs ?? reconnectDeadlineMs);
  // Every wait is bounded by the repair's deadline and by the session's stop, so a stop never waits out a repair.
  const bounded = <T>(work: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined; let abort: (() => void) | undefined;
    const limit = new Promise<never>((_, reject) => {
      const fail = () => reject(new Error("The host reconnect was cancelled or ran out of time"));
      if (options.signal.aborted) { fail(); return; }
      abort = fail; options.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(fail, Math.max(0, deadline - Date.now())); timer.unref();
    });
    return Promise.race([work, limit]).finally(() => { clearTimeout(timer); if (abort) options.signal.removeEventListener("abort", abort); });
  };
  while (Date.now() < deadline && !options.signal.aborted && options.eligible()) {
    let client: ExecutionHostClient | undefined; let connection: NativeRpcConnection | undefined;
    try {
      const discovering = options.discover(options.signal);
      // A host found after the repair gave up is closed rather than left connected.
      client = await bounded(discovering).catch(error => { void discovering.then(late => late.close(), () => {}); throw error; });
      const record = await bounded(options.acquire(client));
      connection = options.connect(record);
      await bounded(Promise.resolve(connection.ready));
      await bounded(connection.request("initialize", options.initialized));
      connection.send({ method: "initialized", params: {} });
      let resumed = 0; let failed = 0;
      for (const threadId of options.threads) {
        if (options.signal.aborted) break;
        // A chat deleted or archived meanwhile cannot be resumed; the app learns that on its own next request.
        try { await bounded(connection.request("thread/resume", { threadId, excludeTurns: true })); resumed++; }
        catch (error) { if (options.signal.aborted || Date.now() >= deadline) throw error; failed++; }
      }
      if (Date.now() >= deadline || options.signal.aborted || !options.eligible() || client.closed || connection.closed) throw new Error("The reconnected host was lost again");
      return { client, record, connection, resumed, failed };
    } catch {
      connection?.stop(); client?.close();
      if (options.signal.aborted) return undefined;
      await delay(Math.min(retryMs, Math.max(0, deadline - Date.now())), undefined, { ref: false });
    }
  }
  return undefined;
}
