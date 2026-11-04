import type { Message } from "./app-server-connection.js";
import type { NativeRpcConnection } from "./shared-native-connection.js";

/**
 * Builds a connected replacement socket, or gives up with `undefined`. It receives the wrapper's `replacement` builder, which
 * wires the new socket to the same message and exit handlers.
 */
export type ReconnectHandler = (replacement: () => NativeRpcConnection) => Promise<NativeRpcConnection | undefined>;
type Exit = { code: number | null; signal: NodeJS.Signals | null };

/**
 * The adapter's connection to the execution host's shared native engine, kept as one object while the socket under it is
 * replaced. A host restart (a release move, an unhealthy-host restart) closes the host's control connection and its native
 * engine socket together. The adapter used to end its whole session for that, and ChatGPT shows "hit a snag" when its
 * app-server session ends. With a reconnect handler, a lost socket is offered to it first: while it reconnects, requests and
 * sends wait, and the outer `exited`/`drained` stay open, so nothing in the adapter or the app sees an exit. When the handler
 * gives up (or there is none, or the connection was stopped), the outer connection exits exactly as the socket did: the exit
 * callback runs at once and `drained` follows the last socket's own drain.
 */
export class ReconnectingNativeConnection implements NativeRpcConnection {
  readonly shared = true;
  readonly exited: Promise<Exit>;
  readonly drained: Promise<void>;
  private inner: NativeRpcConnection;
  private reconnecting?: Promise<unknown>;
  private ended = false;
  private stopped = false;
  private finishExit!: (value: Exit) => void;
  private finishDrain!: () => void;
  /** Resolved when the connection ends, so a request held by a repair is released at once by a stop. */
  private finishEnded!: () => void;
  private readonly endedSignal = new Promise<void>(resolve => { this.finishEnded = resolve; });
  /** Set by the adapter once it can reconnect; until then a lost socket ends the connection as before. */
  reconnect?: ReconnectHandler;
  /** How many replacement sockets this wrapper has adopted. */
  generation = 0;

  /** `connect` builds one socket with this wrapper's handlers; `onExit` is the adapter's exit path, called once on a real end. */
  constructor(private readonly connect: (onExit: () => void) => NativeRpcConnection, private readonly onExit: () => void) {
    this.exited = new Promise(resolve => { this.finishExit = resolve; });
    this.drained = new Promise(resolve => { this.finishDrain = resolve; });
    this.inner = this.build();
  }
  get ready(): Promise<void> | undefined { return this.inner.ready; }
  get closed(): boolean { return this.ended; }
  /** Whether a socket loss is being repaired right now. */
  get repairing(): boolean { return this.reconnecting !== undefined; }

  private build(): NativeRpcConnection {
    const connection: NativeRpcConnection = this.connect(() => { void this.lost(connection); });
    return connection;
  }
  private async lost(connection: NativeRpcConnection): Promise<void> {
    // A replacement that closes before it is adopted is not current; the result check below covers it.
    if (connection !== this.inner || this.ended || this.reconnecting) return;
    const handler = this.stopped ? undefined : this.reconnect;
    if (handler) {
      const repair = handler(() => this.build()).catch(() => undefined);
      this.reconnecting = repair;
      let next: NativeRpcConnection | undefined;
      try { next = await repair; } finally { this.reconnecting = undefined; }
      if (next && !this.stopped && !this.ended && !next.closed) { this.inner = next; this.generation++; return; }
      next?.stop();
    }
    this.end(connection);
  }
  private end(connection: NativeRpcConnection): void {
    if (this.ended) return;
    this.ended = true; this.finishEnded();
    void connection.exited.then(value => this.finishExit(value), () => this.finishExit({ code: null, signal: null }));
    void connection.drained.catch(() => undefined).then(() => this.finishDrain());
    this.onExit();
  }
  async request(method: string, params: Message): Promise<Message> {
    if (this.reconnecting) await Promise.race([this.reconnecting, this.endedSignal]);
    if (this.ended) throw Object.assign(new Error("The native engine connection closed"), { code: -32001 });
    return this.inner.request(method, params);
  }
  send(message: Message): void {
    if (this.reconnecting) { void Promise.race([this.reconnecting, this.endedSignal]).then(() => { if (!this.ended) this.inner.send(message); }); return; }
    if (!this.ended) this.inner.send(message);
  }
  /** Closes the current socket so the reconnect handler takes over; unlike `stop`, the connection may continue. */
  drop(): void { if (!this.ended && !this.reconnecting) this.inner.stop(); }
  stop(): void {
    this.stopped = true;
    // A repair in progress is abandoned: its result is stopped when it arrives, and the connection ends now.
    if (this.reconnecting) { this.end(this.inner); return; }
    this.inner.stop();
  }
}
