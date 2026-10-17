import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { listenerActivityPath, readListenerActivity, type ListenerState } from "../ssh-listener-activity.js";
import { shimFiles } from "./shim-fixture.js";
import { shortFolder } from "./short-folder.js";

/**
 * A real SSH listener, started the way the remote app's bootstrap starts it, keeps the record that lets `gateway native
 * install` retire it only while it is idle: idle when it only listens, busy while a client's approval is pending, idle again
 * once the turn completed, and gone (never idle) when the listener exits on a graceful TERM.
 */
test("a running SSH listener reports idle, busy during a pending approval, idle again, and removes its record on TERM", { skip: process.platform === "win32", timeout: 40000 }, async () => {
  const f = await shimFiles(); const control = await shortFolder("gw-ssh-act-");
  const alias = join(control.directory, "app-server-control/app-server-control.sock");
  const child = spawn(process.execPath, [f.cli, "codex-shim", "--ssh", "--ssh-home", control.directory, "--config", f.config, "--codex", f.backend, "--", "app-server", "--listen", "unix://"], { env: f.env, stdio: "ignore" });
  const exited = once(child, "close");
  const state = () => readListenerActivity(control.directory, child.pid!);
  const until = async (wanted: ListenerState) => { for (let i = 0; i < 400; i++) { if (await state() === wanted) return; await delay(25); } assert.fail(`the listener never reported ${wanted}; it reports ${await state()}`); };
  let client: WebSocket | undefined;
  try {
    for (let i = 0; i < 400 && !await lstat(alias).then(() => true, () => false); i++) await delay(25);
    await until("idle");
    client = new WebSocket(`ws+unix://${alias}:/rpc`); await once(client, "open");
    const pending = new Map<number, (message: Record<string, unknown>) => void>(); let approval: string | undefined; let id = 0;
    client.on("message", data => {
      const message = JSON.parse(data.toString());
      if (message.method === "item/commandExecution/requestApproval") approval = message.id;
      else if (typeof message.id === "number") pending.get(message.id)?.(message);
    });
    const rpc = (method: string, params = {}) => new Promise<Record<string, unknown>>(resolve => { pending.set(++id, resolve); client!.send(JSON.stringify({ id, method, params })); });
    await rpc("initialize", { clientInfo: { name: "test", version: "1" } });
    const start = (await rpc("thread/start", { model: "claude/model", modelProvider: "openai" })).result as { thread: { id: string } };
    void rpc("turn/start", { threadId: start.thread.id, model: "claude/model", input: [] });
    for (let i = 0; i < 400 && !approval; i++) await delay(25);
    assert.ok(approval, "the turn is waiting for the client's approval");
    assert.equal(await state(), "busy", "a pending approval keeps the listener");
    client.send(JSON.stringify({ id: approval, result: { decision: "accept" } }));
    await until("idle");
    client.close(); client = undefined;
    child.kill("SIGTERM"); await exited;
    assert.equal(await state(), "unknown", "a listener that exited leaves no record that could read as idle");
    await assert.rejects(lstat(listenerActivityPath(control.directory, child.pid!)), /ENOENT/);
  } finally { client?.terminate(); child.kill("SIGKILL"); await exited.catch(() => {}); f.close(); await control.remove(); }
});
