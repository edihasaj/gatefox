/**
 * The certificate for the tailnet listener: this Mac's own MagicDNS name, issued by Let's Encrypt through Tailscale's
 * `tailscale cert`. Claude Desktop accepts plain http:// only on loopback, so an endpoint an SSH host can reach must be
 * https://. The gateway fetches and renews the certificate itself; nothing is configured by hand.
 *
 * Tailscale prints the pair to standard output, and the gateway keeps it in memory only. The App Store build of Tailscale
 * is sandboxed and cannot write files outside its container ("operation not permitted"), so file output is not used.
 * No certificate, key, name or command output is logged.
 */
import { execFile } from "node:child_process";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export interface TailnetCertificate { name: string; cert: Buffer; key: Buffer; validTo: number }
export type TailscaleRun = (args: string[], timeoutMs: number) => Promise<string>;

/** The Tailscale command line, in the order a Mac usually has it: the app's own binary, then Homebrew and /usr/local. */
export const tailscaleCandidates = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];

/**
 * The environment the command runs with. The Mac app's binary is also its GUI and, started from a background service
 * with no terminal, opens as the GUI ("The Tailscale GUI failed to start") unless TAILSCALE_BE_CLI is set.
 */
export function tailscaleEnvironment(home = process.env.HOME ?? ""): Record<string, string> {
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TAILSCALE_BE_CLI: "1" };
}

export function tailscaleRunner(candidates = tailscaleCandidates): TailscaleRun | undefined {
  const binary = candidates.find(path => existsSync(path));
  if (!binary) return undefined;
  return (args, timeoutMs) => new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: tailscaleEnvironment() },
      (error, stdout) => error ? reject(new Error("Tailscale command failed")) : resolve(stdout));
  });
}

const dnsName = /^[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))+$/;

/** This Mac's MagicDNS name, only when the tailnet issues HTTPS certificates for it. */
export async function tailnetCertificateName(run: TailscaleRun | undefined = tailscaleRunner()): Promise<string | undefined> {
  if (!run) return undefined;
  let status: { Self?: { DNSName?: unknown }; CertDomains?: unknown };
  try { status = JSON.parse(await run(["status", "--json"], 10_000)); } catch { return undefined; }
  const name = typeof status.Self?.DNSName === "string" ? status.Self.DNSName.replace(/\.$/, "").toLowerCase() : "";
  const domains = Array.isArray(status.CertDomains) ? status.CertDomains.map(domain => String(domain).toLowerCase()) : [];
  return dnsName.test(name) && domains.includes(name) ? name : undefined;
}

const pemBlock = /-----BEGIN ([A-Z0-9 ]+)-----\r?\n[A-Za-z0-9+/=\r\n]+-----END \1-----/g;

/** Splits `tailscale cert --cert-file - --key-file -` output into the certificate chain and the one private key. */
export function splitTailscalePem(output: string): { cert: Buffer; key: Buffer } | undefined {
  const certs: string[] = []; const keys: string[] = [];
  for (const match of output.matchAll(pemBlock)) {
    if (match[1] === "CERTIFICATE") { if (!certs.includes(match[0])) certs.push(match[0]); }
    else if (match[1].endsWith("PRIVATE KEY")) { if (!keys.includes(match[0])) keys.push(match[0]); }
  }
  if (!certs.length || keys.length !== 1) return undefined;
  return { cert: Buffer.from(certs.join("\n") + "\n"), key: Buffer.from(keys[0] + "\n") };
}

/**
 * Asks Tailscale for this Mac's certificate. Tailscale keeps its own copy and renews it before it
 * expires, so calling this again is cheap and returns the renewed pair. Returns undefined, without throwing, when
 * Tailscale is missing, logged out, or the tailnet has HTTPS certificates turned off.
 */
export async function fetchTailnetCertificate(stateDirectory: string, run: TailscaleRun | undefined = tailscaleRunner()): Promise<TailnetCertificate | undefined> {
  // 1.9.6 kept a copy of the pair here; the gateway no longer writes one.
  await rm(join(stateDirectory, "tailnet-tls"), { recursive: true, force: true }).catch(() => {});
  const name = await tailnetCertificateName(run);
  if (!name || !run) return undefined;
  let output: string;
  try { output = await run(["cert", "--cert-file", "-", "--key-file", "-", name], 120_000); } catch { return undefined; }
  const pair = splitTailscalePem(output);
  if (!pair) return undefined;
  try {
    const parsed = new X509Certificate(pair.cert);
    const validTo = Date.parse(parsed.validTo);
    if (!parsed.checkHost(name) || !parsed.checkPrivateKey(createPrivateKey(pair.key)) || !Number.isFinite(validTo) || validTo <= Date.now()) return undefined;
    return { name, cert: pair.cert, key: pair.key, validTo };
  } catch { return undefined; }
}
