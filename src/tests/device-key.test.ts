import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { deviceKeyForAddress } from "../device-key.js";
import { gatewayClientDevice, shimSessionDevice } from "../shim-session.js";
import { proxyDevice, proxyNative } from "../codex-shim.js";

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

test("proxy prepends one hello, pipes stdin, and has no hello without a device", async () => {
  const run = async (device: string | undefined) => {
    const input = new PassThrough(), child = Object.assign(new EventEmitter(), { stdin: new PassThrough() }); let bytes = "";
    child.stdin.on("data", chunk => { bytes += chunk; });
    const result = proxyNative("native", ["app-server", "proxy"], {}, input, device, () => child as never);
    input.end('{"method":"initialize"}\n'); await once(child.stdin, "finish"); child.emit("exit", 7, null);
    assert.deepEqual(await result, [7, null]); return bytes;
  };
  const key = "b".repeat(32);
  assert.equal(await run(key), `{"method":"gateway/client","params":{"device":"${key}"}}\n{"method":"initialize"}\n`);
  assert.equal(await run(undefined), '{"method":"initialize"}\n');
});

test("a closed proxy stdin cannot replace the native exit code", async () => {
  const input = new PassThrough(), stdin = new PassThrough(), child = Object.assign(new EventEmitter(), { stdin });
  const nativeWrite = stdin.write.bind(stdin); stdin.write = ((chunk: string) => { const result = nativeWrite(chunk); stdin.destroy(Object.assign(new Error("closed"), { code: "EPIPE" })); return result; }) as typeof stdin.write;
  const result = proxyNative("native", ["app-server", "proxy"], {}, input, "c".repeat(32), () => child as never);
  const closed = once(stdin, "error"); input.end('{"method":"initialize"}\n'); await closed; child.emit("exit", 7, null);
  assert.deepEqual(await result, [7, null]);
});

test("missing proxy config skips optional device lookup with or without SSH", async () => {
  assert.equal(await proxyDevice("/definitely-missing-gateway.json", undefined), undefined);
  assert.equal(await proxyDevice("/definitely-missing-gateway.json", "198.51.100.24 22 203.0.113.1 22"), undefined);
});
