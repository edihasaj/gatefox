// The adapter must never stop a healthy engine for a recoverable stream problem:
// oversized frames are dropped, invalid JSON lines are skipped, and a message handler
// that throws is reported instead of killing the reader loop.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerConnection, ENGINE_FRAME_LIMIT, isId, jsonLines, object, type Message } from "../app-server-connection.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

// The adapter gives a broken pipe half a second to turn out to be an engine that was already leaving.
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 800; attempt++) { if (check()) return; await delay(5); }
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
let waiting=null;let lastId=null;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(waiting!==null&&m.id===waiting.serverId&&m.method===undefined){send({id:waiting.requestId,result:{reply:m}});waiting=null;return;}
 if(m.id==null)return;
 if(m.method==='fixture/emit'){for(const x of m.params.messages||[])send(x);send({id:m.id,result:{}});}
 else if(m.method==='fixture/frames'){for(const f of m.params.frames||[])process.stdout.write(f+'\\n');send({id:m.id,result:{}});}
 else if(m.method==='fixture/huge'){send({method:'fixture/bulk',params:{fill:'x'.repeat(m.params.padBytes)}});for(const x of m.params.messages||[])send(x);send({id:m.id,result:{}});}
 else if(m.method==='fixture/huge-response'){process.stdout.write(JSON.stringify({id:m.id,result:{fill:'x'.repeat(m.params.padBytes)}})+'\\n');}
 else if(m.method==='fixture/server-request'){waiting={requestId:m.id,serverId:m.params.serverId};send({id:m.params.serverId,method:'fixture/approval',params:{threadId:'chat'}});}
 else if(m.method==='fixture/self-exit'){process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n',()=>process.exit(m.params.code||0));}
 else if(m.method==='fixture/exit-with-frame'){process.stdin.destroy();process.stdout.write((m.params.messages||[]).map(x=>JSON.stringify(x)).join('\\n')+(m.params.messages&&m.params.messages.length?'\\n':''),()=>process.exit(0));}
 else if(m.method==='fixture/half-frame'){process.stdout.write('{"method":"note/half"');process.stdout.end();}
 else if(m.method==='fixture/huge-server-request'){lastId=m.id;process.stdout.write(JSON.stringify({id:m.id,method:'fixture/approval',params:{threadId:'chat',fill:'x'.repeat(m.params.padBytes)}})+'\\n');}
 else if(m.method==='fixture/reply-last'){send({id:lastId,result:{ok:true}});send({id:m.id,result:{}});}
 else if(m.method==='fixture/orphan-exit'){const cp=require('node:child_process'),fs=require('node:fs');const hold=m.params.holdMs||1500;
  const g=cp.spawn(process.execPath,['-e','process.on("SIGTERM",()=>process.exit(0));setTimeout(()=>{},'+hold+')'],{stdio:['ignore','inherit','ignore']});
  fs.writeFileSync(m.params.pidFile,String(g.pid));process.stdout.write(JSON.stringify({method:'note/orphan-final'})+'\\n',()=>process.exit(0));}
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

// Regression: the oversized frame used to swallow the valid line that followed it, because the
// discard flag was set after the frame had already ended on this chunk's newline.
test("an oversized frame that ends in the same chunk drops only itself", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const tail = Buffer.from(`\n${JSON.stringify(notify("note/one"))}\n${JSON.stringify(notify("note/two"))}\n`);
    const head = Buffer.alloc(ENGINE_FRAME_LIMIT - 10, 0x78); const middle = Buffer.alloc(20, 0x79);
    const variants: Array<[string, Buffer[]]> = [
      ["across two chunks", [head, Buffer.concat([middle, tail])]], // The newline that ends the oversized frame opens the next one.
      ["inside one chunk", [Buffer.concat([head, middle, tail])]],
    ];
    const lines: string[][] = [];
    for (const [, chunks] of variants) {
      const read: string[] = [];
      for await (const line of jsonLines(Readable.from(chunks), "native")) read.push(line);
      lines.push(read);
    }
    for (const read of lines) {
      assert.deepEqual(read.map(line => object(JSON.parse(line)).method), ["note/one", "note/two"]);
    }
    await flushTelemetry();
    const dropped = (await f.events()).filter(event => event.event === "engine_frame_dropped");
    assert.equal(dropped.length, 2); // Exactly one drop event per oversized frame, not one per swallowed neighbour.
    assert.deepEqual(dropped.map(event => event.sizeMiB), ["64", "64"]);
  } finally { await f.clean(); }
});

test("an engine that exits while the adapter writes is an engine exit whose last frame still arrives", { timeout: 15000 }, async () => {
  const f = await fixture(); const messages: Message[] = [];
  const connection = new AppServerConnection(f.sdk, [], async message => { messages.push(message); }, () => {}, process.env, "native");
  try {
    // The fixture breaks the pipe and leaves, so the adapter sees a stdin error before the exit does.
    void connection.request("fixture/exit-with-frame", { messages: [notify("note/final")] }).catch(() => undefined);
    for (let sent = 0; sent < 4000 && !connection.closed; sent++) { connection.send(notify("note/keepalive")); if (sent % 64 === 63) await delay(1); }
    await connection.exited;
    assert.equal(messages.some(message => message.method === "note/final"), true); // Nothing was destroyed before it drained.
    assert.equal(connection.exitFacts.initiatedBy, "engine");
    assert.equal(connection.exitFacts.reason, "none");
  } finally { connection.stop("session_end"); await connection.exited.catch(() => {}); await f.clean(); }
});

test("a server request the adapter cannot pass on is answered, not left waiting", { timeout: 15000 }, async () => {
  const f = await fixture();
  const connection = new AppServerConnection(f.sdk, [], async message => { if (isId(message.id)) throw new Error("Fixture client is gone"); }, () => {}, process.env, "native");
  try {
    const answer = await connection.request("fixture/server-request", { serverId: 4242, serverMethod: "fixture/approval" });
    assert.deepEqual(object(object(answer.reply).error), { code: -32603, message: "The adapter could not deliver this request" });
    assert.equal(connection.closed, false);
    assert.deepEqual(object(await connection.request("ping", {})), {}); // The engine is alive and the loop kept reading.
  } finally { connection.stop(); await connection.exited; await f.clean(); }
});

test("a dropped oversized response frame fails its pending request instead of waiting for the timeout", { timeout: 30000 }, async () => {
  const f = await fixture();
  const connection = new AppServerConnection(f.sdk, [], async () => {}, () => {}, process.env, "gateway");
  try {
    await assert.rejects(() => connection.request("fixture/huge-response", { padBytes: 65 * 1024 * 1024 }), /too large to read/);
    assert.equal(connection.closed, false);
    assert.deepEqual(object(await connection.request("ping", {})), {});
    await flushTelemetry();
    const dropped = (await f.events()).filter(event => event.event === "engine_frame_dropped");
    assert.equal(dropped.length, 1); assert.equal(dropped[0].engine, "gateway");
  } finally { connection.stop(); await connection.exited; await f.clean(); }
});

// Regression for the dropped frame's method guard: a server request that was too large to read starts
// with an id like an answer does. Failing the adapter's own pending request for it would end a healthy
// chat over a frame that was never a reply to anything.
test("a dropped oversized server request leaves the pending request that shares its id alone", { timeout: 30000 }, async () => {
  const f = await fixture(); const messages: Message[] = [];
  const connection = new AppServerConnection(f.sdk, [], async message => { messages.push(message); }, () => {}, process.env, "gateway");
  try {
    // The fixture carries this request's own id in the oversized frame and then answers nothing.
    const pending = connection.request("fixture/huge-server-request", { padBytes: 65 * 1024 * 1024 });
    let settled = "pending"; pending.then(() => { settled = "resolved"; }, () => { settled = "rejected"; }); // Watch how it ends without consuming it.
    let dropped: Awaited<ReturnType<typeof f.events>> = [];
    for (let attempt = 0; attempt < 400 && !dropped.length; attempt++) {
      await flushTelemetry();
      dropped = (await f.events()).filter(event => event.event === "engine_frame_dropped");
      if (!dropped.length) await delay(10);
    }
    assert.equal(dropped.length, 1); assert.equal(dropped[0].sizeMiB, "64"); assert.equal(dropped[0].engine, "gateway");
    assert.equal(messages.length, 0); // Its bytes were discarded, so the handler never saw it either.
    await delay(50); // The drop is already recorded, so any wrong rejection would have landed by now.
    assert.equal(settled, "pending", "a dropped server request must not answer for an adapter request");
    await connection.request("fixture/reply-last", {}); // Its real answer, late but well-formed, still lands.
    assert.deepEqual(object(await pending), { ok: true });
    assert.equal(connection.closed, false);
  } finally { connection.stop(); await connection.exited.catch(() => {}); await f.clean(); }
});

// Regression for the exit recheck inside the pipe grace: the engine process can be gone while something
// it spawned still holds the stdout pipe open. The pipe error is then the engine leaving, not the
// adapter's fault, and whatever the engine wrote before it died still has to reach the handler.
test("an engine that exits behind a grandchild holding stdout open stays an engine exit", { timeout: 20000 }, async () => {
  const f = await fixture(); const messages: Message[] = [];
  const pidFile = join(f.directory, "grandchild.pid");
  const connection = new AppServerConnection(f.sdk, [], async message => { messages.push(message); }, () => {}, process.env, "native");
  let grandchild: number | undefined;
  try {
    void connection.request("fixture/orphan-exit", { holdMs: 1600, pidFile }).catch(() => undefined);
    for (let attempt = 0; attempt < 300 && grandchild === undefined; attempt++) {
      const written = await readFile(pidFile, "utf8").catch(() => "");
      if (written) grandchild = Number(written);
      if (grandchild === undefined) await delay(5);
    }
    assert.ok(grandchild !== undefined && Number.isInteger(grandchild));
    // Keep writing: the first write after the engine leaves reports EPIPE, and the grace starts there.
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !connection.closed) { for (let sent = 0; sent < 64; sent++) connection.send(notify("note/keepalive")); await delay(2); }
    await connection.exited; // The close only lands once the grandchild lets go of the pipe.
    assert.equal(messages.some(message => message.method === "note/orphan-final"), true);
    assert.equal(connection.exitFacts.initiatedBy, "engine");
    assert.equal(connection.exitFacts.reason, "none");
    assert.equal(connection.exitFacts.code, 0);
  } finally {
    if (grandchild !== undefined) { try { process.kill(grandchild, "SIGKILL"); } catch { /* Already gone with the pipe. */ } }
    connection.stop("session_end"); await connection.exited.catch(() => {}); await f.clean();
  }
});
