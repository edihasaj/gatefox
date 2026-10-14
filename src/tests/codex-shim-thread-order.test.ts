import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { shimFiles } from "./shim-fixture.js";

// The SDK writes a thread/start reply before announcing the thread. The desktop hides a
// prewarmed chat only when it sees the reply first; otherwise the empty chat appears in
// the sidebar and reopening it resumes a thread that has no rollout.
test("shim delivers each thread/start reply before that thread's notifications", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const files = await shimFiles();
  const source = await readFile(files.backend, "utf8");
  const reply = "send({id:m.id,result:{serviceTier:null,thread,modelProvider:thread.modelProvider,model:thread.model}});";
  assert.ok(source.includes(reply));
  await writeFile(files.backend, source.replace(reply, reply + "send({method:'thread/started',params:{thread}});send({method:'mcpServer/startupStatus/updated',params:{threadId:thread.id,status:'starting'}});"), { mode: 0o700 });
  const child = spawn(process.execPath, [files.cli, "codex-shim", "--config", files.config, "--codex", files.backend, "--", "app-server"], { stdio: ["pipe", "pipe", "pipe"], env: files.env });
  child.stderr.resume();
  const order: Array<{ kind: string; thread: string }> = []; const pending = new Map<number, (message: Record<string, unknown>) => void>(); let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const message = JSON.parse(line);
    const thread = message.params?.thread?.id ?? message.params?.threadId ?? message.result?.thread?.id;
    if (typeof thread === "string") order.push({ kind: typeof message.id === "number" ? "reply" : String(message.method), thread });
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  const rpc = (method: string, params = {}) => new Promise<Record<string, unknown>>(resolve => { pending.set(++id, resolve); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
  try {
    await rpc("initialize", { clientInfo: { name: "test", version: "1" } });
    for (const model of ["claude/model", "native"]) {
      const started = await rpc("thread/start", { model, modelProvider: "openai" });
      const thread = ((started.result as Record<string, unknown>).thread as { id: string }).id;
      await new Promise(resolve => setTimeout(resolve, 50));
      const kinds = order.filter(entry => entry.thread === thread).map(entry => entry.kind);
      assert.deepEqual(kinds, ["reply", "thread/started", "mcpServer/startupStatus/updated"], `${model} chat messages arrived out of SDK order`);
    }
  } finally { child.kill("SIGKILL"); lines.close(); files.close(); }
});
