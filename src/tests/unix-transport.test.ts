import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { unixSocketPath } from "../unix-transport.js";
import { shimFiles } from "./shim-fixture.js";

test("Unix addresses exclude network listeners, relative paths, and oversized socket names", () => {
  assert.throws(() => unixSocketPath("ws://0.0.0.0:80"));
  assert.throws(() => unixSocketPath("unix://relative.sock"));
  assert.throws(() => unixSocketPath("unix:///" + "a".repeat(104)));
  assert.equal(unixSocketPath("unix:///tmp/socket"), "/tmp/socket");
});

test("Unix clients get combined models, isolated approvals, and disconnect recovery", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const fixture = await shimFiles(); const path = join(fixture.directory, "rpc.sock");
  const child = spawn(process.execPath, [fixture.cli, "codex-shim", "--config", fixture.config, "--codex", fixture.backend, "--", "app-server", "--listen", "unix://" + path], { env: fixture.env, stdio: ["ignore", "ignore", "ignore"] });
  const clients: WebSocket[] = [];
  try {
    for (let i = 0; i < 100; i++) { if (await lstat(path).then(() => true, () => false)) break; await delay(20); }
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    const open = async () => {
      const ws = new WebSocket(`ws+unix://${path}:/rpc`); clients.push(ws); await once(ws, "open");
      let id = 0; const pending = new Map<number, (value: Record<string, any>) => void>(); const events: Record<string, any>[] = [];
      ws.on("message", data => { const m = JSON.parse(data.toString()); if (typeof m.id === "number") pending.get(m.id)?.(m); else events.push(m); });
      const rpc = async (method: string, params = {}) => {
        const key = ++id; const reply = new Promise<Record<string, any>>(resolve => pending.set(key, resolve));
        ws.send(JSON.stringify({ id: key, method, params })); const m = await reply; pending.delete(key); assert.equal(m.error, undefined); return m.result;
      };
      await rpc("initialize", { clientInfo: { name: "unix-test", version: "1" } });
      return { ws, rpc, events };
    };
    const first = await open(); const second = await open();
    assert.deepEqual((await first.rpc("model/list")).data.map((m: { model: string }) => m.model), ["native", "claude/model"]);
    const a = await first.rpc("thread/start", { model: "claude/model" });
    const b = await second.rpc("thread/start", { model: "claude/model" }); assert.notEqual(a.thread.id, b.thread.id);
    const turn = first.rpc("turn/start", { threadId: a.thread.id, model: "claude/model", input: [] });
    for (let i = 0; i < 100 && !first.events.length; i++) await delay(10);
    const approval = first.events.find(e => e.method === "item/commandExecution/requestApproval");
    assert.ok(approval); assert.equal(second.events.some(e => e.method === approval.method), false);
    first.ws.send(JSON.stringify({ id: approval.id, result: { decision: "accept" } })); await turn;
    first.ws.close(); await once(first.ws, "close");
    assert.equal((await second.rpc("account/read")).account.email, "primary-test-account");
    const third = await open(); assert.equal((await third.rpc("model/list")).data.length, 2);
    assert.equal(await readFile(join(fixture.nativeHome, "config.toml"), "utf8"), 'model = "native"\n');
  } finally { for (const ws of clients) ws.terminate(); const exited = once(child, "close"); child.kill("SIGTERM"); await exited; fixture.close(); }
});

test("Unix startup refuses an occupied path without deleting its contents", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const fixture = await shimFiles(); const path = join(fixture.directory, "occupied.sock"); await writeFile(path, "keep-this");
  const child = spawn(process.execPath, [fixture.cli, "codex-shim", "--config", fixture.config, "--codex", fixture.backend, "--", "app-server", "--listen=unix://" + path], { env: fixture.env, stdio: "ignore" });
  try { await once(child, "close"); assert.equal(child.exitCode, 2); assert.equal(await readFile(path, "utf8"), "keep-this"); }
  finally { child.kill("SIGTERM"); fixture.close(); }
});
