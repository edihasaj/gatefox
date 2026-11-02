import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect, createServer as createTcpServer, Socket, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailnetFetch } from "../tailnet.js";
import { ProviderError } from "../providers/provider.js";
import { upstream, until } from "./tailnet-fixture.js";

const init = { method: "POST", headers: { Authorization: "Bearer tailnet-secret" }, body: "{}" };
const toLoopback = (port: number) => (): Socket => netConnect({ host: "127.0.0.1", port });

test("the default route dials the checked address, never the host name", async () => {
  const target = await upstream(); const dialed: Array<[string, number]> = [];
  try {
    const send = (resolved: string, url: string) => tailnetFetch("qwen", { resolve: async () => [resolved], connect: (host, port) => { dialed.push([host, port]); return toLoopback(target.port)(); } })(url, init);
    assert.equal((await send("100.108.115.57", "http://dgx.example:4000/x")).status, 200);
    assert.equal((await send("fd7a:115c:a1e0::1", "http://dgx.example/x")).status, 200);
    assert.equal((await tailnetFetch("qwen", { connect: (host, port) => { dialed.push([host, port]); return toLoopback(target.port)(); } })("http://[fd7a:115c:a1e0::2]:4100/x", init)).status, 200);
    assert.deepEqual(dialed, [["100.108.115.57", 4000], ["fd7a:115c:a1e0::1", 80], ["fd7a:115c:a1e0::2", 4100]]);
  } finally { target.close(); }
});

test("the request carries an exact Content-Length in bytes and is not chunked", async () => {
  const target = await upstream(); const body = JSON.stringify({ text: "héllo ✓" });
  try {
    const send = tailnetFetch("qwen", { resolve: async () => ["100.108.115.57"], connect: toLoopback(target.port) });
    await (await send("http://dgx.example:4000/x", { ...init, body })).text();
    assert.deepEqual(target.framing, [{ length: String(Buffer.byteLength(body)), chunked: false }]);
    // A GET carries no body and no length header.
    await (await send("http://dgx.example:4000/models", { method: "GET", headers: init.headers })).text();
    assert.deepEqual(target.framing[1], { length: undefined, chunked: false });
  } finally { target.close(); }
});

/** A server that answers every connection with the given raw bytes. */
async function raw(bytes: string): Promise<{ server: TcpServer; port: number; open: () => number }> {
  const sockets = new Set<Socket>();
  const server = createTcpServer(socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {}); socket.once("data", () => socket.write(bytes)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { server, port: (server.address() as { port: number }).port, open: () => sockets.size };
}

test("an odd status line fails the request with a fixed error instead of crashing the process", async () => {
  for (const line of ["HTTP/1.1 999 X\r\ncontent-length: 0\r\n\r\n", "HTTP/1.1 600 Odd\r\ncontent-length: 0\r\n\r\n"]) {
    const fixture = await raw(line); let crashed: unknown;
    const onCrash = (error: unknown): void => { crashed = error; }; process.once("uncaughtException", onCrash);
    try {
      const send = tailnetFetch("qwen", { resolve: async () => ["100.108.115.57"], connect: toLoopback(fixture.port) });
      await assert.rejects(send("http://dgx.example:4000/x", init), (error: unknown) => error instanceof ProviderError && ["upstream_error", "upstream_unavailable"].includes(error.code) && !/999|600/.test(error.message), JSON.stringify(line));
      assert.equal(crashed, undefined, "no uncaught exception"); assert.ok(await until(() => fixture.open() === 0), "the socket was released");
    } finally { process.off("uncaughtException", onCrash); fixture.server.close(); }
  }
  // A control character in the reason phrase must not reach the Response constructor: the reason is dropped and the answer stands.
  const odd = await raw("HTTP/1.1 200 OK\x01\r\ncontent-length: 2\r\n\r\nok");
  try { const answer = await tailnetFetch("qwen", { resolve: async () => ["100.108.115.57"], connect: toLoopback(odd.port) })("http://dgx.example:4000/x", init); assert.equal(answer.status, 200); assert.equal(answer.statusText, ""); assert.equal(await answer.text(), "ok"); }
  finally { odd.server.close(); }
  // A status Node's parser accepts but the Response constructor refuses (999): the typed error comes from our guard.
  const fixture = await raw("HTTP/1.1 999 X\r\ncontent-length: 0\r\n\r\n");
  try {
    const send = tailnetFetch("qwen", { resolve: async () => ["100.108.115.57"], connect: toLoopback(fixture.port) });
    await assert.rejects(send("http://dgx.example:4000/x", init), { code: "upstream_error", status: 502 });
  } finally { fixture.server.close(); }
});

function selfSigned(): { key: string; cert: string } | undefined {
  try {
    const directory = execFileSync("mktemp", ["-d", join(tmpdir(), "gateway-tailnet-tls-XXXXXX")]).toString().trim();
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "k.pem"), "-out", join(directory, "c.pem"), "-days", "2", "-subj", "/CN=dgx.example", "-addext", "subjectAltName=DNS:dgx.example"], { stdio: "ignore" });
    return { key: execFileSync("cat", [join(directory, "k.pem")]).toString(), cert: execFileSync("cat", [join(directory, "c.pem")]).toString() };
  } catch { return undefined; }
}

test("https verifies the certificate against the URL host, so a name mismatch is refused", { skip: selfSigned() === undefined && "openssl is not available" }, async () => {
  const { key, cert } = selfSigned()!; let served = 0;
  const server = createHttpsServer({ key, cert }, (req, res) => { served++; req.resume(); res.end("secure"); }); server.on("tlsClientError", () => {});
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = (server.address() as { port: number }).port;
  try {
    const send = tailnetFetch("qwen", { resolve: async () => ["100.108.115.57"], connect: toLoopback(port), ca: cert });
    const ok = await send("https://dgx.example/x", init); assert.equal(ok.status, 200); assert.equal(await ok.text(), "secure"); assert.equal(served, 1);
    // The same server presents a certificate for dgx.example; a URL naming another host must not accept it.
    await assert.rejects(send("https://other.example/x", init), (error: unknown) => error instanceof ProviderError
      && error.code === "upstream_unavailable" && error.upstream?.code === "ERR_TLS_CERT_ALTNAME_INVALID" && !error.upstream.retryableNetwork);
    assert.equal(served, 1, "the request never reached the handler");
    // Without the extra authority the self-signed certificate is not trusted.
    await assert.rejects(tailnetFetch("qwen", { resolve: async () => ["100.108.115.57"], connect: toLoopback(port) })("https://dgx.example/x", init),
      (error: unknown) => error instanceof ProviderError && error.code === "upstream_unavailable"
        && error.upstream?.code === "DEPTH_ZERO_SELF_SIGNED_CERT" && !error.upstream.retryableNetwork);
  } finally { server.closeAllConnections(); server.close(); }
});

test("an abort during the connect closes the socket and surfaces as an abort, not a timeout", async () => {
  const hung: Socket[] = []; const controller = new AbortController();
  const send = tailnetFetch("qwen", { connectTimeoutMs: 5000, resolve: async () => ["100.108.115.57", "100.104.232.124"], connect: () => { const socket = new Socket(); hung.push(socket); return socket; } });
  const started = Date.now(); const pending = send("http://dgx.example:4000/x", { ...init, signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
  assert.ok(Date.now() - started < 1500, "did not wait for the connect timeout"); assert.equal(hung.length, 1, "no second address after an abort"); assert.equal(hung[0].destroyed, true);
});

test("an abort while waiting for the answer or mid-stream releases the server's socket", async () => {
  const waiting: ServerResponse[] = [];
  const sockets = new Set<Socket>(); let mode = "wait";
  const server = createHttpServer((req, res) => {
    req.resume();
    if (mode === "wait") { waiting.push(res); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("data: first\n\n");
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = (server.address() as { port: number }).port;
  const send = tailnetFetch("qwen", { resolve: async () => ["100.108.115.57"], connect: toLoopback(port) });
  try {
    const first = new AbortController(); const pending = send("http://dgx.example:4000/x", { ...init, signal: first.signal });
    assert.ok(await until(() => waiting.length === 1 && sockets.size === 1)); first.abort();
    await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
    assert.ok(await until(() => sockets.size === 0), "the socket closed after an abort before the answer");
    mode = "stream"; const second = new AbortController(); const response = await send("http://dgx.example:4000/x", { ...init, signal: second.signal });
    const reader = response.body!.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
    second.abort(); await assert.rejects(reader.read()); assert.ok(await until(() => sockets.size === 0), "the socket closed after an abort mid-stream");
  } finally { server.closeAllConnections(); server.close(); }
});
