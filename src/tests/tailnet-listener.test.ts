import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { createServer as createSocketServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gatewayToken, validateConfig } from "../config.js";
import { buildClaudeDirectProfile, claudeSshHostAllowlist, isLoopbackEndpointHost, type ClaudeDirectListRow } from "../claude-direct-profile.js";
import type { Provider } from "../providers/provider.js";
import { startGateway } from "../server.js";
import { admitTailnetPeer, reconcileTailnetListener, tailnetInterfaceAddresses, tailnetListenerAddresses } from "../tailnet-listener.js";

const entry = (address: string, internal = false) => ({ address, internal, family: address.includes(":") ? "IPv6" as const : "IPv4" as const, netmask: "", mac: "", cidr: null, ...(address.includes(":") ? { scopeid: 0 } : {}) });

test("only this Mac's own non-internal Tailscale addresses are listened on, IPv4 first", () => {
  const found = tailnetInterfaceAddresses({
    utun4: [entry("fd7a:115c:a1e0::5"), entry("100.91.110.87"), entry("100.91.110.87")],
    en0: [entry("192.168.1.23"), entry("100.128.0.1"), entry("fe80::1")],
    lo0: [entry("127.0.0.1", true), entry("100.64.0.9", true)],
  } as never);
  assert.deepEqual(found, ["100.91.110.87", "fd7a:115c:a1e0::5"]);
  assert.deepEqual(tailnetInterfaceAddresses({ en0: [entry("192.168.1.23")] } as never), []);
});

test("a peer outside the tailnet is closed before it is served", () => {
  const peer = (remoteAddress?: string) => { let destroyed = false; return { remoteAddress, destroy: () => { destroyed = true; return undefined as never; }, get destroyed() { return destroyed; } }; };
  for (const address of ["100.100.1.1", "100.64.0.1", "fd7a:115c:a1e0::9"]) { const socket = peer(address); assert.equal(admitTailnetPeer(socket), true); assert.equal(socket.destroyed, false); }
  for (const address of ["192.168.1.5", "127.0.0.1", "::1", "::ffff:100.100.1.1", "100.128.0.1", undefined]) { const socket = peer(address); assert.equal(admitTailnetPeer(socket), false, String(address)); assert.equal(socket.destroyed, true); }
});

function get(port: number, host: string, path = "/health", headers: Record<string, string> = {}): Promise<{ status?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, headers, agent: false }, res => { let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body })); });
    req.on("error", reject); req.end();
  });
}
const listening = async (server: Server): Promise<number> => { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return (server.address() as AddressInfo).port; };
async function ipv6Loopback(): Promise<boolean> {
  const probe = createSocketServer();
  return new Promise(resolve => { probe.once("error", () => resolve(false)); probe.listen(0, "::1", () => probe.close(() => resolve(true))); });
}

test("the tailnet socket hands connections to the same server, follows the setting, and ends with the server", async t => {
  if (!await ipv6Loopback()) { t.skip("IPv6 loopback is unavailable on this machine"); return; }
  let served = 0;
  const server = createServer((_req, res) => { served++; res.end("same handler"); });
  const port = await listening(server);
  try {
    // The test stands in ::1 for a Tailscale address and admits its own loopback peer.
    const seams = { addresses: () => ["::1"], admit: () => true };
    assert.deepEqual(await reconcileTailnetListener(server, false, seams), []);
    await assert.rejects(get(port, "::1"));
    assert.deepEqual(await reconcileTailnetListener(server, true, seams), ["::1"]);
    assert.deepEqual(tailnetListenerAddresses(), ["::1"]);
    assert.deepEqual(await get(port, "::1"), { status: 200, body: "same handler" });
    assert.deepEqual(await reconcileTailnetListener(server, true, seams), ["::1"], "a second reconcile keeps the bound socket");
    // Without the test's admission, a loopback peer is not on the tailnet and is closed unread.
    assert.deepEqual(await reconcileTailnetListener(server, false, seams), []);
    assert.deepEqual(await reconcileTailnetListener(server, true, { addresses: () => ["::1"] }), ["::1"]);
    const before = served;
    await assert.rejects(get(port, "::1"));
    assert.equal(served, before, "a refused peer never reaches the handler");
    // An address that left the interface is closed on the next reconcile.
    assert.deepEqual(await reconcileTailnetListener(server, true, { addresses: () => [] }), []);
    assert.deepEqual(await reconcileTailnetListener(server, true, seams), ["::1"]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  assert.deepEqual(tailnetListenerAddresses(), [], "closing the server closes its tailnet sockets");
  await assert.rejects(get(port, "::1"));
});

test("an address that cannot be bound is skipped without failing the server", async () => {
  const server = createServer((_req, res) => res.end());
  await listening(server);
  try { assert.deepEqual(await reconcileTailnetListener(server, true, { addresses: () => ["192.0.2.55"], admit: () => true }), []); }
  finally { await reconcileTailnetListener(server, false); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("the real gateway behind the tailnet socket still requires the client token", async t => {
  if (!await ipv6Loopback()) { t.skip("IPv6 loopback is unavailable on this machine"); return; }
  const state = await mkdtemp(join(tmpdir(), "gatefox-tailnet-gateway-"));
  const provider: Provider = { async *infer() { yield { type: "done", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }; } };
  const providers = [{ id: "claude", type: "claude-subscription", label: "Claude", models: { "claude/claude-opus-5-5": "claude-opus-5-5" } }];
  const server = await startGateway(validateConfig({ version: 1, port: 0, stateDirectory: state, providers }), () => provider, undefined, { onFailure() {} });
  try {
    const port = (server.address() as AddressInfo).port;
    assert.deepEqual(await reconcileTailnetListener(server, true, { addresses: () => ["::1"], admit: () => true }), ["::1"]);
    const anthropic = { "anthropic-version": "2023-06-01" };
    const refused = await get(port, "::1", "/v1/models", anthropic);
    assert.equal(refused.status, 401); assert.match(refused.body, /Gateway client token required/);
    const token = await gatewayToken(state);
    const listed = await get(port, "::1", "/v1/models", { ...anthropic, "x-api-key": token });
    assert.equal(listed.status, 200);
    assert.deepEqual(JSON.parse(listed.body).data.map((row: { id: string }) => row.id), ["claude-opus-5-5"]);
    assert.equal((await get(port, "::1", "/v1/models", { ...anthropic, "x-api-key": token, origin: "http://evil.example" })).status, 403, "a browser origin is refused there too");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  assert.deepEqual(tailnetListenerAddresses(), []);
});

test("tailnetListener is an explicit boolean and needs a local inference server", () => {
  const base = { version: 1, port: 3457, stateDirectory: "/tmp/gatefox-tailnet-state", providers: [{ id: "claude", type: "claude-subscription", models: { "claude/opus": "claude-opus-5-5" } }] };
  assert.equal(validateConfig(base).tailnetListener, undefined);
  assert.equal(validateConfig({ ...base, tailnetListener: false }).tailnetListener, undefined);
  assert.equal(validateConfig({ ...base, tailnetListener: true }).tailnetListener, true);
  assert.throws(() => validateConfig({ ...base, tailnetListener: "yes" }), /tailnetListener must be boolean/);
  assert.throws(() => validateConfig({ version: 1, port: 3458, stateDirectory: "/tmp/gatefox-tailnet-state", providers: [], clientOnly: true, tailnetListener: true }), /needs a local inference server/);
});

const rows: ClaudeDirectListRow[] = [{ id: "claude-opus-5-5", displayName: "Claude · Opus 5.5", alias: "claude/claude-opus-5-5", native: true, efforts: ["low", "high"] }];
const tailnet = { endpoint: "http://100.91.110.87:3457", tokenFile: "/private/state/client-token" };

test("SSH hosts are written to the allowlist only with an endpoint the remote host can reach", () => {
  const profile = buildClaudeDirectProfile({}, rows, { ...tailnet, sshHosts: ["macbook-server", "MacBook-Server", "*.dev.example.com", "100.73.86.17"] });
  assert.equal(profile.inferenceGatewayBaseUrl, "http://100.91.110.87:3457");
  assert.deepEqual(profile.sshHostAllowlist, ["macbook-server", "*.dev.example.com", "100.73.86.17"]);
  // Without --ssh-host the profile's own list stays, whatever it holds.
  assert.deepEqual(buildClaudeDirectProfile({ sshHostAllowlist: ["studio"] }, rows, tailnet).sshHostAllowlist, ["studio"]);
  assert.equal(buildClaudeDirectProfile({}, rows, tailnet).sshHostAllowlist, undefined);
  for (const endpoint of ["http://127.0.0.1:3457", "http://localhost:3457", "http://[::1]:3457", "http://127.1.2.3:3457", "http://gatefox.localhost:3457"]) {
    assert.throws(() => buildClaudeDirectProfile({}, rows, { ...tailnet, endpoint, sshHosts: ["macbook-server"] }), /refuses a loopback gateway for SSH sessions/, endpoint);
  }
  assert.throws(() => claudeSshHostAllowlist(["*"]), /any host/);
  assert.throws(() => claudeSshHostAllowlist([]), /at least one host/);
  for (const bad of ["-oProxyCommand=x", "user@host", "host name", "a/b"]) assert.throws(() => claudeSshHostAllowlist([bad]), /not a hostname/, bad);
});

test("the loopback test matches Claude Desktop's literal rule and resolves nothing", () => {
  for (const host of ["localhost", "LOCALHOST.", "app.localhost", "127.0.0.1", "127.9.9.9", "[::1]", "::", "0.0.0.0", "::ffff:7f00:1"]) assert.equal(isLoopbackEndpointHost(host), true, host);
  for (const host of ["100.91.110.87", "edis-macbook-pro-1", "macbook.tail1234.ts.net", "192.168.1.23", "[fd7a:115c:a1e0::5]"]) assert.equal(isLoopbackEndpointHost(host), false, host);
});

test("configure refuses SSH hosts without a tailnet endpoint, and a tailnet endpoint the gateway does not serve", async () => {
  const run = promisify(execFile);
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "gatefox-tailnet-cli-"));
  const gatewayConfig = join(root, "gateway.json");
  await writeFile(gatewayConfig, JSON.stringify({ version: 1, port: 3457, stateDirectory: join(root, "state"), providers: [{ id: "claude", type: "claude-subscription", models: { "claude/opus": "claude-opus-5-5" } }] }), { mode: 0o600 });
  const configure = (...args: string[]) => run(process.execPath, [cli, "claude-desktop", "configure", ...args, "--gateway-config", gatewayConfig, "--home", root]);
  await assert.rejects(configure("--direct", "--ssh-host", "macbook-server"), (error: { stderr?: string }) => /--ssh-host needs --tailnet/.test(error.stderr ?? ""));
  await assert.rejects(configure("--direct", "--tailnet"), (error: { stderr?: string }) => /tailnetListener": true in the gateway configuration/.test(error.stderr ?? ""));
  await assert.rejects(configure("--tailnet"), (error: { stderr?: string }) => /only valid with --direct/.test(error.stderr ?? ""));
  await assert.rejects(run(process.execPath, [cli, "claude-desktop", "configure", "--direct", "--tailnet", "--endpoint", "http://127.0.0.1:3458", "--token-file", join(root, "token"), "--home", root]),
    (error: { stderr?: string }) => /cannot be combined with --endpoint/.test(error.stderr ?? ""));
});
