// The adapter must never stop a healthy engine for a recoverable stream problem:
// oversized frames are dropped, invalid JSON lines are skipped, and a message handler
// that throws is reported instead of killing the reader loop.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerConnection, object, type Message } from "../app-server-connection.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await delay(5); }
  assert.fail("Fixture engine did not reach the expected state");
}
const notify = (method: string): Message => ({ method, params: {} });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gw-conn-resilience-"));
  const state = join(directory, "state"); await mkdir(state);
  const sdk = join(directory, "codex");
  await writeFile(sdk, `#!${process.execPath}
const {createInterface}=require('node:readline');
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id==null)return;
 if(m.method==='fixture/emit'){for(const x of m.params.messages||[])send(x);send({id:m.id,result:{}});}
 else if(m.method==='fixture/frames'){for(const f of m.params.frames||[])process.stdout.write(f+'\\n');send({id:m.id,result:{}});}
 else if(m.method==='fixture/huge'){send({method:'fixture/bulk',params:{fill:'x'.repeat(m.params.padBytes)}});for(const x of m.params.messages||[])send(x);send({id:m.id,result:{}});}
 else if(m.method==='fixture/self-exit'){process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n',()=>process.exit(m.params.code||0));}
 else if(m.method==='fixture/half-frame'){process.stdout.write('{"method":"note/half"');process.stdout.end();}
 else send({id:m.id,result:{}});
});
`, { mode: 0o700 });
  configureTelemetry(state, "test");
  const events = () => readTelemetry(state, Date.now() - 60_000);
  return { directory, state, sdk, events, clean: async () => { await flushTelemetry(); await rm(directory, { recursive: true, force: true }); } };
}

test("an invalid JSON line is skipped and the stream keeps delivering", { timeout: 15000 }, async () => {
  const f = await fixture(); const messages: Message[] = [];
  const connection = new AppServerConnection(f.sdk, [], async message => { messages.push(message); }, () => {});
  try {
    await connection.request("fixture/frames", { frames: ["!!! not json at all", JSON.stringify(notify("note/one"))] });
    assert.deepEqual(messages.map(message => message.method), ["note/one"]);
    assert.equal(connection.closed, false);
    assert.deepEqual(object(await connection.request("ping", {})), {});
    await flushTelemetry();
    const invalid = (await f.events()).filter(event => event.event === "engine_frame_invalid");
    assert.equal(invalid.length, 1); assert.equal(invalid[0].engine, "native");
  } finally { connection.stop(); await connection.exited; await f.clean(); }
});

test("a message handler that throws is reported and never stops the engine", { timeout: 15000 }, async () => {
  const f = await fixture(); const messages: Message[] = [];
  const connection = new AppServerConnection(f.sdk, [], async message => {
    if (message.method !== "note/good") throw new Error("Fixture handler failure");
    messages.push(message);
  }, () => {}, process.env, "gateway");
  try {
    await connection.request("fixture/emit", { messages: [notify("note/bad"), notify("note/not a-method!"), notify("note/good")] });
    assert.deepEqual(messages.map(message => message.method), ["note/good"]);
    assert.equal(connection.closed, false);
    assert.deepEqual(object(await connection.request("ping", {})), {});
    await flushTelemetry();
    const failed = (await f.events()).filter(event => event.event === "engine_message_failed");
    assert.equal(failed.length, 2);
    assert.deepEqual(failed.filter(event => event.method === "note/bad").map(event => event.engine), ["gateway"]);
    assert.equal(failed.some(event => event.method === undefined), true); // A method that is not a safe label is omitted.
  } finally { connection.stop(); await connection.exited; await f.clean(); }
});

test("a frame over 64 MiB is dropped with the next valid frame still delivered", { timeout: 30000 }, async () => {
  const f = await fixture(); const messages: Message[] = [];
  const connection = new AppServerConnection(f.sdk, [], async message => { messages.push(message); }, () => {});
  try {
    await connection.request("fixture/huge", { padBytes: 65 * 1024 * 1024, messages: [notify("note/after")] });
    assert.deepEqual(messages.map(message => message.method), ["note/after"]); // The oversized notification never reached the handler.
    assert.equal(connection.closed, false);
    assert.deepEqual(object(await connection.request("ping", {})), {});
    await flushTelemetry();
    const dropped = (await f.events()).filter(event => event.event === "engine_frame_dropped");
    assert.equal(dropped.length, 1); assert.equal(dropped[0].engine, "native"); assert.equal(dropped[0].sizeMiB, "64");
  } finally { connection.stop(); await connection.exited; await f.clean(); }
});

test("exitFacts distinguishes engine-initiated exits from adapter stops and their reasons", { timeout: 15000 }, async () => {
  const f = await fixture();
  const crashing = new AppServerConnection(f.sdk, [], async () => {}, () => {}, process.env, "gateway");
  const stopping = new AppServerConnection(f.sdk, [], async () => {}, () => {}, process.env, "native");
  try {
    await crashing.request("fixture/self-exit", { code: 3 });
    await crashing.exited;
    assert.equal(crashing.engine, "gateway");
    assert.equal(crashing.exitFacts.initiatedBy, "engine");
    assert.equal(crashing.exitFacts.reason, "none");
    assert.equal(crashing.exitFacts.code, 3);
    assert.equal(typeof crashing.exitFacts.uptimeMs, "number");
    stopping.stop("idle");
    await stopping.exited;
    assert.equal(stopping.engine, "native");
    assert.equal(stopping.exitFacts.initiatedBy, "adapter");
    assert.equal(stopping.exitFacts.reason, "idle");
  } finally {
    for (const connection of [crashing, stopping]) { connection.stop("session_end"); await connection.exited.catch(() => {}); }
    await f.clean();
  }
});

test("a stream that ends inside a JSON frame stops the engine with reason stream_error", { timeout: 15000 }, async () => {
  const f = await fixture();
  const connection = new AppServerConnection(f.sdk, [], async () => {}, () => {}, process.env, "native");
  try {
    // A torn frame is a real transport failure, not a recoverable one: the adapter stops the engine.
    void connection.request("fixture/half-frame", {}).catch(() => undefined);
    await until(() => connection.closed);
    assert.equal(connection.exitFacts.initiatedBy, "adapter");
    assert.equal(connection.exitFacts.reason, "stream_error");
  } finally { connection.stop("session_end"); await connection.exited.catch(() => {}); await f.clean(); }
});
