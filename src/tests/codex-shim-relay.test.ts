import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

/** Whether binding a private Unix socket is refused here at all, as it is inside a sandbox. */
async function bindBlocked(path: string): Promise<boolean> {
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

// A relay lives under this machine's state home, so the test only runs where the suite owns that home.
test("a live relay takes remote control, and the engine is told to release it",
  { skip: process.platform === "win32" || !process.env.GATEWAY_TEST_TMPDIR, timeout: 30000 }, async t => {
  if (await bindBlocked(join(homedir(), ".local/state/gw-native", "shim-probe"))) return void t.skip("this machine will not bind a private relay socket");
  const files = await shimFiles({ serve: false });
  const home = join(homedir(), ".local/state/gw-native", "shim-fixture");
  await writePrivateJson(join(files.value.stateDirectory, "native-registration.json"), { registered: true, home, nativeHome: files.nativeHome });
  let stop: (() => Promise<void>) | undefined;
  try { stop = await liveRelay(home); }
  catch { await rm(home, { recursive: true, force: true }); files.close(); return void t.skip("this machine will not bind a private relay socket"); }
  try {
    const adapter_ = await adapter(files.env, files.backend, files.cli, files.config);
    try {
      await adapter_.rpc("initialize", { clientInfo: { name: "Codex Desktop", version: "1" }, capabilities: {} });
      assert.equal((await adapter_.rpc("engine/info")).remoteControlDisabled, true, "the engine was told its remote control is owned");
      const answered = await adapter_.rpc("remoteControl/status/read");
      assert.equal(answered.transport, "relay"); assert.equal(answered.method, "remoteControl/status/read");
    } finally { await adapter_.close(); }
  } finally { await stop(); files.close(); await rm(home, { recursive: true, force: true }); }
});
