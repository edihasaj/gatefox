import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import test from "node:test";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { object, type Message } from "../app-server-connection.js";
import { shimFiles } from "./shim-fixture.js";

interface RpcClient {
  rpc(method: string, params?: Message): Promise<Message>;
  messages: Message[];
  close(): Promise<void>;
}

async function adapter(fixture: Awaited<ReturnType<typeof shimFiles>>): Promise<RpcClient> {
  const child = spawn(process.execPath, [fixture.cli, "codex-shim", "--config", fixture.config, "--codex", fixture.backend, "--", "app-server"], { stdio: ["pipe", "pipe", "ignore"], env: fixture.env });
  const lines = createInterface({ input: child.stdout });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  const pending = new Map<number, (message: Message) => void>();
  const messages: Message[] = [];
  let id = 0;
  lines.on("line", line => {
    const message = JSON.parse(line) as Message;
    messages.push(message);
    if (message.method === "item/commandExecution/requestApproval" && typeof message.id === "string") {
      child.stdin.write(JSON.stringify({ id: message.id, result: { decision: "accept" } }) + "\n");
    }
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  return {
    messages,
    rpc: (method, params = {}) => new Promise<Message>(resolve => {
      const requestId = ++id;
      pending.set(requestId, message => { pending.delete(requestId); resolve(message); });
      child.stdin.write(JSON.stringify({ id: requestId, method, params }) + "\n");
    }),
    close: async () => {
      lines.close();
      child.stdin.end();
      const stopped = await Promise.race([exited.then(() => true), delay(1_000).then(() => false)]);
      if (!stopped) { child.kill("SIGKILL"); await exited; }
    },
  };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), `timed out waiting for ${description}`);
}

test("stock resume returns the SDK reply without looking up or synthesizing a historical terminal", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const fixture = await shimFiles();
  const lookup = join(fixture.directory, "turn-lookup");
  const source = await readFile(fixture.backend, "utf8");
  await writeFile(fixture.backend, source.replace("else if(m.method==='remoteControl/status/read')", `else if(m.method==='thread/turns/list'){fs.writeFileSync(${JSON.stringify(lookup)}, 'looked-up');send({id:m.id,result:{data:[{id:'turn',status:'completed',completedAt:2000000000}]}});}\n else if(m.method==='remoteControl/status/read')`), { mode: 0o700 });
  const client = await adapter(fixture);
  try {
    await client.rpc("initialize", { clientInfo: { name: "test", version: "1" } });
    const started = await client.rpc("thread/start", { model: "native", modelProvider: "openai" });
    const threadId = String(object(object(started.result).thread).id);
    await writeFile(join(fixture.value.stateDirectory, "completion-replay.json"), JSON.stringify({ [`local\0${threadId}`]: {
      device: "local", threadId, turnId: "turn", followedAt: Date.now(), delivered: false,
    } }), { mode: 0o600 });
    const before = client.messages.length;
    const resumed = await client.rpc("thread/resume", { threadId });
    assert.deepEqual(resumed.result, { serviceTier: null, thread: { id: threadId, modelProvider: "openai", model: "native", ephemeral: false }, modelProvider: "openai", model: "native" });
    await delay(100);
    assert.equal(await readFile(lookup, "utf8").then(() => true, () => false), false, "resume did not query a historical turn");
    assert.equal(client.messages.slice(before).some(message => message.method === "turn/completed"), false, "resume did not synthesize a terminal");
  } finally { await client.close(); await fixture.close(); }
});

test("failed and non-resume SDK RPCs do not consult historical completion replay", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const fixture = await shimFiles();
  const lookup = join(fixture.directory, "turn-lookup");
  const source = await readFile(fixture.backend, "utf8");
  await writeFile(fixture.backend, source.replace("else if(m.method==='remoteControl/status/read')", `else if(m.method==='thread/turns/list'){fs.writeFileSync(${JSON.stringify(lookup)}, 'looked-up');send({id:m.id,result:{data:[]}});}\n else if(m.method==='remoteControl/status/read')`), { mode: 0o700 });
  const client = await adapter(fixture);
  try {
    await client.rpc("initialize", { clientInfo: { name: "test", version: "1" } });
    const started = await client.rpc("thread/start", { model: "native", modelProvider: "openai" });
    const threadId = String(object(object(started.result).thread).id);
    await writeFile(join(fixture.value.stateDirectory, "completion-replay.json"), JSON.stringify({
      ["local\0missing"]: { device: "local", threadId: "missing", turnId: "turn", followedAt: Date.now(), delivered: false },
      [`local\0${threadId}`]: { device: "local", threadId, turnId: "turn", followedAt: Date.now(), delivered: false },
    }), { mode: 0o600 });
    const failed = await client.rpc("thread/resume", { threadId: "missing" });
    assert.equal(object(failed.error).message, "Thread not found");
    await client.rpc("thread/read", { threadId });
    await delay(100);
    assert.equal(await readFile(lookup, "utf8").then(() => true, () => false), false);
    assert.equal(client.messages.some(message => message.method === "turn/completed"), false);
  } finally { await client.close(); await fixture.close(); }
});

test("a live terminal still forwards once through the stock shim", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const fixture = await shimFiles();
  const client = await adapter(fixture);
  try {
    await client.rpc("initialize", { clientInfo: { name: "test", version: "1" } });
    const started = await client.rpc("thread/start", { model: "native", modelProvider: "openai" });
    const threadId = String(object(object(started.result).thread).id);
    await client.rpc("turn/start", { threadId, model: "native", input: [] });
    await waitFor(() => client.messages.some(message => message.method === "turn/completed"), "the live terminal");
    await delay(50);
    const terminals = client.messages.filter(message => message.method === "turn/completed");
    assert.equal(terminals.length, 1);
    assert.deepEqual(terminals[0]!.params, { threadId, turn: { id: "turn", status: "completed" } });
  } finally { await client.close(); await fixture.close(); }
});

