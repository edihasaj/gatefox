import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect, createServer, type Socket } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRelay, frameReader, maxRelayFrame, relayContent, type RelayFailure } from "../providers/claude-relay.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const png = "data:image/png;base64," + Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]).toString("base64");

async function relay(key = "k".repeat(64)) {
  const directory = await mkdtemp(join(tmpdir(), "relay-")); const path = join(directory, "r.sock");
  const failures: RelayFailure[] = []; const value = new ClaudeRelay(key, reason => failures.push(reason));
  await value.listen(path);
  /** A client like the MCP child: it says hello, then sends call frames and collects answers. */
  const client = async (hello = key) => {
    const socket = connect(path); socket.setEncoding("utf8");
    const answers: Array<Record<string, unknown>> = []; let closed = false;
    socket.on("data", frameReader(frame => answers.push(frame), () => {})); socket.on("close", () => { closed = true; }); socket.on("error", () => {});
    socket.write(JSON.stringify({ hello }) + "\n");
    return { socket, answers, closed: () => closed, call: (frame: Record<string, unknown>) => socket.write(JSON.stringify(frame) + "\n") };
  };
  return { value, failures, client, done: async () => { value.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function until(check: () => boolean, ms = 2000) { const started = Date.now(); while (!check()) { if (Date.now() - started > ms) throw new Error("timed out"); await sleep(5); } }

test("the relay accepts only the session key, from exactly one client", async () => {
  const r = await relay();
  try {
    const intruder = await r.client("wrong");
    await until(() => intruder.closed());
    assert.equal(await r.value.waitReady(50), false, "a wrong key is dropped without effect");
    const child = await r.client();
    assert.equal(await r.value.waitReady(1000), true);
    const second = await r.client();
    await until(() => second.closed());
    assert.equal(child.closed(), false); assert.deepEqual(r.failures, []);
  } finally { await r.done(); }
});

test("outputs and calls meet in either order, by tool_use id or first in first out by name", async () => {
  const r = await relay();
  try {
    const child = await r.client(); await r.value.waitReady(1000);
    // A call can arrive while its message is still streaming.
    child.call({ call: 1, name: "alpha", toolUseId: "t1" }); await sleep(20);
    assert.equal(r.value.expect([{ id: "t1", name: "alpha" }, { id: "t2", name: "alpha" }, { id: "t3", name: "beta" }]), true);
    r.value.deliver(new Map([["t1", relayContent("one")], ["t2", relayContent([{ type: "input_text", text: "two" }, { type: "input_image", image_url: png }])], ["t3", relayContent([])]]));
    await until(() => child.answers.length === 1);
    assert.deepEqual(child.answers[0], { result: 1, content: [{ type: "text", text: "one" }] });
    child.call({ call: 2, name: "alpha" }); child.call({ call: 3, name: "beta", toolUseId: "t3" });
    await until(() => child.answers.length === 3);
    assert.deepEqual(child.answers.slice(1), [
      { result: 2, content: [{ type: "text", text: "two" }, { type: "image", data: png.split(",")[1], mimeType: "image/png" }] },
      { result: 3, content: [{ type: "text", text: "" }] },
    ]);
    assert.deepEqual(r.failures, []);
  } finally { await r.done(); }
});

test("a call the session never returned closes the relay", async () => {
  const early = await relay();
  try {
    const child = await early.client(); await early.value.waitReady(1000);
    child.call({ call: 1, name: "alpha", toolUseId: "elsewhere" }); await sleep(20);
    assert.equal(early.value.expect([{ id: "t1", name: "alpha" }]), false, "an early call must be among the returned calls");
  } finally { await early.done(); }
  const late = await relay();
  try {
    const child = await late.client(); await late.value.waitReady(1000);
    late.value.expect([{ id: "t1", name: "alpha" }]);
    child.call({ call: 9, name: "alpha", toolUseId: "t9" });
    await until(() => late.failures.length > 0);
    assert.deepEqual(late.failures, ["unknown_call"]); assert.equal(child.answers.length, 0);
  } finally { await late.done(); }
});

test("frames are bounded", async () => {
  const frames: unknown[] = []; let oversize = 0;
  const read = frameReader(frame => frames.push(frame), () => oversize++);
  read('{"a":1}\n{"b"'); read(':2}\nnot json\n[1]\n');
  assert.deepEqual(frames, [{ a: 1 }, { b: 2 }]);
  read("x".repeat(maxRelayFrame + 1)); assert.equal(oversize, 1);
  const r = await relay();
  try {
    const child = await r.client(); await r.value.waitReady(1000);
    child.socket.write("y".repeat(maxRelayFrame + 2));
    await until(() => r.failures.length > 0, 5000);
    assert.deepEqual(r.failures, ["frame_too_large"]);
  } finally { await r.done(); }
});

test("the MCP child forwards no arguments, and losing the relay SIGKILLs its parent without answering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-child-"));
  const path = join(directory, "r.sock"); const log = join(directory, "parent.jsonl");
  let socket: Socket | undefined; const frames: Array<Record<string, unknown>> = [];
  const server = createServer(connection => { socket = connection; connection.setEncoding("utf8"); connection.on("data", frameReader(frame => frames.push(frame), () => {})); });
  await new Promise<void>(resolve => server.listen(path, resolve));
  await writeFile(join(directory, "tools.json"), JSON.stringify([{ name: "alpha", description: "Caller tool alpha.", inputSchema: { type: "object" } }]));
  await writeFile(join(directory, "relay.json"), JSON.stringify({ socket: path, key: "secret-key" }));
  // A stand-in for the CLI: it runs the MCP child, asks for one call and records every answer.
  const parentScript = join(directory, "parent.mjs");
  await writeFile(parentScript, `import {spawn} from 'node:child_process';import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
const child=spawn(process.execPath,${JSON.stringify([fileURLToPath(new URL("../providers/claude-tools.js", import.meta.url)), join(directory, "tools.json"), join(directory, "relay.json")])},{stdio:['pipe','pipe','inherit']});
createInterface({input:child.stdout}).on('line',line=>appendFileSync(${JSON.stringify(log)},line+'\\n'));
const send=m=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
send({id:1,method:'initialize',params:{}});send({id:2,method:'tools/list'});
send({id:3,method:'tools/call',params:{name:'alpha',arguments:{secret:'never forwarded'},_meta:{'claudecode/toolUseId':'toolu_1'}}});
setInterval(()=>{},1000);\n`);
  const parent = spawn(process.execPath, [parentScript], { stdio: "ignore" });
  const exited = new Promise<string | null>(resolve => parent.once("exit", (_code, signal) => resolve(signal)));
  try {
    await until(() => frames.length === 2);
    assert.deepEqual(frames, [{ hello: "secret-key" }, { call: 3, name: "alpha", toolUseId: "toolu_1" }]);
    const listed = JSON.parse((await readFile(log, "utf8")).split("\n")[1]) as { result: { tools: Array<{ _meta?: Record<string, unknown> }> } };
    assert.equal(listed.result.tools[0]._meta?.["anthropic/maxResultSizeChars"], 2000000);
    socket!.destroy();
    assert.equal(await exited, "SIGKILL");
    const answers = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { id?: number });
    assert.deepEqual(answers.map(answer => answer.id), [1, 2], "the call was never answered");
  } finally { parent.kill("SIGKILL"); server.close(); await rm(directory, { recursive: true, force: true }); }
});
