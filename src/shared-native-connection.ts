import type { Message } from "./app-server-connection.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";

/** Native process ownership and native transport ownership are distinct. */
export interface NativeRpcConnection {
  readonly shared?: boolean;
  readonly closed: boolean;
  readonly ready?: Promise<void>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly drained: Promise<void>;
  request(method: string, params: Message): Promise<Message>;
  send(message: Message): void;
  stop(): void;
}
export type NativeConnectionFactory = (args: string[], onMessage: (message: Message) => Promise<void>, onExit: () => void) => NativeRpcConnection;

/** Disconnecting this client never signals the shared original-native SDK. */
export class SharedNativeConnection implements NativeRpcConnection {
  readonly shared = true;
  private readonly socket: SocketAppServerConnection;
  readonly ready: Promise<void>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  constructor(socketPath: string, onMessage: (message: Message) => Promise<void>, onExit: () => void, private readonly defaultCwd?: string) {
    this.socket = new SocketAppServerConnection(socketPath, onMessage, onExit, { drainOnClose: true });
    this.ready = this.socket.ready; this.exited = this.socket.exited;
  }
  get closed(): boolean { return this.socket.closed; }
  get drained(): Promise<void> { return this.socket.drained; }
  request(method: string, params: Message): Promise<Message> {
    const scoped = this.defaultCwd && method === "thread/start" && params.cwd == null ? { ...params, cwd: this.defaultCwd } : params;
    return this.socket.request(method, scoped);
  }
  send(message: Message): void { this.socket.send(message); }
  stop(): void { this.socket.stop(); }
}
