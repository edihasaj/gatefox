import { WebSocket } from "ws";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { GatewayConfig } from "./config.js";
import { object, isId, type Message } from "./app-server-connection.js";
import { nativeRegistrationRecord } from "./native-pause.js";
import { telemetry } from "./telemetry.js";

/** The private socket a running relay listens on inside its own control home. */
export const relaySocketPath = (home: string): string => resolve(home, "app-server-control/app-server-control.sock");

/** Whether a process can reach the relay's socket at all; it never speaks the protocol here. */
async function relayReachable(home: string): Promise<boolean> {
  return new Promise<boolean>(done => {
    const socket = connect({ path: relaySocketPath(home) });
    let settled = false;
    const settle = (value: boolean): void => { if (settled) return; settled = true; socket.destroy(); done(value); };
    socket.setTimeout(1000);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
    socket.once("close", () => settle(false));
  });
}

/**
 * The relay a caller may use right now, or nothing. A machine without a relay,
 * one that is registered but not connected, and one whose socket is dead all
 * return undefined so the app engine keeps its own remote control; only a real
 * registration says anything was skipped.
 */
export async function activeNativeRelay(config: GatewayConfig, reachable: (home: string) => Promise<boolean> = relayReachable): Promise<{ home: string; nativeHome: string } | undefined> {
  const registration = await nativeRegistration(config);
  if (!registration) {
    if (await nativeRegistrationRecord(config.stateDirectory)) telemetry("native_relay_skipped", { reason: "not_registered" });
    return;
  }
  let status: unknown;
  try { status = JSON.parse(await readFile(resolve(registration.home, "status.json"), "utf8")); }
  catch { telemetry("native_relay_skipped", { reason: "not_connected" }); return; }
  if (object(status).status !== "connected") { telemetry("native_relay_skipped", { reason: "not_connected" }); return; }
  if (!await reachable(registration.home)) { telemetry("native_relay_skipped", { reason: "unreachable" }); return; }
  return registration;
}

export function nativeRelayHome(configPath: string, nativeHome: string): string {
  return resolve(homedir(), ".local/state/gw-native", createHash("sha256").update(resolve(configPath) + "\0" + resolve(nativeHome)).digest("hex").slice(0, 16));
}

export async function nativeRegistration(config: GatewayConfig): Promise<{ home: string; nativeHome: string } | undefined> {
  let value: unknown;
  try { value = JSON.parse(await readFile(resolve(config.stateDirectory, "native-registration.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Native relay registration is unreadable"); }
  const saved = object(value);
  if (saved.registered !== true) return;
  const nativeHome = resolve(process.env.CODEX_HOME || resolve(homedir(), ".codex"));
  if (saved.nativeHome !== nativeHome) return;
  if (typeof saved.home !== "string" || !saved.home.startsWith(resolve(homedir(), ".local/state/gw-native") + "/")) throw new Error("Native relay control home is invalid");
  return { home: saved.home, nativeHome };
}

/** Only the SDK's real remote-control state and methods cross this private socket. */
export class NativeControl {
  private socket!: WebSocket;
  private ready!: Promise<void>;
  private stopped = false;
  private reconnect?: NodeJS.Timeout;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: Message) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private readonly home: string, private readonly emit: (message: Message) => Promise<void>) { this.connect(); }
  private connect(): void {
    const socket = new WebSocket(`ws+unix://${relaySocketPath(this.home)}:/`, { maxPayload: 16 * 1024 * 1024 }); this.socket = socket;
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.terminate(); reject(new Error("Native connected-machine relay handshake timed out")); }, 5000).unref();
      socket.once("open", () => { clearTimeout(timeout); resolve(); });
      socket.once("error", () => { clearTimeout(timeout); reject(new Error("Native connected-machine relay is unavailable; check gateway native status")); });
      socket.once("close", () => { clearTimeout(timeout); reject(new Error("Native connected-machine relay disconnected")); });
    });
    void this.ready.catch(() => undefined);
    socket.on("message", data => {
      let message: Message; try { message = object(JSON.parse(data.toString())); } catch { socket.terminate(); return; }
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const request = this.pending.get(message.id)!; this.pending.delete(message.id); clearTimeout(request.timer);
        const error = object(message.error); message.error ? request.reject(Object.assign(new Error(String(error.message || "Native relay request failed")), { code: error.code, data: error.data })) : request.resolve(object(message.result));
      } else if (message.method === "remoteControl/status/changed" && !isId(message.id)) void this.emit(message).catch(() => socket.terminate());
    });
    socket.on("close", () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error("Native connected-machine relay disconnected")); } this.pending.clear();
      if (!this.stopped) this.reconnect = setTimeout(() => this.connect(), 1000).unref();
    });
  }
  async request(method: string, params: Message): Promise<Message> {
    await this.ready;
    if (this.socket.readyState !== WebSocket.OPEN || this.pending.size >= 64) throw new Error("Native connected-machine relay is unavailable or busy");
    return new Promise((resolve, reject) => {
      const id = ++this.sequence; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Native connected-machine control timed out")); }, 45000).unref();
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close(): void { this.stopped = true; clearTimeout(this.reconnect); this.socket.terminate(); }
}
