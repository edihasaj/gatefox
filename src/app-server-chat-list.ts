import { object, type Message } from "./app-server-connection.js";
import type { ExecutionRecord } from "./execution-host-engine.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";

/** A connection that was already opened by the adapter, or a passive socket we own. */
export interface ChatListConnection { readonly closed: boolean; request(method: string, params: Message): Promise<Message>; send?(message: Message): void; stop?(): void }
export interface ChatListSource { record: ExecutionRecord; connection?: ChatListConnection }
export type ChatListDiscovery = ChatListSource[] | { sources: ChatListSource[]; complete: boolean };
export interface ChatListOptions {
  /** Finds records without acquiring a generation. Called only after a client listed chats. */
  sources: (signal?: AbortSignal) => Promise<ChatListDiscovery | undefined>;
  initialized: () => Message | undefined;
  emit: (message: Message) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
  connection?: (path: string, onMessage: (message: Message) => Promise<void>, onExit: () => void) => SocketAppServerConnection;
}

type Source = { record: ExecutionRecord; connection: ChatListConnection; owned: boolean };
type Status = { value: unknown; epoch: number; revision: string };
type ReadResult = { thread: Message; statusEpoch: number };
type SourceThread = ReadResult & { source: Source; sourceEpoch: number };
type Reconciled = { sources: Source[]; complete: boolean };
type ReadFlight = {
  source: Source;
  id: string;
  deadline: number;
  statusEpoch: number;
  promise: Promise<ReadResult | undefined>;
  resolve: (thread: ReadResult | undefined) => void;
};
const runtimeFields = ["status", "model", "reasoningEffort", "environments", "canAcceptDirectInput"] as const;
const maxSources = 4; const maxPages = 4; const maxReads = 4; const pageSize = 100; const maxStatuses = 4096;

function status(value: unknown): boolean {
  const state = object(value); const type = state.type;
  return type === "idle" || type === "systemError" || type === "notLoaded" || (type === "active" && Array.isArray(state.activeFlags));
}
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value); }

/** A passive status bridge that never creates/resumes chats or forwards callbacks. */
export class AppServerChatList {
  private readonly observers = new Map<string, Source>();
  private readonly loadedFlights = new Map<string, Promise<Set<string>>>();
  private readonly reads = new Map<string, Map<string, ReadFlight>>();
  private readonly readQueues = new Map<string, ReadFlight[]>();
  private readonly activeReads = new Map<string, number>();
  private readonly statuses = new Map<string, Status>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private epoch = 0;
  private sourceEpoch = 0;
  private started = false;
  private reconciling?: Promise<Reconciled | undefined>;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;
  private readonly create: NonNullable<ChatListOptions["connection"]>;

  constructor(private readonly options: ChatListOptions) {
    this.timeoutMs = options.timeoutMs ?? 1900; this.intervalMs = options.intervalMs ?? 5000;
    this.create = options.connection ?? ((path, onMessage, onExit) => new SocketAppServerConnection(path, onMessage, onExit));
  }

  private async bounded<T>(operation: Promise<T>, deadline: number, onTimeout?: () => void): Promise<T | undefined> {
    const remaining = deadline - Date.now(); if (remaining <= 0) { onTimeout?.(); return; }
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([operation, new Promise<undefined>(resolve => { timer = setTimeout(() => { onTimeout?.(); resolve(undefined); }, remaining).unref(); })]); }
    finally { clearTimeout(timer); }
  }

  private begin(): number {
    this.started = true;
    if (!this.timer) this.timer = setInterval(() => { void this.reconcile(Date.now() + this.timeoutMs).catch(() => {}); }, this.intervalMs).unref();
    return Date.now() + this.timeoutMs;
  }

  private initialized(): Message {
    const original = object(this.options.initialized()); const info = object(original.clientInfo);
    return { clientInfo: { name: typeof info.name === "string" ? info.name : "codex_app_server", version: typeof info.version === "string" ? info.version : "1" }, capabilities: { experimentalApi: true } };
  }

  private forgetRevision(revision: string): void {
    this.loadedFlights.delete(revision);
    const queue = this.readQueues.get(revision);
    if (queue) {
      this.readQueues.delete(revision);
      for (const flight of queue) this.finishRead(flight, undefined);
    }
    for (const [id, cached] of this.statuses) if (cached.revision === revision) this.statuses.delete(id);
  }

  private closeObserver(revision: string): void {
    const source = this.observers.get(revision); if (!source) return;
    this.observers.delete(revision); this.sourceEpoch++; this.forgetRevision(revision); source.connection.stop?.();
  }

  private current(source: Source, sourceEpoch: number): boolean {
    return !this.stopped && sourceEpoch === this.sourceEpoch && !source.connection.closed
      && (!source.owned || this.observers.get(source.record.revision) === source);
  }

  private async passiveMessage(revision: string, message: Message): Promise<void> {
    if (message.id !== undefined || this.stopped || !this.observers.has(revision)) return;
    const params = object(message.params);
    if (message.method === "thread/started" && typeof object(params.thread).id === "string") {
      const observer = this.observers.get(revision)!;
      try {
        const released = await this.bounded(observer.connection.request("thread/unsubscribe", { threadId: object(params.thread).id }), Date.now() + this.timeoutMs, () => this.closeObserver(revision));
        if (released === undefined) this.closeObserver(revision);
      } catch { this.closeObserver(revision); }
      return;
    }
    if (!this.observeStatus(message, revision)) return;
    await this.options.emit(message); // Retain emittedAtMs and every other SDK envelope field.
  }

  /**
   * Records a status from an already-owned gateway engine. Unlike a passive
   * socket observer this deliberately does not relay it: `forward()` owns that
   * delivery, and a second relay would duplicate the SDK notification.
   */
  observeStatus(message: Message, revision: string): boolean {
    if (message.id !== undefined || this.stopped) return false;
    const params = object(message.params);
    if (message.method !== "thread/status/changed" || typeof params.threadId !== "string" || !status(params.status)) return false;
    this.statuses.set(params.threadId, { value: params.status, epoch: ++this.epoch, revision });
    while (this.statuses.size > maxStatuses) this.statuses.delete(this.statuses.keys().next().value!);
    return true;
  }

  private async open(record: ExecutionRecord, deadline: number, generation: number): Promise<Source | undefined> {
    if (this.stopped || Date.now() >= deadline) return;
    let connection: SocketAppServerConnection | undefined;
    try {
      connection = this.create(record.socketPath, message => this.passiveMessage(record.revision, message), () => {
        if (this.observers.get(record.revision)?.connection === connection) { this.observers.delete(record.revision); this.sourceEpoch++; this.forgetRevision(record.revision); }
      });
      const source: Source = { record, connection, owned: true }; this.observers.set(record.revision, source);
      const ready = await this.bounded((async () => {
        await connection.ready; await connection.request("initialize", this.initialized()); connection.send({ method: "initialized", params: {} }); return true;
      })(), deadline, () => this.closeObserver(record.revision));
      if (ready !== true || this.stopped || generation !== this.sourceEpoch || connection.closed) { this.closeObserver(record.revision); return; }
      return source;
    } catch {
      this.closeObserver(record.revision);
      return;
    }
  }

  private async reconcile(deadline: number): Promise<Reconciled | undefined> {
    if (this.stopped || Date.now() >= deadline) return;
    const work = this.reconciling ??= (async (): Promise<Reconciled | undefined> => {
      let generation = this.sourceEpoch; const controller = new AbortController(); let discovered: ChatListDiscovery | undefined;
      try { discovered = await this.bounded(this.options.sources(controller.signal), deadline, () => controller.abort()); } catch { discovered = undefined; }
      if (!discovered || this.stopped || generation !== this.sourceEpoch) { this.sourceEpoch++; for (const revision of [...this.observers.keys()]) this.closeObserver(revision); return; }
      const incoming = Array.isArray(discovered) ? discovered : discovered.sources;
      const discoveryComplete = Array.isArray(discovered) || discovered.complete;
      const desired = new Map<string, ChatListSource>();
      for (const source of incoming.slice(0, maxSources)) if (!desired.has(source.record.revision)) desired.set(source.record.revision, source);
      for (const [revision, observer] of this.observers) {
        const next = desired.get(revision);
        // A host generation can recycle a revision while its socket is replaced.
        // Drop all cache state with the old observer so it cannot reopen it later.
        if (!next || next.connection || next.record.socketPath !== observer.record.socketPath) this.closeObserver(revision);
      }
      generation = this.sourceEpoch;
      for (const source of desired.values()) {
        if (Date.now() >= deadline || this.stopped || generation !== this.sourceEpoch) break;
        if ((!source.connection || source.connection.closed) && !this.observers.has(source.record.revision)) await this.open(source.record, deadline, generation);
      }
      if (this.stopped || generation !== this.sourceEpoch) return;
      const values: Source[] = [];
      for (const source of incoming) {
        if (source.connection && !source.connection.closed) values.push({ record: source.record, connection: source.connection, owned: false });
        else { const observer = this.observers.get(source.record.revision); if (observer && !observer.connection.closed) values.push(observer); }
      }
      const active = values.slice(0, maxSources);
      return { sources: active, complete: discoveryComplete && incoming.length <= maxSources && active.length === desired.size };
    })().finally(() => { this.reconciling = undefined; });
    return await this.bounded(work, deadline, () => { for (const source of [...this.observers.values()]) if (source.owned) this.closeObserver(source.record.revision); });
  }

  private async enumerate(source: Source): Promise<Set<string>> {
    const ids = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await source.connection.request("thread/loaded/list", { limit: pageSize, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data) || result.data.some(id => typeof id !== "string")) throw new Error("Invalid gateway loaded-chat metadata");
      for (const id of result.data) ids.add(id as string);
      if (result.nextCursor == null) return ids;
      if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) throw new Error("Invalid gateway loaded-chat pagination");
      cursor = result.nextCursor; cursors.add(cursor);
    }
    throw new Error("Gateway loaded-chat pagination exceeded its bound");
  }

  private loaded(source: Source): Promise<Set<string>> {
    const current = this.loadedFlights.get(source.record.revision); if (current) return current;
    const work = this.enumerate(source).finally(() => { if (this.loadedFlights.get(source.record.revision) === work) this.loadedFlights.delete(source.record.revision); });
    this.loadedFlights.set(source.record.revision, work); return work;
  }

  private finishRead(flight: ReadFlight, thread: ReadResult | undefined): void {
    const revision = flight.source.record.revision;
    const flights = this.reads.get(revision);
    if (flights?.get(flight.id) === flight) flights.delete(flight.id);
    if (flights?.size === 0) this.reads.delete(revision);
    flight.resolve(thread);
  }

  private pumpReads(revision: string): void {
    const queue = this.readQueues.get(revision);
    if (!queue) return;
    let active = this.activeReads.get(revision) ?? 0;
    while (active < maxReads && queue.length) {
      const flight = queue.shift()!;
      if (this.stopped || flight.source.connection.closed || Date.now() >= flight.deadline) {
        this.finishRead(flight, undefined);
        continue;
      }
      active++;
      this.activeReads.set(revision, active);
      flight.statusEpoch = this.statuses.get(flight.id)?.epoch ?? 0;
      void flight.source.connection.request("thread/read", { threadId: flight.id, includeTurns: false }).then(reply => {
        const thread = object(reply.thread);
        if (thread.id !== flight.id || !status(thread.status) || object(thread.status).type === "notLoaded") return undefined;
        return { thread, statusEpoch: flight.statusEpoch };
      }).catch(() => undefined).then(thread => {
        this.finishRead(flight, thread);
      }).finally(() => {
        const remaining = (this.activeReads.get(revision) ?? 1) - 1;
        if (remaining > 0) this.activeReads.set(revision, remaining);
        else this.activeReads.delete(revision);
        this.pumpReads(revision);
      });
    }
    if (queue.length === 0) this.readQueues.delete(revision);
  }

  private read(source: Source, id: string, deadline: number): Promise<ReadResult | undefined> {
    let flights = this.reads.get(source.record.revision); if (!flights) { flights = new Map(); this.reads.set(source.record.revision, flights); }
    const current = flights.get(id);
    if (current) {
      current.deadline = Math.max(current.deadline, deadline);
      return current.promise;
    }
    let resolve!: (thread: ReadResult | undefined) => void;
    const promise = new Promise<ReadResult | undefined>(done => { resolve = done; });
    const flight: ReadFlight = { source, id, deadline, statusEpoch: 0, promise, resolve };
    flights.set(id, flight);
    const queue = this.readQueues.get(source.record.revision) ?? [];
    queue.push(flight); this.readQueues.set(source.record.revision, queue);
    this.pumpReads(source.record.revision);
    return promise;
  }

  private async sourceThreads(source: Source, candidates: ReadonlySet<string>, deadline: number): Promise<Map<string, SourceThread> | undefined> {
    const sourceEpoch = this.sourceEpoch;
    let loaded: Set<string> | undefined;
    try {
      loaded = await this.bounded(this.loaded(source), deadline, () => { if (source.owned) this.closeObserver(source.record.revision); });
    } catch {
      if (source.owned) this.closeObserver(source.record.revision);
      return;
    }
    if (!loaded || !this.current(source, sourceEpoch)) return;
    const ids = [...candidates].filter(id => loaded.has(id));
    if (this.stopped || Date.now() >= deadline) return;
    const pending = ids.map(id => ({ id, thread: this.bounded(this.read(source, id, deadline), deadline, () => { if (source.owned) this.closeObserver(source.record.revision); }) }));
    const threads = await Promise.all(pending.map(async ({ id, thread }) => ({ id, thread: await thread })));
    if (!this.current(source, sourceEpoch) || Date.now() >= deadline || threads.some(({ thread }) => thread === undefined)) return;
    const output = new Map<string, SourceThread>();
    for (const { id, thread } of threads) {
      if (thread) output.set(id, { ...thread, source, sourceEpoch });
    }
    return output;
  }

  /** Enrich only saved/notLoaded native rows that a gateway SDK says are currently loaded. */
  async hydrate(native: Message): Promise<Message> {
    if (this.stopped || !Array.isArray(native.data) || native.data.length > 500) return native;
    const deadline = this.begin();
    const candidates = new Set(native.data.map(object).filter(row => typeof row.id === "string" && object(row.status).type === "notLoaded").map(row => String(row.id)));
    const reconciled = await this.reconcile(deadline); if (!reconciled || !reconciled.sources.length || !candidates.size || Date.now() >= deadline || this.stopped) return native;
    const reads = await Promise.all(reconciled.sources.map(source => this.sourceThreads(source, candidates, deadline))).catch(() => undefined);
    if (!reads) return native;
    if (this.stopped || Date.now() >= deadline || reads.some(read => read === undefined)) return native;
    const byId = new Map<string, Message>();
    for (const threads of reads) for (const [id, cached] of threads!) {
      if (byId.has(id) || !this.current(cached.source, cached.sourceEpoch)) continue;
      const newest = this.statuses.get(id);
      if (newest?.revision === cached.source.record.revision && newest.epoch > cached.statusEpoch) {
        if (object(newest.value).type === "notLoaded") continue;
        byId.set(id, { ...cached.thread, status: newest.value });
      } else byId.set(id, cached.thread);
    }
    const data = native.data.map(value => {
      const row = object(value); if (object(row.status).type !== "notLoaded") return value;
      const live = typeof row.id === "string" ? byId.get(row.id) : undefined; if (!live) return value;
      const result: Message = { ...row }; for (const field of runtimeFields) if (field in live) result[field] = live[field];
      return result;
    });
    return { ...native, data };
  }

  /** Complete source enumeration for a future `thread/loaded/list` union. */
  async loadedIds(): Promise<Set<string> | undefined> {
    if (this.stopped) return; const deadline = this.begin(); const reconciled = await this.reconcile(deadline);
    if (!reconciled || !reconciled.complete || Date.now() >= deadline) return;
    if (reconciled.sources.length === 0) return new Set();
    const sourceEpoch = this.sourceEpoch;
    let lists: Array<{ source: Source; ids: Set<string> } | undefined>;
    try {
      lists = await Promise.all(reconciled.sources.map(async source => {
        try {
          const ids = await this.bounded(this.loaded(source), deadline, () => { if (source.owned) this.closeObserver(source.record.revision); });
          return ids && this.current(source, sourceEpoch) ? { source, ids } : undefined;
        } catch {
          if (source.owned) this.closeObserver(source.record.revision);
          return;
        }
      }));
    } catch {
      return;
    }
    if (this.stopped || Date.now() >= deadline || lists.some(ids => ids === undefined)) return;
    if (lists.some(list => !list || !this.current(list.source, sourceEpoch))) return;
    return new Set(lists.flatMap(list => [...list!.ids]));
  }

  async stop(): Promise<void> {
    this.stopped = true; this.sourceEpoch++; clearInterval(this.timer); this.timer = undefined;
    for (const revision of [...this.observers.keys()]) this.closeObserver(revision);
    // Borrowed RPCs remain coalesced until their owner settles them; late results are ignored.
  }
  get listed(): boolean { return this.started; }
  static validCursor(value: unknown): value is string { return uuid(value); }
  static canonicalCursor(value: string): string { return value.toLowerCase(); }
}
