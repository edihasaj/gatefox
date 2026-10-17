import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { ListenerActivity, listenerActivityPath, readListenerActivity } from "../ssh-listener-activity.js";
import { shimFiles } from "./shim-fixture.js";
import { shortFolder } from "./short-folder.js";

test("an SSH listener records whether any of its sessions runs a turn or waits on the client, and no record reads as unknown", async () => {
  const folder = await mkdtemp(join(tmpdir(), "gw-listener-")); const pid = process.pid;
  // Records are written asynchronously (with a sync), so each assertion polls for the state it expects instead of sleeping.
  const busyIs = async (wanted: boolean) => { for (let i = 0; i < 200; i++) { if ((await readListenerActivity(folder, pid))?.busy === wanted) return wanted; await delay(20); } return (await readListenerActivity(folder, pid))?.busy; };
  try {
    assert.equal(await readListenerActivity(folder, pid), undefined, "a listener from a release without records");
    const activity = new ListenerActivity(folder, pid); const sent: unknown[] = [];
    activity.publish(); assert.equal(await busyIs(false), false);
    const idle = await readListenerActivity(folder, pid);
    assert.equal(idle?.busy, false, "a listener with no session is idle");
    assert.ok(Math.abs(idle!.startedAt - (Date.now() - process.uptime() * 1000)) < 2000, "the record names this process's start");
    const session = activity.open(async message => { sent.push(message); });
    await session.emit({ method: "turn/started", params: { threadId: "t1", turn: { id: "u1", status: "inProgress" } } });
    assert.equal(await busyIs(true), true, "a running turn keeps the listener");
    assert.equal(sent.length, 1, "the client still receives every message");
    await session.emit({ method: "turn/completed", params: { threadId: "t1", turn: { id: "u1", status: "completed" } } });
    assert.equal(await busyIs(false), false);
    await session.emit({ id: "gateway-server-1", method: "item/commandExecution/requestApproval", params: {} });
    assert.equal(await busyIs(true), true, "an approval nobody answered keeps the listener");
    await session.emit({ method: "serverRequest/resolved", params: { requestId: "gateway-server-1" } });
    assert.equal(await busyIs(false), false);
    await session.emit({ method: "turn/started", params: { threadId: "t2", turn: { id: "u2", status: "inProgress" } } });
    assert.equal(await busyIs(true), true);
    session.close();
    assert.equal(await busyIs(false), false, "a session that ended runs nothing");
    const before = Date.now(); activity.decline(); assert.equal(await busyIs(true), true);
    const declined = await readListenerActivity(folder, pid);
    assert.equal(declined?.busy, true); assert.ok(declined!.declinedAt! >= before, "a declined request is on the record");
    await activity.stop();
    assert.equal(await readListenerActivity(folder, pid), undefined);
    await writeFile(listenerActivityPath(folder, 999999), JSON.stringify({ pid: 1, startedAt: 1, busy: false }));
    assert.equal(await readListenerActivity(folder, 999999), undefined, "a record for another pid says nothing");
    await writeFile(listenerActivityPath(folder, 999998), JSON.stringify({ pid: 999998, busy: false }));
    assert.equal(await readListenerActivity(folder, 999998), undefined, "a record without a start time vouches for nothing");
  } finally { await rm(folder, { recursive: true, force: true }); }
});

/** A real SSH listener, started the way the remote app's bootstrap starts it. */
async function startListener(extra: NodeJS.ProcessEnv = {}) {
  const f = await shimFiles(); const control = await shortFolder("gw-ssh-act-");
  const alias = join(control.directory, "app-server-control/app-server-control.sock");
  const child = spawn(process.execPath, [f.cli, "codex-shim", "--ssh", "--ssh-home", control.directory, "--config", f.config, "--codex", f.backend, "--", "app-server", "--listen", "unix://"], { env: { ...f.env, ...extra }, stdio: "ignore" });
  const exited = once(child, "close");
  const record = () => readListenerActivity(control.directory, child.pid!);
  for (let i = 0; i < 400 && !(await lstat(alias).then(() => true, () => false) && await record()); i++) await delay(25);
  let client: WebSocket | undefined; const pending = new Map<number, (message: Record<string, unknown>) => void>(); let approval: string | undefined; let id = 0;
  const connect = async () => {
    client = new WebSocket(`ws+unix://${alias}:/rpc`); await once(client, "open");
    client.on("message", data => {
      const message = JSON.parse(data.toString());
      if (message.method === "item/commandExecution/requestApproval") approval = message.id;
      else if (typeof message.id === "number") pending.get(message.id)?.(message);
    });
  };
  const rpc = (method: string, params = {}) => new Promise<Record<string, unknown>>(resolve => { pending.set(++id, resolve); client!.send(JSON.stringify({ id, method, params })); });
  return { child, exited, record, connect, rpc, approval: () => approval, answer: () => client!.send(JSON.stringify({ id: approval, result: { decision: "accept" } })), control,
    close: async () => { client?.terminate(); child.kill("SIGKILL"); await exited.catch(() => {}); f.close(); await control.remove(); } };
}

test("a running SSH listener reports idle, busy during a pending approval, idle again, and removes its record on TERM", { skip: process.platform === "win32", timeout: 40000 }, async () => {
  const l = await startListener();
  try {
    assert.equal((await l.record())?.busy, false);
    await l.connect();
    await l.rpc("initialize", { clientInfo: { name: "test", version: "1" } });
    const start = (await l.rpc("thread/start", { model: "claude/model", modelProvider: "openai" })).result as { thread: { id: string } };
    void l.rpc("turn/start", { threadId: start.thread.id, model: "claude/model", input: [] });
    for (let i = 0; i < 400 && !l.approval(); i++) await delay(25);
    assert.ok(l.approval(), "the turn is waiting for the client's approval");
    assert.equal((await l.record())?.busy, true, "a pending approval keeps the listener");
    l.answer();
    for (let i = 0; i < 400 && (await l.record())?.busy; i++) await delay(25);
    assert.equal((await l.record())?.busy, false);
    l.child.kill("SIGTERM"); await l.exited;
    assert.equal(await l.record(), undefined, "a listener that exited leaves no record that could read as idle");
    await assert.rejects(lstat(listenerActivityPath(l.control.directory, l.child.pid!)), /ENOENT/);
  } finally { await l.close(); }
});

test("SIGUSR2 retires a listener with no session at once, and one with traffic in the last 30 s declines and keeps serving", { skip: process.platform === "win32", timeout: 40000 }, async () => {
  const quiet = await startListener();
  try {
    process.kill(quiet.child.pid!, "SIGUSR2");
    const [code] = await quiet.exited;
    assert.equal(code, 0, "an idle listener stops itself the way a TERM would");
    assert.equal(await quiet.record(), undefined);
  } finally { await quiet.close(); }
  const busy = await startListener();
  try {
    await busy.connect(); await busy.rpc("initialize", { clientInfo: { name: "test", version: "1" } });
    const asked = Date.now();
    process.kill(busy.child.pid!, "SIGUSR2");
    for (let i = 0; i < 200 && !(await busy.record())?.declinedAt; i++) await delay(25);
    const record = await busy.record();
    assert.ok(record!.declinedAt! >= asked, "the refusal is on the record");
    assert.equal(busy.child.exitCode, null, "the listener still serves");
    assert.equal((await busy.rpc("model/list")).error, undefined, "its session still answers");
  } finally { await busy.close(); }
});

test("a session silent past the idle window lets the listener retire on request; an unanswered request does not", { skip: process.platform === "win32", timeout: 40000 }, async () => {
  const l = await startListener({ GATEWAY_SESSION_IDLE_MS: "300" });
  try {
    await l.connect(); await l.rpc("initialize", { clientInfo: { name: "test", version: "1" } });
    const start = (await l.rpc("thread/start", { model: "claude/model", modelProvider: "openai" })).result as { thread: { id: string } };
    void l.rpc("turn/start", { threadId: start.thread.id, model: "claude/model", input: [] });
    for (let i = 0; i < 400 && !l.approval(); i++) await delay(25);
    await delay(500); // Longer than the idle window, with the turn waiting on its approval.
    process.kill(l.child.pid!, "SIGUSR2");
    for (let i = 0; i < 200 && !(await l.record())?.declinedAt; i++) await delay(25);
    assert.ok((await l.record())?.declinedAt, "a turn in flight blocks retirement however long it is silent");
    assert.equal(l.child.exitCode, null);
    l.answer(); await delay(700); // The turn completes; then the session is silent past the window.
    process.kill(l.child.pid!, "SIGUSR2");
    const [code] = await l.exited;
    assert.equal(code, 0, "an idle session no longer holds the listener");
  } finally { await l.close(); }
});
