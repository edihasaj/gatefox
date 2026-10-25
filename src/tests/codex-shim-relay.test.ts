import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { shimFiles } from "./shim-fixture.js";
import { relaySocketPath } from "../native-control.js";
import { writePrivateJson } from "../config.js";

type Message = Record<string, unknown>;

/** Starts the adapter and speaks one RPC per line over its stdio, as the desktop app does. */
async function adapter(env: NodeJS.ProcessEnv, backend: string, cli: string, config: string) {
  const child = spawn(process.execPath, [cli, "codex-shim", "--config", config, "--codex", backend, "--", "app-server"], { stdio: ["pipe", "pipe", "pipe"], env });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout }); const pending = new Map<number, (message: Message) => void>(); let id = 0;
  lines.on("line", line => { const message = JSON.parse(line) as Message; if (typeof message.id === "number") pending.get(message.id)?.(message); });
  const rawRpc = async (method: string, params: Message = {}) => {
    const requestId = ++id;
    const reply = await new Promise<Message>(resolve => { pending.set(requestId, resolve); child.stdin.write(JSON.stringify({ id: requestId, method, params }) + "\n"); });
    pending.delete(requestId);
    return reply;
  };
  const rpc = async (method: string, params: Message = {}) => {
    const reply = await rawRpc(method, params);
    assert.equal(reply.error, undefined, JSON.stringify(reply.error)); return reply.result as Message;
  };
  return { child, lines, rawRpc, rpc, close: async () => { const closed = once(child, "close"); child.stdin.end(); await closed; child.kill("SIGKILL"); lines.close(); } };
}

/**
 * A home of the test's own for it and its adapter: a relay home must lie under `$HOME/.local/state/gw-native`, and the real
 * one is never touched, whether the file runs under npm test or on its own. The folder name is short because the relay's
 * socket path below it cannot exceed 104 bytes on macOS.
 */
async function privateHome(): Promise<{ home: string; relayRoot: string; remove(): Promise<void> }> {
  const home = await mkdtemp(join(process.env.GATEWAY_TEST_TMPDIR ?? "/tmp", "gwh-"));
  return { home, relayRoot: join(home, ".local/state/gw-native"), remove: () => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

/** Whether binding a private Unix socket is refused here at all, as it is inside a sandbox. */
async function bindBlocked(path: string): Promise<boolean> {
  // The probe says nothing when its own folder is simply missing, which is the case in a runner
  // whose HOME was made for this test run: a refused bind is the only reason to skip.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const probe = createServer();
  const refused = await new Promise<boolean>(done => { probe.once("listening", () => done(false)); probe.once("error", () => done(true)); probe.listen(path); });
  if (!refused) await new Promise(done => probe.close(done));
  return refused;
}

/** A relay that is really there: its socket answers regardless of its last cloud status. */
async function liveRelay(home: string, status = "connected") {
  await mkdir(join(home, "app-server-control"), { recursive: true, mode: 0o700 });
  await writeFile(join(home, "status.json"), JSON.stringify({ status }));
  const http = createServer(); const ws = new WebSocketServer({ server: http });
  ws.on("connection", client => client.on("message", data => {
    const request = JSON.parse(data.toString()) as { id: number; method: string };
    client.send(JSON.stringify({ id: request.id, result: { transport: "relay", method: request.method } }));
  }));
  await new Promise<void>((done, fail) => { http.once("listening", () => done()); http.once("error", error => fail(error)); http.listen(relaySocketPath(home)); });
  return async () => { for (const client of ws.clients) client.terminate(); await new Promise(done => ws.close(done)); await new Promise(done => http.close(done)); };
}

test("without a registered relay the app engine keeps its own remote control", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const files = await shimFiles({ serve: false });
  try {
    const adapter_ = await adapter(files.env, files.backend, files.cli, files.config);
    try {
      await adapter_.rpc("initialize", { clientInfo: { name: "Codex Desktop", version: "1" }, capabilities: {} });
      assert.notEqual((await adapter_.rpc("engine/info")).remoteControlDisabled, true, "the engine was never told to switch it off");
      assert.equal((await adapter_.rpc("remoteControl/status/read")).transport, "engine", "the method reached the engine untouched");
    } finally { await adapter_.close(); }
  } finally { files.close(); await rm(files.directory, { recursive: true, force: true }); }
});

const registered = (home: string, state: string, nativeHome: string) => writePrivateJson(join(state, "native-registration.json"), { registered: true, home, nativeHome });

test("a registered relay keeps control requests out of the engine while its socket reconnects", { skip: process.platform === "win32", timeout: 30000 }, async t => {
  const files = await shimFiles({ serve: false }); const own = await privateHome(); const home = join(own.relayRoot, "su");
  await mkdir(join(home, "app-server-control"), { recursive: true, mode: 0o700 });
  await registered(home, files.value.stateDirectory, files.nativeHome);
  let stop: (() => Promise<void>) | undefined;
  try {
    const adapter_ = await adapter({ ...files.env, HOME: own.home }, files.backend, files.cli, files.config);
    try {
      await adapter_.rpc("initialize", { clientInfo: { name: "Codex Desktop", version: "1" }, capabilities: {} });
      assert.equal((await adapter_.rpc("engine/info")).remoteControlDisabled, true, "registration suppresses the engine's startup control");
      for (const method of ["remoteControl/status/read", "remoteControl/enable", "remoteControl/disable"]) {
        const reply = await adapter_.rawRpc(method);
        assert.ok(reply.error, `${method} must fail through the missing registered relay`);
        assert.match(String((reply.error as Message).message), /Native connected-machine relay/, `${method} never falls through to the engine`);
      }
      assert.equal((await adapter_.rpc("engine/info")).remoteControlDisabled, true, "ordinary engine requests still work");
      try { stop = await liveRelay(home); }
      catch { return void t.skip("this machine will not bind a private relay socket"); }
      for (const method of ["remoteControl/status/read", "remoteControl/enable", "remoteControl/disable"]) {
        let reply: Message | undefined;
        for (let attempt = 0; attempt < 30; attempt++) {
          await delay(100); reply = await adapter_.rawRpc(method);
          if (!reply.error) break;
        }
        assert.equal(reply?.error, undefined, `${method} retries through the same adapter after the relay appears`);
        assert.equal((reply?.result as Message).transport, "relay");
      }
    } finally { await adapter_.close(); }
  } finally { await stop?.(); files.close(); await rm(files.directory, { recursive: true, force: true }); await own.remove(); }
});

test("an activation in progress already routes remote control to its registered relay", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const files = await shimFiles({ serve: false }); const own = await privateHome(); const home = join(own.relayRoot, "sp");
  await mkdir(join(home, "app-server-control"), { recursive: true, mode: 0o700 });
  await writePrivateJson(join(files.value.stateDirectory, "native-registration.pending"), { registered: true, home, nativeHome: files.nativeHome });
  try {
    const adapter_ = await adapter({ ...files.env, HOME: own.home }, files.backend, files.cli, files.config);
    try {
      await adapter_.rpc("initialize", { clientInfo: { name: "Codex Desktop", version: "1" }, capabilities: {} });
      assert.equal((await adapter_.rpc("engine/info")).remoteControlDisabled, true);
      assert.ok((await adapter_.rawRpc("remoteControl/status/read")).error, "a pending registration must not fall through to the engine");
    } finally { await adapter_.close(); }
  } finally { files.close(); await rm(files.directory, { recursive: true, force: true }); await own.remove(); }
});

// A relay lives under the state home of the test's own HOME, which its adapter shares.
test("a reachable registered relay owns control even when its cloud status is errored", { skip: process.platform === "win32", timeout: 30000 }, async t => {
  const own = await privateHome(); const relayRoot = own.relayRoot;
  await mkdir(relayRoot, { recursive: true, mode: 0o700 });
  if (await bindBlocked(join(relayRoot, "sp"))) { await own.remove(); return void t.skip("this machine will not bind a private relay socket"); }
  const files = await shimFiles({ serve: false });
  const home = join(relayRoot, "sf");
  await writePrivateJson(join(files.value.stateDirectory, "native-registration.json"), { registered: true, home, nativeHome: files.nativeHome });
  let stop: (() => Promise<void>) | undefined;
  try { stop = await liveRelay(home, "errored"); }
  catch { await own.remove(); files.close(); return void t.skip("this machine will not bind a private relay socket"); }
  try {
    const adapter_ = await adapter({ ...files.env, HOME: own.home }, files.backend, files.cli, files.config);
    try {
      await adapter_.rpc("initialize", { clientInfo: { name: "Codex Desktop", version: "1" }, capabilities: {} });
      assert.equal((await adapter_.rpc("engine/info")).remoteControlDisabled, true, "the engine was told its remote control is owned");
      for (const method of ["remoteControl/status/read", "remoteControl/enable", "remoteControl/disable"]) {
        const answered = await adapter_.rpc(method);
        assert.equal(answered.transport, "relay"); assert.equal(answered.method, method);
      }
    } finally { await adapter_.close(); }
  } finally { await stop(); files.close(); await rm(files.directory, { recursive: true, force: true }); await own.remove(); }
});
