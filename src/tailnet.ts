import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, connect as tcpConnect, isIP, type Socket } from "node:net";
import { Readable } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { ProviderError } from "./providers/provider.js";
import { telemetry } from "./telemetry.js";

/**
 * Transport for a provider that may reach a plain-HTTP endpoint over Tailscale. The bearer must never leave for an address
 * outside the tailnet, so the check runs here, on each connection, on the address that is then dialed (the host is resolved
 * once and the connection is made to that literal address, so a second lookup cannot answer differently).
 */

const ipv6Tailnet = new BlockList();
ipv6Tailnet.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

/** True for a Tailscale address: IPv4 100.64.0.0/10 or IPv6 fd7a:115c:a1e0::/48. Anything else, including a mapped form, is false. */
export function isTailnetAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) { const [first, second] = address.split(".").map(Number); return first === 100 && second >= 64 && second <= 127; }
  return kind === 6 && ipv6Tailnet.check(address, "ipv6");
}

/** Test seams. Production uses the system resolver and dials the resolved address itself. */
export interface TailnetSeams {
  /** Every address the host resolves to, in resolver order. */
  resolve?: (host: string) => Promise<string[]>;
  /** Where to actually connect for a checked address; tests map a fake tailnet address to a loopback listener. */
  dial?: (address: string, port: number) => { host: string; port: number };
  /** Per-address connect timeout, 3 s by default. */
  connectTimeoutMs?: number;
}

const systemResolve = async (host: string): Promise<string[]> => (await dnsLookup(host, { all: true, verbatim: true })).map(entry => entry.address);
const unreachable = (): ProviderError => new ProviderError("provider_unreachable", "Provider is unreachable", 502);

function dialSocket(host: string, port: number, timeoutMs: number, signal: AbortSignal | null | undefined): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host, port });
    const finish = (error?: Error): void => {
      clearTimeout(timer); socket.off("error", finish); socket.off("connect", onConnect); signal?.removeEventListener("abort", onAbort);
      if (error) { socket.destroy(); reject(error); } else resolve(socket);
    };
    const onConnect = (): void => finish();
    const onAbort = (): void => finish(new Error("aborted"));
    const timer = setTimeout(() => finish(new Error("connect timeout")), timeoutMs);
    socket.once("connect", onConnect); socket.once("error", finish);
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A `fetch` replacement for the chat provider. It resolves the host, drops every address that is not a Tailscale address
 * (recording `provider_address_refused` with fixed fields), and fails with a fixed `provider_unreachable` error, before any
 * connection is opened, when none is left. Connection establishment walks the remaining addresses in order; once a connection
 * is made the request is sent on it and never replayed on another address.
 */
export function tailnetFetch(providerId: string, seams: TailnetSeams = {}): (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response> {
  const resolve = seams.resolve ?? systemResolve; const route = seams.dial ?? ((address: string, port: number) => ({ host: address, port })); const timeoutMs = seams.connectTimeoutMs ?? 3000;
  return async (location, init) => {
    const url = new URL(location);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw unreachable();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const answers = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
    const allowed = [...new Set(answers.filter(isTailnetAddress))];
    if (answers.some(address => !isTailnetAddress(address))) telemetry("provider_address_refused", { provider: providerId, reason: "not_tailnet" });
    if (!allowed.length) throw unreachable();
    const secure = url.protocol === "https:"; const port = Number(url.port) || (secure ? 443 : 80);
    let socket: Socket | undefined;
    for (const address of allowed) {
      try { const target = route(address, port); socket = await dialSocket(target.host, target.port, timeoutMs, init.signal); break; } catch { if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("The operation was aborted", "AbortError"); }
    }
    if (!socket) throw unreachable();
    const connection = socket; const body = Buffer.from(init.body);
    const stream = secure ? tlsConnect({ socket: connection, servername: isIP(host) ? undefined : host }) : connection;
    return await new Promise<Response>((done, fail) => {
      const send = secure ? httpsRequest : httpRequest;
      const outgoing = send({ method: init.method, host, port, path: `${url.pathname}${url.search}`, createConnection: () => stream, signal: init.signal,
        headers: { ...init.headers, "Content-Length": String(body.length) } }, (incoming: IncomingMessage) => {
        const status = incoming.statusCode || 502;
        // A redirect is never followed: it could carry the bearer to another host.
        if (status >= 300 && status < 400) { incoming.destroy(); stream.destroy(); fail(new Error("redirect refused")); return; }
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) for (const item of [value].flat()) if (item !== undefined) headers.append(name, item);
        done(new Response([204, 205].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, statusText: incoming.statusMessage, headers }));
      });
      outgoing.once("error", error => { stream.destroy(); fail(init.signal?.aborted ? error : unreachable()); });
      outgoing.end(body);
    });
  };
}
