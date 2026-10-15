import { hostname, networkInterfaces } from "node:os";
import { isIP } from "node:net";

/** A local listener as providers see it: `wildcard` when it is reachable beyond the loopback address. */
export interface ReachableListener { port: number; wildcard: boolean }

/** The eight 16-bit groups of an IPv6 address, or undefined when it is not one. */
function ipv6Groups(address: string): number[] | undefined {
  if (isIP(address) !== 6) return undefined;
  const halves = address.split("::");
  const side = (text: string) => text === "" ? [] : text.split(":").map(part => parseInt(part, 16));
  const head = side(halves[0]); const tail = halves.length === 2 ? side(halves[1]) : [];
  return halves.length === 1 ? head : [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
}

const normalise = (host: string) => host.trim().replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "").replace(/\.+$/, "").toLowerCase();

/** The same address however it is written, so interface addresses compare equal to URL hosts. */
function canonical(host: string): string {
  const groups = ipv6Groups(host);
  return groups ? groups.map(group => group.toString(16)).join(":") : host;
}

/** Whether a client using this host reaches the local machine's loopback: 127.0.0.0/8, 0.0.0.0, ::, ::1, mapped IPv4 forms, localhost. */
export function isLoopbackHost(raw: string): boolean {
  const host = normalise(raw);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) return host.startsWith("127.") || host === "0.0.0.0";
  const groups = ipv6Groups(host);
  if (!groups) return false;
  if (groups.slice(0, 7).every(group => group === 0)) return groups[7] <= 1; // :: and ::1
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return isLoopbackHost(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
  }
  return false;
}

/** This machine's own name and addresses: where a wildcard-bound listener can also be reached. */
function isOwnHost(raw: string): boolean {
  const host = normalise(raw); const name = normalise(hostname());
  if (host === name || host === name.split(".")[0]) return true;
  return Object.values(networkInterfaces()).flat().some(entry => entry !== undefined && canonical(normalise(entry.address)) === canonical(host));
}

/**
 * Whether a provider baseUrl connects to the listener: same port (the scheme's default when
 * absent) and a host that reaches it. A loopback-only listener is reached through any loopback
 * spelling; a wildcard one also through this machine's own hostname and interface addresses.
 */
export function reachesListener(baseUrl: string | undefined, listener: ReachableListener): boolean {
  if (!baseUrl) return false;
  let url: URL; try { url = new URL(baseUrl); } catch { return false; }
  if ((url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80) !== listener.port) return false;
  return isLoopbackHost(url.hostname) || (listener.wildcard && isOwnHost(url.hostname));
}
