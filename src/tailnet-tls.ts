/**
 * The certificate for the tailnet listener: this Mac's own MagicDNS name, issued by Let's Encrypt through Tailscale's
 * `tailscale cert`. Claude Desktop accepts plain http:// only on loopback, so an endpoint an SSH host can reach must be
 * https://. The gateway fetches and renews the certificate itself; nothing is configured by hand.
 *
 * The key stays in an owner-only directory under the gateway's state directory. No certificate, key, name or command
 * output is logged.
 */
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface TailnetCertificate { name: string; cert: Buffer; key: Buffer; validTo: number }
export type TailscaleRun = (args: string[], timeoutMs: number) => Promise<string>;

/** The Tailscale command line, in the order a Mac usually has it: the app's own binary, then Homebrew and /usr/local. */
export const tailscaleCandidates = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];

export function tailscaleRunner(candidates = tailscaleCandidates): TailscaleRun | undefined {
  const binary = candidates.find(path => existsSync(path));
  if (!binary) return undefined;
  return (args, timeoutMs) => new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME ?? "" } },
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

/**
 * Asks Tailscale for this Mac's certificate and reads it back. Tailscale keeps its own copy and renews it before it
 * expires, so calling this again is cheap and returns the renewed pair. Returns undefined, without throwing, when
 * Tailscale is missing, logged out, or the tailnet has HTTPS certificates turned off.
 */
export async function fetchTailnetCertificate(stateDirectory: string, run: TailscaleRun | undefined = tailscaleRunner()): Promise<TailnetCertificate | undefined> {
  const name = await tailnetCertificateName(run);
  if (!name || !run) return undefined;
  const directory = join(stateDirectory, "tailnet-tls");
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const certFile = join(directory, "cert.pem"); const keyFile = join(directory, "key.pem");
  try { await run(["cert", "--cert-file", certFile, "--key-file", keyFile, name], 120_000); } catch { return undefined; }
  try {
    await chmod(keyFile, 0o600);
    const [cert, key] = await Promise.all([readFile(certFile), readFile(keyFile)]);
    const parsed = new X509Certificate(cert);
    const validTo = Date.parse(parsed.validTo);
    if (!parsed.checkHost(name) || !Number.isFinite(validTo) || validTo <= Date.now()) return undefined;
    return { name, cert, key, validTo };
  } catch { return undefined; }
}
