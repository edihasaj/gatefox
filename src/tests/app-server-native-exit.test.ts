import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerBackends } from "../app-server-backends.js";
import { AppServerConnection, object, type Message } from "../app-server-connection.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import type { GatewayConfig } from "../config.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await delay(5); }
  assert.fail("Native exit fixture did not reach the expected state");
}
const started = (threadId: string, id: string): Message => ({ method: "turn/started", params: { threadId,
  turn: { id, rootTurnId: "root-" + id, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: 123, completedAt: null, durationMs: null } } });
const completed = (threadId: string, id: string, status = "completed"): Message => ({ method: "turn/completed", params: { threadId, turn: { id, status } } });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gw-native-exit-")); const sdk = join(directory, "codex");
  await writeFile(sdk, `#!${process.execPath}
const {createInterface}=require('node:readline');
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id==null)return;
 if(m.method==='fixture/emit'){for(const message of m.params.messages||[])send(message);send({id:m.id,result:{}});}
 else if(m.method==='fixture/exit'){const frames=[...(m.params.messages||[]),{id:m.id,result:{}}];process.stdout.write(frames.map(m=>JSON.stringify(m)).join('\\n')+'\\n',()=>process.exit(7));}
 else send({id:m.id,result:{}});
});
`, { mode: 0o700 });
  const home = join(directory, "native"); const state = join(directory, "state"); await mkdir(home); await mkdir(state);
  const nativeConfig = 'model = "native-original"\n'; const nativeAuth = '{"fixtureOnly":"original-primary-secret"}\n';
  await writeFile(join(home, "config.toml"), nativeConfig, { mode: 0o600 }); await writeFile(join(home, "auth.json"), nativeAuth, { mode: 0o600 });
  const events: Message[] = []; const order: string[] = []; let exits = 0;
  const hook: { emit?: (message: Message) => Promise<void>; exit?: () => void } = {};
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: state, clientOnly: true, providers: [] };
  const backend = new AppServerBackends(sdk, ["app-server", "--listen", "stdio://"], config, {}, {}, {} as DesktopCatalog,
    async message => { events.push(message); order.push(`${message.method}:${object(object(message.params).turn).status || ""}`); await hook.emit?.(message); },
    () => { exits++; order.push("native-exit"); hook.exit?.(); });
  await backend.request("initialize", { clientInfo: { name: "native-exit-fixture", version: "1" } });
  return { backend, events, order, hook, sdk, exits: () => exits,
    emit: (messages: Message[]) => backend.native.request("fixture/emit", { messages }),
    crash: (messages: Message[] = []) => backend.native.request("fixture/exit", { messages }).catch(() => ({})),
    async unchanged() { assert.equal(await readFile(join(home, "config.toml"), "utf8"), nativeConfig); assert.equal(await readFile(join(home, "auth.json"), "utf8"), nativeAuth); },
    async clean() { await backend.stop(); await backend.native.drained; await this.unchanged(); await rm(directory, { recursive: true, force: true }); } };
}

test("unexpected native exit delivers actual active IDs and awaited failure before shutdown", { timeout: 10000 }, async () => {
  const f = await fixture(); const delivery = deferred();
  try {
    const stopped = deferred(); f.hook.exit = () => { void f.backend.stop().then(() => { f.order.push("stopped"); stopped.resolve(); }); };
    await f.emit([started("chat-a", "turn-a"), started("chat-b", "turn-b")]);
    f.hook.emit = async message => { if (message.method === "error" && object(message.params).threadId === "chat-a") await delivery.promise; };
    await f.crash(); await until(() => f.events.some(message => message.method === "error"));
    assert.equal(f.exits(), 0); assert.equal(f.events.some(message => object(object(message.params).turn).status === "failed"), false);
    delivery.resolve(); await until(() => f.exits() === 1);
    const errors = f.events.filter(message => message.method === "error"); const failed = f.events.filter(message => object(object(message.params).turn).status === "failed");
    assert.deepEqual(errors.map(message => [object(message.params).threadId, object(message.params).turnId]), [["chat-a", "turn-a"], ["chat-b", "turn-b"]]);
    assert.deepEqual(failed.map(message => [object(message.params).threadId, object(object(message.params).turn).id]), [["chat-a", "turn-a"], ["chat-b", "turn-b"]]);
    // The text is right for a local chat, whose engine the app restarts by itself, and for a connected machine.
    const text = "The Codex engine stopped while this turn was running (the app may have restarted it). The chat's history is saved; send a message to continue, or reconnect this chat's computer if it stays unavailable.";
    for (const message of errors) { assert.equal(object(message.params).willRetry, false); assert.equal(object(object(message.params).error).codexErrorInfo, "internalServerError"); assert.equal(object(object(message.params).error).message, text); }
    for (const message of failed) assert.equal(object(object(object(message.params).turn).error).message, text);
    for (const message of failed) { const turn = object(object(message.params).turn); assert.equal(turn.itemsView, "notLoaded"); assert.equal(turn.rootTurnId, "root-" + turn.id); assert.deepEqual(turn.items, []); }
    await stopped.promise;
    assert.deepEqual(f.order.slice(-2), ["native-exit", "stopped"]);
    assert.doesNotMatch(JSON.stringify([...errors, ...failed]), /original-primary-secret|fixtureOnly/);
  } finally { delivery.resolve(); await f.clean(); }
});

test("buffered real completion drains after child close and prevents false native failure", { timeout: 10000 }, async () => {
  const f = await fixture(); const forwarding = deferred();
  try {
    f.hook.emit = async message => { if (message.method === "turn/started") await forwarding.promise; };
    void f.crash([started("chat", "done"), completed("chat", "done")]);
    await until(() => f.backend.native.closed);
    assert.equal(f.exits(), 0); assert.equal(f.events.filter(message => message.method === "turn/completed").length, 0);
    forwarding.resolve(); await until(() => f.exits() === 1);
    assert.deepEqual(f.events.map(message => message.method), ["turn/started", "turn/completed"]);
    assert.equal(object(object(f.events[1].params).turn).status, "completed");
    assert.equal(f.order[f.order.length - 1], "native-exit");
  } finally { forwarding.resolve(); await f.clean(); }
});

test("matching completion clears its turn; stale completion and duplicate starts never clear or revive other native work", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await f.emit([started("finished", "old"), completed("finished", "old"), started("finished", "old"),
      started("active", "old"), started("active", "new"), completed("active", "old"),
      started("interrupted", "cancelled"), completed("interrupted", "cancelled", "interrupted")]);
    await f.crash(); await until(() => f.exits() === 1);
    const failed = f.events.filter(message => object(object(message.params).turn).status === "failed");
    assert.deepEqual(failed.map(message => [object(message.params).threadId, object(object(message.params).turn).id]), [["active", "new"]]);
    assert.equal(f.events.filter(message => message.method === "error").length, 1);
  } finally { await f.clean(); }
});

test("intentional stop produces no native failure and closes only the owned fixture SDK", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await f.emit([started("chat", "turn")]); await f.backend.stop();
    assert.equal(f.events.some(message => message.method === "error" || object(object(message.params).turn).status === "failed"), false);
    assert.equal(f.exits(), 1); await f.unchanged();
  } finally { await f.clean(); }
});

test("intentional shutdown cannot hang on blocked native notification forwarding", { timeout: 10000 }, async () => {
  const f = await fixture(); const held = deferred();
  try {
    f.hook.emit = async message => { if (message.method === "turn/started") await held.promise; };
    void f.emit([started("chat", "turn")]).catch(() => undefined);
    await until(() => f.events.length === 1); await f.backend.stop();
    assert.equal(f.exits(), 1); assert.equal(f.events.some(message => message.method === "error"), false);
  } finally { held.resolve(); await f.backend.native.drained; await f.clean(); }
});

test("native exit forgets pending approvals and still shuts down after a disconnected output rejects failure delivery", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await f.emit([started("chat", "turn"), { id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "chat", turnId: "turn" } }]);
    const approval = f.events.find(message => message.method === "item/commandExecution/requestApproval")!;
    f.hook.emit = async message => { if (message.method === "error" || object(object(message.params).turn).status === "failed") throw Error("Fixture client disconnected"); };
    await f.crash(); await until(() => f.exits() === 1);
    assert.equal(f.backend.reply({ id: approval.id, result: { decision: "accept" } }), false);
    assert.equal(f.order[f.order.length - 1], "native-exit");
  } finally { await f.clean(); }
});

test("bounded native active tracking rejects excessive new threads while retaining existing IDs", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const events = Array.from({ length: 256 }, (_, index) => started(`chat-${index}`, `turn-${index}`));
    await f.emit(events); await f.emit([started("chat-0", "replacement")]);
    await f.emit([started("overflow-chat", "overflow-turn")]).catch(() => undefined); await until(() => f.exits() === 1);
    const failed = f.events.filter(message => object(object(message.params).turn).status === "failed");
    assert.equal(failed.length, 256);
    assert.equal(failed.some(message => object(object(message.params).turn).id === "replacement"), true);
    assert.equal(failed.some(message => object(object(message.params).turn).id === "overflow-turn"), false);
  } finally { await f.clean(); }
});

test("AppServerConnection exposes drain completion separately from child exit", { timeout: 10000 }, async () => {
  const f = await fixture(); const held = deferred(); const messages: Message[] = [];
  const connection = new AppServerConnection(f.sdk, [], async message => { messages.push(message); if (message.method === "turn/started") await held.promise; }, () => {});
  try {
    void connection.request("fixture/exit", { messages: [started("chat", "turn"), completed("chat", "turn")] }).catch(() => undefined);
    await connection.exited;
    let drained = false; void connection.drained.then(() => { drained = true; });
    await delay(1); assert.equal(drained, false); assert.equal(messages.length, 1);
    held.resolve(); await connection.drained; assert.equal(messages.length, 2); assert.equal(drained, true);
  } finally { held.resolve(); connection.stop(); await connection.exited; await connection.drained; await f.clean(); }
});
