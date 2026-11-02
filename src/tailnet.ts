import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, connect as tcpConnect, isIP, type Socket } from "node:net";
import { Readable } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { ProviderError } from "./providers/provider.js";
import { telemetry } from "./telemetry.js";
import { networkProviderError } from "./providers/network-error.js";

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
  /** Opens the TCP connection to the (already checked and routed) host and port. Tests pass a socket that never connects. */
  connect?: (host: string, port: number) => Socket;
  /** Extra certificate authority for an `https:` base URL; tests trust a self-signed certificate here. */
  ca?: string | Buffer;
}

const systemResolve = async (host: string): Promise<string[]> => (await dnsLookup(host, { all: true, verbatim: true })).map(entry => entry.address);
/** No resolved address is on the tailnet. Fixed text; it never names the address or host. */
const addressRefused = (): ProviderError => new ProviderError("provider_unreachable", "Provider address is not on the tailnet; the request was not sent", 502);
/** Same class and text the gateway gives any connection failure, so a router that is down stays a retryable 503. */
const connectionFailed = (error?: unknown): ProviderError => networkProviderError(error, "connect")
  ?? new ProviderError("upstream_unavailable", "Provider connection failed or disconnected; retry when its connection is available", 503);
const badResponse = (): ProviderError => new ProviderError("upstream_error", "Provider returned an invalid response", 502);
const aborted = (signal: AbortSignal | undefined): unknown => signal?.reason ?? new DOMException("The operation was aborted", "AbortError");

function dialSocket(open: () => Socket, timeoutMs: number, signal: AbortSignal | undefined): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = open();
    const finish = (error?: Error): void => {
      clearTimeout(timer); socket.off("error", finish); socket.off("connect", onConnect); signal?.removeEventListener("abort", onAbort);
      if (error) { socket.destroy(); reject(error); } else resolve(socket);
    };
    const onConnect = (): void => finish();
    const onAbort = (): void => finish(new Error("aborted"));
    const timer = setTimeout(() => finish(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })), timeoutMs);
    socket.once("connect", onConnect); socket.once("error", finish);
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface TailnetRequest { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }

/**
 * A `fetch` replacement for a tailnet provider (the chat transport and its model discovery). It resolves the host, drops every
 * address that is not a Tailscale address (recording `provider_address_refused` with fixed fields), and fails with a fixed
 * `provider_unreachable` error, before any connection is opened, when none is left. Connection establishment walks the remaining
 * addresses in order and fails with the retryable `upstream_unavailable` when none connects; once a connection is made the
 * request is sent on it and never replayed on another address. Redirects are refused.
 */
export function tailnetFetch(providerId: string, seams: TailnetSeams = {}): (url: string, init: TailnetRequest) => Promise<Response> {
  const resolve = seams.resolve ?? systemResolve; const route = seams.dial ?? ((address: string, port: number) => ({ host: address, port })); const timeoutMs = seams.connectTimeoutMs ?? 3000;
  const open = seams.connect ?? ((host: string, port: number) => tcpConnect({ host, port }));
  return async (location, init) => {
    const url = new URL(location);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw addressRefused();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let answers: string[];
    try { answers = isIP(host) ? [host] : await resolve(host); }
    catch (error) { if (init.signal?.aborted) throw aborted(init.signal); throw connectionFailed(error); }
    const allowed = [...new Set(answers.filter(isTailnetAddress))];
    if (answers.some(address => !isTailnetAddress(address))) telemetry("provider_address_refused", { provider: providerId, reason: "not_tailnet" });
    // A name that does not resolve at all is an ordinary connection failure, not a refusal.
    if (!answers.length) throw connectionFailed();
    if (!allowed.length) throw addressRefused();
    const secure = url.protocol === "https:"; const port = Number(url.port) || (secure ? 443 : 80);
    let socket: Socket | undefined; const failures: unknown[] = [];
    for (const address of allowed) {
      const target = route(address, port);
      try { socket = await dialSocket(() => open(target.host, target.port), timeoutMs, init.signal); break; }
      catch (error) { if (init.signal?.aborted) throw aborted(init.signal); if (failures.length < 9) failures.push(error); }
    }
    if (!socket) throw connectionFailed(new AggregateError(failures));
    const body = init.body === undefined ? undefined : Buffer.from(init.body);
    const stream = secure ? tlsConnect({ socket, servername: isIP(host) ? undefined : host, ...(seams.ca ? { ca: seams.ca } : {}) }) : socket;
    return await new Promise<Response>((done, fail) => {
      const send = secure ? httpsRequest : httpRequest;
      const outgoing = send({ method: init.method, host, port, path: `${url.pathname}${url.search}`, createConnection: () => stream, signal: init.signal,
        headers: init.headers }, (incoming: IncomingMessage) => {
        // This runs inside the HTTP parser's callback: nothing here may throw, or the process dies.
        try {
          const status = incoming.statusCode ?? 0;
          // A redirect is never followed: it could carry the bearer to another host.
          if (status >= 300 && status < 400) throw new ProviderError("upstream_error", "Provider redirected the request; redirects are not followed", 502);
          if (!Number.isInteger(status) || status < 200 || status > 599) throw badResponse();
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) for (const item of [value].flat()) if (item !== undefined) headers.append(name, item);
          done(new Response([204, 205].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers }));
        } catch (error) { incoming.destroy(); stream.destroy(); fail(error instanceof ProviderError ? error : badResponse()); }
      });
      outgoing.once("error", error => { stream.destroy(); fail(init.signal?.aborted ? error : connectionFailed(error)); });
      // One end(body) call lets Node frame the request with an exact Content-Length instead of chunked encoding.
      outgoing.end(body);
    });
  };
}
