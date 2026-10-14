import { object, type Message } from "./app-server-connection.js";

const creates = new Set(["thread/start", "thread/fork"]);
const threadOf = (message: Message): string | undefined => {
  const params = object(message.params); const thread = object(params.thread);
  return typeof params.threadId === "string" ? params.threadId : typeof thread.id === "string" ? thread.id : undefined;
};

/**
 * The SDK answers a thread-creating request before it announces the new thread.
 * The desktop depends on that order: it hides a prewarmed chat only when the
 * thread/start reply arrives before thread/started. Adapter bookkeeping after
 * the SDK reply must therefore not let a new thread's notifications overtake it.
 */
export class ThreadStartOrder {
  private pending = 0;
  private held: Message[] = [];
  private readonly heldThreads = new Set<string>();
  private readonly known = new Map<string, true>();
  constructor(private readonly limit = 512, private readonly knownLimit = 4096) {}
  private remember(id: string | undefined): void {
    if (!id) return;
    this.known.delete(id); this.known.set(id, true);
    if (this.known.size > this.knownLimit) this.known.delete(this.known.keys().next().value!);
  }
  /** A client request; returns true when its reply must precede the new thread's notifications. */
  begin(method: string, params: Message): boolean {
    this.remember(typeof params.threadId === "string" ? params.threadId : undefined);
    if (!creates.has(method)) return false;
    this.pending++; return true;
  }
  /** Notifications to write now, in order. Empty while a new thread waits for its reply. */
  admit(message: Message): Message[] {
    const id = threadOf(message);
    if (id && (this.heldThreads.has(id) || (this.pending > 0 && !this.known.has(id)))) {
      this.heldThreads.add(id); this.held.push(message);
      return this.held.length > this.limit ? this.release(() => true) : [];
    }
    this.remember(id); return [message];
  }
  /** After a begun request's reply or error is written: held notifications to write now, in order. */
  settle(createdThreadId?: string): Message[] {
    this.pending = Math.max(0, this.pending - 1);
    this.remember(createdThreadId);
    return this.release(message => this.pending === 0 || threadOf(message) === createdThreadId);
  }
  private release(selected: (message: Message) => boolean): Message[] {
    const now: Message[] = []; const later: Message[] = [];
    for (const message of this.held) (selected(message) ? now : later).push(message);
    this.held = later; this.heldThreads.clear();
    for (const message of later) { const id = threadOf(message); if (id) this.heldThreads.add(id); }
    for (const message of now) this.remember(threadOf(message));
    return now;
  }
}
