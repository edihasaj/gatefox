import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchTailnetCertificate, splitTailscalePem, tailnetCertificateName, tailscaleEnvironment, tailscaleRunner, type TailscaleRun } from "../tailnet-tls.js";

const name = "mac.tail1234.ts.net";
function pair(subject: string, days = 2): { cert: string; key: string } | undefined {
  try {
    const directory = mkdtempSync(join(tmpdir(), "gatefox-tls-fixture-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(directory, "k.pem"), "-out", join(directory, "c.pem"), "-days", String(days), "-subj", `/CN=${subject}`, "-addext", `subjectAltName=DNS:${subject}`], { stdio: "ignore" });
    return { cert: join(directory, "c.pem"), key: join(directory, "k.pem") };
  } catch { return undefined; }
}
const status = (dns: string, domains: string[]) => JSON.stringify({ Self: { DNSName: `${dns}.` }, CertDomains: domains });
/** A fake Tailscale: `status --json` answers the given status, `cert` prints a fixture pair to stdout, as both Mac builds do. */
function fake(statusJson: string, fixture?: { cert: string; key: string }): { run: TailscaleRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: TailscaleRun = async args => {
    calls.push(args);
    if (args[0] === "status") return statusJson;
    if (args[0] === "cert" && fixture) return readFileSync(fixture.cert, "utf8") + readFileSync(fixture.key, "utf8");
    throw new Error("unexpected");
  };
  return { run, calls };
}

test("the name is this Mac's MagicDNS name only when the tailnet issues certificates for it", async () => {
  assert.equal(await tailnetCertificateName(fake(status("Mac.Tail1234.ts.net", [name])).run), name);
  assert.equal(await tailnetCertificateName(fake(status(name, [])).run), undefined, "HTTPS certificates turned off");
  assert.equal(await tailnetCertificateName(fake("not json").run), undefined);
  assert.equal(await tailnetCertificateName(fake(status("-bad..name", ["-bad..name"])).run), undefined);
  assert.equal(await tailnetCertificateName(async () => { throw new Error("Tailscale command failed"); }), undefined, "Tailscale is logged out or not running");
});

test("the Mac app's binary runs as the command line even from a background service", async () => {
  // Regression: under launchd, without TAILSCALE_BE_CLI, the app binary tried to open its GUI and every call failed.
  assert.deepEqual(tailscaleEnvironment("/Users/test"), { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/test", TAILSCALE_BE_CLI: "1" });
  const directory = mkdtempSync(join(tmpdir(), "gatefox-fake-tailscale-"));
  const binary = join(directory, "Tailscale");
  execFileSync("/bin/sh", ["-c", `printf '#!/bin/sh\\nprintf "%%s" "$TAILSCALE_BE_CLI"\\n' > '${binary}' && chmod 700 '${binary}'`]);
  assert.equal(await tailscaleRunner([join(directory, "missing"), binary])!(["status"], 5000), "1");
  assert.equal(tailscaleRunner([join(directory, "missing")]), undefined);
});

test("the certificate is read from Tailscale's output, kept in memory, and must name this Mac", { skip: !pair(name) && "openssl is not available" }, async () => {
  const state = mkdtempSync(join(tmpdir(), "gatefox-tls-state-"));
  const { run, calls } = fake(status(name, [name]), pair(name));
  // 1.9.6 left a copy of the pair in the state directory; it is removed.
  mkdirSync(join(state, "tailnet-tls")); writeFileSync(join(state, "tailnet-tls", "key.pem"), "old");
  const fetched = await fetchTailnetCertificate(state, run);
  assert.equal(fetched?.name, name); assert.ok(fetched!.validTo > Date.now());
  assert.match(fetched!.cert.toString(), /BEGIN CERTIFICATE/);
  assert.match(fetched!.key.toString(), /PRIVATE KEY/);
  // Regression: the App Store build of Tailscale is sandboxed and cannot write to the gateway's paths, so output goes to stdout.
  assert.deepEqual(calls[1], ["cert", "--cert-file", "-", "--key-file", "-", name]);
  assert.equal(existsSync(join(state, "tailnet-tls")), false);
  // A key that does not belong to the certificate is never served.
  const mine = pair(name)!; const other = pair(name)!;
  const mismatched: TailscaleRun = async args => args[0] === "status" ? status(name, [name]) : readFileSync(mine.cert, "utf8") + readFileSync(other.key, "utf8");
  assert.equal(await fetchTailnetCertificate(mkdtempSync(join(tmpdir(), "gatefox-tls-state-")), mismatched), undefined);
  // A certificate for another name is never served.
  assert.equal(await fetchTailnetCertificate(mkdtempSync(join(tmpdir(), "gatefox-tls-state-")), fake(status(name, [name]), pair("other.tail1234.ts.net")).run), undefined);
  // A failed `tailscale cert` (logged out, rate limited) is reported as unavailable, not thrown.
  assert.equal(await fetchTailnetCertificate(mkdtempSync(join(tmpdir(), "gatefox-tls-state-")), fake(status(name, [name])).run), undefined);
});

test("Tailscale's stdout is split into a deduplicated chain and exactly one key", { skip: !pair(name) && "openssl is not available" }, () => {
  const fixture = pair(name)!; const cert = readFileSync(fixture.cert, "utf8"); const key = readFileSync(fixture.key, "utf8");
  const split = splitTailscalePem(`${cert}${cert}noise\n${key}`)!;
  assert.equal(split.cert.toString().match(/BEGIN CERTIFICATE/g)?.length, 1);
  assert.match(split.key.toString(), /PRIVATE KEY/);
  assert.equal(splitTailscalePem(cert), undefined, "no key");
  assert.equal(splitTailscalePem(key), undefined, "no certificate");
  assert.equal(splitTailscalePem(cert + key + readFileSync(pair(name)!.key, "utf8")), undefined, "two keys");
});
