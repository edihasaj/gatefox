import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { createServer, createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { WebSocket } from "ws";
import { deviceKeyForAddress } from "../device-key.js";
import { gatewayClientDevice, shimSessionDevice } from "../shim-session.js";
import { proxyDevice, proxyNative } from "../codex-shim.js";
import { DEVICE_HEADER, sshProxyDeviceHeader } from "../ssh-proxy-header.js";
import { serveUnix } from "../unix-transport.js";
import { shortFolder } from "./short-folder.js";

test("device keys are salted, deterministic 32-hex pseudonyms", () => {
  const salt = Buffer.alloc(32, 7), address = "198.51.100.24";
  const key = deviceKeyForAddress(salt, address);
  assert.match(key, /^[0-9a-f]{32}$/); assert.equal(key, deviceKeyForAddress(salt, address)); assert.notEqual(key, deviceKeyForAddress(salt, "198.51.100.25")); assert.equal(key.includes(address), false);
});

test("only the first well-formed notification can identify a shim client", () => {
  const key = "a".repeat(32), hello = { method: "gateway/client", params: { device: key } };
  assert.equal(gatewayClientDevice(hello, true, false), key);
  assert.equal(gatewayClientDevice({ ...hello, id: 1 }, true, false), undefined);
  assert.equal(gatewayClientDevice({ ...hello, params: { device: "no" } }, true, false), undefined);
  assert.equal(gatewayClientDevice(hello, false, false), undefined);
  assert.equal(gatewayClientDevice(hello, true, true), undefined);
});

test("a registered relay does not classify an unlabelled session as relay", () => {
  assert.equal(shimSessionDevice({ home: "/relay", nativeHome: "/native" }), "local");
});

async function transformed(device: string | undefined, chunks: readonly (string | Buffer)[]): Promise<Buffer> {
  const header = sshProxyDeviceHeader(device); if (!header) return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  const output: Buffer[] = []; header.on("data", chunk => output.push(Buffer.from(chunk)));
  const ended = once(header, "end"); for (const chunk of chunks) header.write(chunk); header.end(); await ended; return Buffer.concat(output);
}

test("the proxy modifies only a fragmented WebSocket HTTP upgrade and preserves every following byte", async () => {
  const key = "b".repeat(32), opening = "GET /rpc HTTP/1.1\r\nHost: local\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Key: key\r\n\r\n";
  const frame = Buffer.from([0x81, 0x85, 1, 2, 3, 4, 5, 6, 7]);
  const result = await transformed(key, [opening.slice(0, 19), opening.slice(19), frame]);
  assert.deepEqual(result, Buffer.concat([Buffer.from(opening.replace("\r\n\r\n", `\r\nX-Harness-Gateway-Device: ${key}\r\n\r\n`)), frame]));
  const raw = Buffer.from("not an HTTP upgrade\r\n\r\n\x81\x01x", "latin1");
  assert.deepEqual(await transformed(undefined, [raw]), raw);
  assert.deepEqual(await transformed(key, [raw]), raw);
  const header = sshProxyDeviceHeader(key)!; const immediate = once(header, "data");
  header.write('{"method":"initialize"}\n');
  assert.deepEqual(Buffer.from((await immediate)[0] as Buffer), Buffer.from('{"method":"initialize"}\n'));
  header.destroy();
});

test("the proxy leaves malformed, duplicate, and oversized opening bytes untouched", async () => {
  const key = "b".repeat(32);
  for (const opening of [
    "GET /rpc HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Harness-Gateway-Device: present\r\n\r\n",
    `GET /rpc HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Harness-Gateway-Device: ${key}\r\nX-Harness-Gateway-Device: ${key}\r\n\r\n`,
    `GET /rpc HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Fill: ${"x".repeat(32 * 1024)}\r\n\r\n`,
  ]) assert.deepEqual(await transformed(key, [opening]), Buffer.from(opening));
  const opening = "GET /rpc HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";
  const coalescedPayload = Buffer.alloc(33 * 1024, 7);
  const coalesced = await transformed(key, [Buffer.concat([Buffer.from(opening), coalescedPayload])]);
  assert.deepEqual(coalesced, Buffer.concat([Buffer.from(opening.replace("\r\n\r\n", `\r\nX-Harness-Gateway-Device: ${key}\r\n\r\n`)), coalescedPayload]));
  assert.deepEqual(await transformed(key, ["GET /rpc HTTP/1.1\r\nUpgrade: websocket"]), Buffer.from("GET /rpc HTTP/1.1\r\nUpgrade: websocket"));
});

test("native proxy opens a real Unix WebSocket and presents the private device after its HTTP upgrade", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const folder = await shortFolder("gw-proxy-ws-"); const path = join(folder.directory, "adapter.sock"); const sourcePath = join(folder.directory, "native-proxy.sock");
  const controller = new AbortController(); const key = "d".repeat(32); let received = ""; let initialized!: () => void;
  const didInitialize = new Promise<void>(resolve => { initialized = resolve; });
  let listening!: () => void; const listenerReady = new Promise<void>(resolve => { listening = resolve; });
  const serving = serveUnix(path, controller.signal, async input => {
    for await (const chunk of input) {
      received += chunk.toString();
      if (received.includes('{"method":"initialize"}')) initialized();
    }
  }, undefined, () => listening());
  await listenerReady;
  let source: Socket | undefined;
  const incoming = new PassThrough(); const target = createConnection(path); const child = Object.assign(new EventEmitter(), { stdin: new PassThrough() });
  child.stdin.pipe(target); target.on("data", chunk => source?.write(chunk));
  const proxy = proxyNative("native", ["app-server", "proxy"], {}, incoming, key, () => child as never);
  const native = createServer(socket => {
    source = socket; socket.on("data", chunk => incoming.write(chunk)); socket.on("end", () => incoming.end());
  });
  try {
    native.listen(sourcePath); await once(native, "listening");
    const client = new WebSocket(`ws+unix://${sourcePath}:/rpc`);
    await once(client, "open"); client.send('{"method":"initialize"}'); await didInitialize;
    assert.equal(received, `{"method":"gateway/client","params":{"device":"${key}"}}\n{"method":"initialize"}\n`);
    client.close(); await once(client, "close"); child.emit("exit", 7, null);
    assert.deepEqual(await proxy, [7, null]);
  } finally {
    incoming.end(); target.destroy(); native.close(); controller.abort(); await serving.catch(() => {}); await folder.remove();
  }
});

test("the Unix listener keeps absent, invalid, and duplicate device headers local", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const folder = await shortFolder("gw-device-header-"); const path = join(folder.directory, "adapter.sock"); const controller = new AbortController();
  const received: string[] = []; const waiters: Array<() => void> = []; let listening!: () => void;
  const listenerReady = new Promise<void>(resolve => { listening = resolve; });
  const serving = serveUnix(path, controller.signal, async input => {
    let message = "";
    for await (const chunk of input) {
      message += chunk.toString();
      if (message.includes('"method":"initialize"')) { received.push(message); waiters.shift()?.(); return; }
    }
  }, undefined, () => listening());
  const send = async (headers?: Record<string, string | string[]>) => {
    let done!: () => void; const finished = new Promise<void>(resolve => { done = resolve; }); waiters.push(done);
    const client = new WebSocket(`ws+unix://${path}:/rpc`, { headers: headers as never }); await once(client, "open"); client.send('{"method":"initialize"}'); await finished;
    client.close(); await once(client, "close");
  };
  try {
    await listenerReady;
    await send();
    await send({ [DEVICE_HEADER]: "not-a-device" });
    await send({ [DEVICE_HEADER]: ["e".repeat(32), "e".repeat(32)] });
    assert.deepEqual(received, ['{"method":"initialize"}\n', '{"method":"initialize"}\n', '{"method":"initialize"}\n']);
  } finally {
    controller.abort(); await serving.catch(() => {}); await folder.remove();
  }
});

test("proxy inserts a header instead of a JSON preamble and keeps the native exit code", async () => {
  const run = async (device: string | undefined) => {
    const input = new PassThrough(), child = Object.assign(new EventEmitter(), { stdin: new PassThrough() }); let bytes = "";
    child.stdin.on("data", chunk => { bytes += chunk; });
    const result = proxyNative("native", ["app-server", "proxy"], {}, input, device, () => child as never);
    input.end("GET /rpc HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); await once(child.stdin, "finish"); child.emit("exit", 7, null);
    assert.deepEqual(await result, [7, null]); return bytes;
  };
  const key = "b".repeat(32);
  assert.equal(await run(key), `GET /rpc HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Harness-Gateway-Device: ${key}\r\n\r\n`);
  assert.equal(await run(undefined), "GET /rpc HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
});

test("a closed proxy stdin cannot replace the native exit code", async () => {
  const input = new PassThrough(), stdin = new PassThrough(), child = Object.assign(new EventEmitter(), { stdin });
  const nativeWrite = stdin.write.bind(stdin); stdin.write = ((chunk: string) => { const result = nativeWrite(chunk); stdin.destroy(Object.assign(new Error("closed"), { code: "EPIPE" })); return result; }) as typeof stdin.write;
  const result = proxyNative("native", ["app-server", "proxy"], {}, input, "c".repeat(32), () => child as never);
  const closed = once(stdin, "error"); input.end("GET /rpc HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); await closed; child.emit("exit", 7, null);
  assert.deepEqual(await result, [7, null]);
});

test("missing proxy config skips optional device lookup with or without SSH", async () => {
  assert.equal(await proxyDevice("/definitely-missing-gateway.json", undefined), undefined);
  assert.equal(await proxyDevice("/definitely-missing-gateway.json", "198.51.100.24 22 203.0.113.1 22"), undefined);
});
