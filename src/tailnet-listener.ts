/**
 * Opt-in second socket for the inference server on this Mac's own Tailscale addresses. Claude Desktop sends an SSH
 * session's inference to the endpoint in its profile from the remote host, and it refuses a loopback endpoint for those
 * sessions, so a profile that should work over SSH needs an address the host can reach. See docs/claude-desktop-direct.md.
 *
 * The socket parses nothing itself: an accepted connection from a tailnet peer is handed to the existing HTTP server, so
 * authentication, admission, timeouts and in-place upgrades are exactly the loopback listener's. A peer outside the
 * tailnet is closed before a byte is read. The listeners live on the process, not on one release's runtime, so a hot swap
 * keeps them and only reconciles them with the configuration it adopted.
 */
import type { Server } from "node:http";
import { createServer as createSocketServer, type AddressInfo, type Server as SocketServer, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { isTailnetAddress } from "./tailnet.js";
import { telemetry } from "./telemetry.js";

/** Every non-internal Tailscale address of this Mac, IPv4 first, without duplicates. */
export function tailnetInterfaceAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const found = new Set<string>();
  for (const entries of Object.values(interfaces)) for (const entry of entries ?? []) {
    if (!entry.internal && isTailnetAddress(entry.address)) found.add(entry.address);
  }
  return [...found].sort((a, b) => Number(a.includes(":")) - Number(b.includes(":")) || a.localeCompare(b));
}

/** A connection is served only when its peer is a Tailscale address; anything else is closed before it is read. */
export function admitTailnetPeer(socket: Pick<Socket, "remoteAddress" | "destroy">): boolean {
  if (isTailnetAddress(socket.remoteAddress ?? "")) return true;
  socket.destroy(); return false;
}

export interface TailnetListenerSeams {
  /** The addresses to listen on; production reads this Mac's interfaces. */
  addresses?: () => string[];
  /** Peer admission; tests on loopback admit their own connections. */
  admit?: (socket: Socket) => boolean;
}

interface ListenerSet { target: Server; port: number; sockets: Map<string, SocketServer> }
const processKey = Symbol.for("gatefox.tailnetListeners.v1");
type ProcessHolder = { [processKey]?: ListenerSet };
const holder = globalThis as ProcessHolder;

function boundPort(target: Server): number | undefined {
  const address = target.address();
  return address && typeof address === "object" ? (address as AddressInfo).port : undefined;
}

function closeAll(set: ListenerSet): void {
  for (const socket of set.sockets.values()) socket.close();
  set.sockets.clear();
}

function listen(set: ListenerSet, address: string, admit: (socket: Socket) => boolean): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createSocketServer(connection => { if (admit(connection)) set.target.emit("connection", connection); });
    const failed = (): void => { socket.close(); resolve(false); };
    socket.once("error", failed);
    socket.listen({ host: address, port: set.port, exclusive: true }, () => {
      socket.off("error", failed);
      // A later failure (the address left the interface) only closes this socket; the next reconcile retries it.
      socket.on("error", () => { socket.close(); if (set.sockets.get(address) === socket) set.sockets.delete(address); });
      set.sockets.set(address, socket); resolve(true);
    });
  });
}

/**
 * Makes the tailnet sockets match `enabled` and this Mac's current Tailscale addresses, on the loopback server's own port.
 * Returns the addresses now served. Never throws: an address that cannot be bound yet is tried again on the next call.
 */
export async function reconcileTailnetListener(target: Server, enabled: boolean, seams: TailnetListenerSeams = {}): Promise<string[]> {
  let set = holder[processKey];
  const port = boundPort(target);
  if (set && (set.target !== target || set.port !== port || !enabled)) { closeAll(set); set = undefined; holder[processKey] = undefined; }
  if (!enabled || port === undefined) return [];
  if (!set) { set = { target, port, sockets: new Map() }; holder[processKey] = set; target.once("close", () => { if (holder[processKey] === set) { closeAll(set!); holder[processKey] = undefined; } }); }
  const wanted = new Set(seams.addresses ? seams.addresses() : tailnetInterfaceAddresses());
  for (const [address, socket] of set.sockets) if (!wanted.has(address)) { socket.close(); set.sockets.delete(address); }
  const admit = seams.admit ?? admitTailnetPeer;
  let added = 0;
  for (const address of wanted) if (!set.sockets.has(address) && await listen(set, address, admit)) added++;
  if (added) telemetry("tailnet_listener", { state: "listening", addresses: set.sockets.size });
  return [...set.sockets.keys()];
}

/** The addresses the tailnet listener currently serves in this process. */
export function tailnetListenerAddresses(): string[] {
  return [...(holder[processKey]?.sockets.keys() ?? [])];
}
