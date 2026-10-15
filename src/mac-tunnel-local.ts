import { hostname, networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/** A local listener as providers see it: `wildcard` when it is reachable beyond the loopback address. */
export interface ReachableListener { port: number; wildcard: boolean }

/** The eight 16-bit groups of an IPv6 address, or undefined when it is not one. */
function ipv6Groups(address: string): number[] | undefined {
  if (isIP(address) !== 6) return undefined;
  // An embedded dotted IPv4 tail (`::ffff:127.0.0.1`, as /etc/hosts may spell it) is two more groups.
  const dotted = address.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) address = `${dotted[1]}${((+dotted[2] << 8) | +dotted[3]).toString(16)}:${((+dotted[4] << 8) | +dotted[5]).toString(16)}`;
  const halves = address.split("::");
  const side = (text: string) => text === "" ? [] : text.split(":").map(part => parseInt(part, 16));
  const head = side(halves[0]); const tail = halves.length === 2 ? side(halves[1]) : [];
  return halves.length === 1 ? head : [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
}

const normalise = (host: string) => host.trim().replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "").replace(/\.+$/, "").toLowerCase();

/** The dotted IPv4 an IPv4-mapped IPv6 address carries (`::ffff:192.0.2.7`, as a resolver or a URL may spell it), or undefined. */
function mappedIPv4(groups: number[]): string | undefined {
  if (!groups.slice(0, 5).every(group => group === 0) || groups[5] !== 0xffff) return undefined;
  return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
}

/** The same address however it is written, so interface addresses compare equal to URL hosts. */
function canonical(host: string): string {
  const groups = ipv6Groups(host);
  return groups ? groups.map(group => group.toString(16)).join(":") : host;
}

/** One comparable spelling per address: an IPv4-mapped IPv6 one becomes the IPv4 it carries. */
const comparable = (raw: string) => { const host = normalise(raw); const groups = ipv6Groups(host); return (groups && mappedIPv4(groups)) || canonical(host); };

/** Whether a client using this host reaches the local machine's loopback: 127.0.0.0/8, 0.0.0.0, ::, ::1, mapped IPv4 forms, localhost. */
export function isLoopbackHost(raw: string): boolean {
  const host = normalise(raw);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) return host.startsWith("127.") || host === "0.0.0.0";
  const groups = ipv6Groups(host);
  if (!groups) return false;
  const mapped = mappedIPv4(groups);
  if (mapped) return isLoopbackHost(mapped);
  return groups.slice(0, 7).every(group => group === 0) && groups[7] <= 1; // :: and ::1
}

/** This machine's own name and addresses: where a wildcard-bound listener can also be reached. */
function isOwnHost(raw: string): boolean {
  const host = normalise(raw); const name = normalise(hostname());
  if (host === name || host === name.split(".")[0]) return true;
  const address = comparable(host);
  return Object.values(networkInterfaces()).flat().some(entry => entry !== undefined && comparable(entry.address) === address);
}

const portOf = (url: URL) => url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
/** Whether a client using this host or address reaches the listener: any loopback spelling, or (wildcard) this machine's own name and addresses. */
const hostReaches = (host: string, listener: ReachableListener) => isLoopbackHost(host) || (listener.wildcard && isOwnHost(host));

/**
 * Whether a provider baseUrl connects to the listener: same port (the scheme's default when
 * absent) and a host that reaches it. A loopback-only listener is reached through any loopback
 * spelling; a wildcard one also through this machine's own hostname and interface addresses.
 * This reads the host as written; `providerReaches` also resolves a name through DNS.
 */
export function reachesListener(baseUrl: string | undefined, listener: ReachableListener): boolean {
  if (!baseUrl) return false;
  let url: URL; try { url = new URL(baseUrl); } catch { return false; }
  return portOf(url) === listener.port && hostReaches(url.hostname, listener);
}

/** Every address a name resolves to, as the system resolver (DNS and /etc/hosts) returns them. */
export type HostLookup = (host: string) => Promise<string[]>;
export const systemLookup: HostLookup = async host => (await dnsLookup(host, { all: true, verbatim: true })).map(entry => entry.address);
const lookupTimeout = 3000;
/** A name that could not be resolved in time, or at all: whether it reaches this machine is unknown. */
export class HostLookupError extends Error { constructor(readonly host: string) { super(`Cannot resolve ${host}`); } }

async function resolveHost(host: string, lookup: HostLookup, timeoutMs: number): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new HostLookupError(host)), timeoutMs); });
    return await Promise.race([lookup(host), timeout]);
  } catch { throw new HostLookupError(host); }
  finally { clearTimeout(timer); }
}

/**
 * `reachesListener`, plus names that only point at this machine through DNS or /etc/hosts (an alias for 127.0.0.1).
 * Any loopback address reaches a loopback listener; a loopback or own-interface address reaches a wildcard one.
 * A name is looked up only when its port already matches. A failed or slow lookup throws `HostLookupError`,
 * because the answer is unknown; an IP literal or a name the text alone settles is never looked up.
 */
export async function providerReaches(baseUrl: string | undefined, listener: ReachableListener, lookup: HostLookup = systemLookup, timeoutMs = lookupTimeout): Promise<boolean> {
  if (reachesListener(baseUrl, listener)) return true;
  let url: URL; try { url = new URL(baseUrl ?? ""); } catch { return false; }
  const host = normalise(url.hostname);
  if (portOf(url) !== listener.port || host === "" || isIP(host)) return false;
  return (await resolveHost(host, lookup, timeoutMs)).some(address => hostReaches(address, listener));
}
