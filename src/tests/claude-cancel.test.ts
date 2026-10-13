import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ClaudeSubscription } from "../providers/claude.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid: number, withinMs: number): Promise<number> {
  const started = Date.now();
  while (alive(pid)) { if (Date.now() - started > withinMs) return Infinity; await new Promise(resolve => setTimeout(resolve, 5)); }
  return Date.now() - started;
}

// A long answer from a CLI that ignores SIGTERM and records every stdin line it receives.
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-cancel-"));
  const capture = join(directory, "stdin.jsonl"); const pidFile = join(directory, "pid");
  const script = `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});let input='';for await(const chunk of process.stdin)input+=chunk;
writeFileSync(${JSON.stringify(capture)},input);writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
console.log(JSON.stringify({type:'stream_event',event:{type:'message_start',message:{id:'msg_1',usage:{input_tokens:1}}}}));
setInterval(()=>console.log(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'more '}}})),20);\n`;
  await writeFile(join(directory, "claude"), script); await chmod(join(directory, "claude"), 0o700);
  const previous = process.env.PATH; process.env.PATH = directory + delimiter + process.env.PATH;
  return { directory, capture, pid: async () => Number(await readFile(pidFile, "utf8")),
    restore: async () => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; await rm(directory, { recursive: true, force: true }); } };
}

test("cancelling a one-shot request SIGKILLs the CLI at once and reports an interrupted cancellation", async () => {
  const f = await fixture();
  configureTelemetry(f.directory, "test"); const since = Date.now();
  try {
    const adapter = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { alias: "fixture" } });
    const controller = new AbortController(); let abortedAt = 0; let texts = 0;
    await assert.rejects(async () => {
      for await (const event of adapter.infer({ model: "fixture", input: "write a long answer" }, controller.signal)) {
        if (event.type === "text" && ++texts === 2) { abortedAt = Date.now(); controller.abort(); }
      }
    }, { code: "cancelled", status: 499 });
    const pid = await f.pid();
    const elapsed = await gone(pid, 300);
    assert.ok(elapsed < 300, `the CLI ignored SIGTERM but was gone ${elapsed} ms after the abort check, ${Date.now() - abortedAt} ms after abort`);
    const lines = (await readFile(f.capture, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { type: string });
    assert.deepEqual(lines.map(line => line.type), ["user"], "one-shot sends no control requests");
    await flushTelemetry();
    const cli = (await readTelemetry(f.directory, since)).find(entry => entry.event === "claude_cli")!;
    assert.deepEqual({ mode: cli.mode, interrupted: cli.interrupted, aborted: cli.aborted, result: cli.result }, { mode: "oneshot", interrupted: true, aborted: true, result: "none" });
  } finally { await f.restore(); }
});

test("a consumer that stops reading also stops the CLI", async () => {
  const f = await fixture();
  try {
    const adapter = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { alias: "fixture" } });
    const events = adapter.infer({ model: "fixture", input: "write a long answer" }, new AbortController().signal)[Symbol.asyncIterator]();
    assert.equal((await events.next()).value?.type, "text");
    await events.return?.(undefined);
    assert.ok(await gone(await f.pid(), 300) < 300);
  } finally { await f.restore(); }
});
