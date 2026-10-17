import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { once } from "node:events";
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
  const rpc = async (method: string, params: Message = {}) => {
    const reply = await new Promise<Message>(resolve => { pending.set(++id, resolve); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error)); return reply.result as Message;
  };
  return { child, lines, rpc, close: async () => { const closed = once(child, "close"); child.stdin.end(); await closed; child.kill("SIGKILL"); lines.close(); } };
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

/** A relay that is really there: its socket answers, and its status file says connected. */
async function liveRelay(home: string) {
  await mkdir(join(home, "app-server-control"), { recursive: true, mode: 0o700 });
  await writeFile(join(home, "status.json"), '{"status":"connected"}');
  const http = createServer(); const ws = new WebSocketServer({ server: http });
  ws.on("connection", client => client.on("message", data => {
    const request = JSON.parse(data.toString()) as { id: number; method: string };
    client.send(JSON.stringify({ id: request.id, result: { transport: "relay", method: request.method } }));
  }));
  await new Promise<void>((done, fail) => { http.once("listening", () => done()); http.once("error", error => fail(error)); http.listen(relaySocketPath(home)); });
  return async () => { for (const client of ws.clients) client.terminate(); await new Promise(done => ws.close(done)); await new Promise(done => http.close(done)); };
}

test("without a live relay the app engine keeps its own remote control", { skip: process.platform === "win32", timeout: 30000 }, async () => {
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

// The real relay-optional regression: everything the adapter reads claims a relay, but nothing
// answers on its socket. The engine must keep its own remote control, and remoteControl/* must
// still reach it. No socket is bound here, so this runs anywhere the suite runs.
test("a registered relay that is not reachable leaves the engine's remote control alone", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const files = await shimFiles({ serve: false }); const own = await privateHome();
  // A registration and a receipt that both claim a relay, and nothing listening behind them.
  const home = join(own.relayRoot, "su");
  await mkdir(join(home, "app-server-control"), { recursive: true, mode: 0o700 });
  await writeFile(join(home, "status.json"), '{"status":"connected"}');
  await writePrivateJson(join(files.value.stateDirectory, "native-registration.json"), { registered: true, home, nativeHome: files.nativeHome });
  try {
    const adapter_ = await adapter({ ...files.env, HOME: own.home }, files.backend, files.cli, files.config);
    try {
      await adapter_.rpc("initialize", { clientInfo: { name: "Codex Desktop", version: "1" }, capabilities: {} });
      assert.notEqual((await adapter_.rpc("engine/info")).remoteControlDisabled, true, "an unreachable relay never switched the engine off");
      assert.equal((await adapter_.rpc("remoteControl/status/read")).transport, "engine", "the method reached the engine untouched");
    } finally { await adapter_.close(); }
  } finally { files.close(); await rm(files.directory, { recursive: true, force: true }); await own.remove(); }
});

// A relay lives under the state home of the test's own HOME, which its adapter shares.
test("a live relay takes remote control, and the engine is told to release it", { skip: process.platform === "win32", timeout: 30000 }, async t => {
  const own = await privateHome(); const relayRoot = own.relayRoot;
  await mkdir(relayRoot, { recursive: true, mode: 0o700 });
  if (await bindBlocked(join(relayRoot, "sp"))) { await own.remove(); return void t.skip("this machine will not bind a private relay socket"); }
  const files = await shimFiles({ serve: false });
  const home = join(relayRoot, "sf");
  await writePrivateJson(join(files.value.stateDirectory, "native-registration.json"), { registered: true, home, nativeHome: files.nativeHome });
  let stop: (() => Promise<void>) | undefined;
  try { stop = await liveRelay(home); }
  catch { await own.remove(); files.close(); return void t.skip("this machine will not bind a private relay socket"); }
  try {
    const adapter_ = await adapter({ ...files.env, HOME: own.home }, files.backend, files.cli, files.config);
    try {
      await adapter_.rpc("initialize", { clientInfo: { name: "Codex Desktop", version: "1" }, capabilities: {} });
      assert.equal((await adapter_.rpc("engine/info")).remoteControlDisabled, true, "the engine was told its remote control is owned");
      const answered = await adapter_.rpc("remoteControl/status/read");
      assert.equal(answered.transport, "relay"); assert.equal(answered.method, "remoteControl/status/read");
    } finally { await adapter_.close(); }
  } finally { await stop(); files.close(); await rm(files.directory, { recursive: true, force: true }); await own.remove(); }
});
