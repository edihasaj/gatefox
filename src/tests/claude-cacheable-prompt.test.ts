import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeNativeToolName } from "../providers/claude-tool-names.js";
import { responsesToChatRequest } from "../protocol/request.js";
import { ProviderError } from "../providers/provider.js";
import { streamFailureCode } from "../provider-failure.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { InferenceEvent, ResponsesInputItem, ResponsesTool } from "../protocol/types.js";

const drain = async (events: AsyncIterable<InferenceEvent>) => { const result: InferenceEvent[] = []; for await (const event of events) result.push(event); return result; };

test("Claude history grows by appending content blocks, so earlier blocks stay cacheable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-cache-"));
  const capture = join(directory, "input.jsonl");
  const script = `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk;appendFileSync(${JSON.stringify(capture)},input.trim()+'\\n');
console.log(JSON.stringify({type:'result',is_error:false,subtype:'success',result:'ok',usage:{input_tokens:2,cache_read_input_tokens:40,output_tokens:1}}));\n`;
  await writeFile(join(directory, "claude"), script); await chmod(join(directory, "claude"), 0o700);
  const previous = process.env.PATH; process.env.PATH = directory + delimiter + process.env.PATH;
  try {
    const adapter = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { alias: "fixture" } });
    const tools = [{ type: "function" as const, name: "read_note", description: "Reads a note", parameters: { type: "object", properties: { id: { type: "string" } } } }];
    const first: ResponsesInputItem[] = [{ type: "message", role: "developer", content: "Stable instructions" }, { type: "message", role: "user", content: "Read note alpha" }];
    const second: ResponsesInputItem[] = [...first, { type: "function_call", call_id: "call_1", name: "read_note", arguments: "{\"id\":\"alpha\"}" }, { type: "function_call_output", call_id: "call_1", output: "blue harbor" }];
    const events = await drain(adapter.infer({ model: "fixture", input: first, tools }, new AbortController().signal));
    assert.deepEqual(events.at(-1), { type: "done", usage: { input_tokens: 42, output_tokens: 1, total_tokens: 43, input_tokens_details: { cached_tokens: 40 } }, accounting: { cacheWriteTokens: 0 } });
    // The fixture never calls the required tool; only the prompt it received matters here.
    await assert.rejects(drain(adapter.infer({ model: "fixture", input: second, tools, tool_choice: "required" }, new AbortController().signal)), { code: "invalid_tool_call" });
    const [a, b] = (await readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line).message.content as Array<{ type: string; text?: string }>);
    assert.ok(b.length > a.length);
    assert.deepEqual(b.slice(0, a.length), a, "every block of the shorter request is unchanged and in place");
    assert.equal(b.at(-1)?.text, "Use one of the caller tools.", "per-request instructions follow the history");
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; await rm(directory, { recursive: true, force: true }); }
});

test("Claude thinking summaries are requested unless the caller disables them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-display-"));
  const capture = join(directory, "argv.jsonl");
  const script = `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';for await(const _ of process.stdin){}appendFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2))+'\\n');
console.log(JSON.stringify({type:'result',is_error:false,subtype:'success',result:'ok',usage:{input_tokens:1,output_tokens:1}}));\n`;
  await writeFile(join(directory, "claude"), script); await chmod(join(directory, "claude"), 0o700);
  const previous = process.env.PATH; process.env.PATH = directory + delimiter + process.env.PATH;
  try {
    const adapter = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { alias: "fixture" } });
    for (const summary of ["auto", "none"]) await drain(adapter.infer({ model: "fixture", input: "fixture", reasoning: { effort: "max", summary } }, new AbortController().signal));
    const [auto, none] = (await readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    assert.deepEqual(auto.slice(auto.indexOf("--thinking-display"), auto.indexOf("--thinking-display") + 2), ["--thinking-display", "summarized"]);
    assert.deepEqual(auto.slice(auto.indexOf("--effort"), auto.indexOf("--effort") + 2), ["--effort", "max"]);
    assert.equal(none.includes("--thinking-display"), false);
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; await rm(directory, { recursive: true, force: true }); }
});

test("Opus 4.6 runs as the CLI's included 1M variant while keeping its plain alias", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-1m-"));
  const capture = join(directory, "argv.jsonl");
  const script = `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';for await(const _ of process.stdin){}appendFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2))+'\\n');
console.log(JSON.stringify({type:'result',is_error:false,subtype:'success',result:'ok',usage:{input_tokens:1,output_tokens:1}}));\n`;
  await writeFile(join(directory, "claude"), script); await chmod(join(directory, "claude"), 0o700);
  const previous = process.env.PATH; process.env.PATH = directory + delimiter + process.env.PATH;
  try {
    const adapter = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { "claude/claude-opus-4-6": "claude-opus-4-6", "claude/claude-opus-5-5": "claude-opus-5-5" } });
    for (const model of ["claude-opus-4-6", "claude-opus-5-5"]) await drain(adapter.infer({ model, input: "fixture" }, new AbortController().signal));
    const [legacy, current] = (await readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    assert.equal(legacy[legacy.indexOf("--model") + 1], "claude-opus-4-6[1m]");
    assert.equal(current[current.indexOf("--model") + 1], "claude-opus-5-5");
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; await rm(directory, { recursive: true, force: true }); }
});

const noteTools: ResponsesTool[] = [{ type: "function", name: "read_note", parameters: { type: "object", properties: { id: { type: "string" } } } }, { type: "function", name: "write_note", parameters: { type: "object", properties: { id: { type: "string" } } } }];
// Records the private catalog and the prompt it received. With GATEWAY_FIXTURE_CALL set it answers with a tool:
// the first catalog tool that is not the required one ("wrong") or the required one ("right"), optionally after some text.
async function catalogFixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-catalog-"));
  const capture = join(directory, "capture.jsonl");
  const script = `#!${process.execPath}\nimport {appendFileSync,readFileSync} from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk;
const args=process.argv.slice(2);const mcp=JSON.parse(readFileSync(args[args.indexOf('--mcp-config')+1],'utf8'));const catalog=mcp.mcpServers.gateway?readFileSync(mcp.mcpServers.gateway.args[1],'utf8'):'';
const content=JSON.parse(input).message.content;appendFileSync(${JSON.stringify(capture)},JSON.stringify({catalog,content})+'\\n');
const mode=process.env.GATEWAY_FIXTURE_CALL;const out=value=>console.log(JSON.stringify(value));
if(!mode){out({type:'result',is_error:false,subtype:'success',result:'ok',usage:{input_tokens:1,output_tokens:1}});process.exit(0);}
const required=/Use the required caller tool (\\S+)\\.$/.exec(content.at(-1).text)[1];const names=JSON.parse(catalog).map(tool=>'mcp__gateway__'+tool.name);
const name=mode.startsWith('wrong')&&names.find(name=>name!==required)||required;
out({type:'stream_event',event:{type:'message_start',message:{id:'msg_1',usage:{input_tokens:1}}}});
if(mode.endsWith('text'))out({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Calling it.'}}});
out({type:'stream_event',event:{type:'content_block_start',index:1,content_block:{type:'tool_use',id:'toolu_1',name,input:{}}}});
out({type:'assistant',message:{id:'msg_1',content:[{type:'tool_use',id:'toolu_1',name,input:{id:'n1'}}]}});
out({type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:9}}});setInterval(()=>{},1000);\n`;
  await writeFile(join(directory, "claude"), script); await chmod(join(directory, "claude"), 0o700);
  const previous = { path: process.env.PATH, mode: process.env.GATEWAY_FIXTURE_CALL }; process.env.PATH = directory + delimiter + process.env.PATH;
  return { directory, captured: async () => (await readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { catalog: string; content: Array<{ text?: string }> }),
    restore: async () => { for (const [key, value] of [["PATH", previous.path], ["GATEWAY_FIXTURE_CALL", previous.mode]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(directory, { recursive: true, force: true }); } };
}

test("forced choices keep the whole catalog, and block 0 does not depend on it", async () => {
  const f = await catalogFixture();
  try {
    const adapter = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { alias: "fixture" } });
    const forced = { type: "function" as const, name: "write_note" };
    await drain(adapter.infer({ model: "fixture", input: "go", tools: noteTools }, new AbortController().signal));
    for (const tool_choice of ["required", forced] as const) await assert.rejects(drain(adapter.infer({ model: "fixture", input: "go", tools: noteTools, tool_choice }, new AbortController().signal)), { code: "invalid_tool_call" });
    await drain(adapter.infer({ model: "fixture", input: "go", tools: noteTools.slice(0, 1) }, new AbortController().signal));
    const [auto, required, object, smaller] = await f.captured();
    assert.equal(required.catalog, auto.catalog); assert.equal(object.catalog, auto.catalog, "the tools.json bytes are identical for auto and forced choices");
    assert.notEqual(smaller.catalog, auto.catalog);
    for (const run of [required, object, smaller]) assert.deepEqual(run.content[0], auto.content[0]);
    assert.ok(!auto.content.some(block => block.text?.includes("Tool names")));
    const write = claudeNativeToolName(responsesToChatRequest({ model: "fixture", input: "go", tools: noteTools }).tools![1]);
    assert.equal(object.content.at(-1)?.text, `Use the required caller tool ${write}.`);
  } finally { await f.restore(); }
});

test("a forced choice answered with another tool retries once with only the forced tool", async () => {
  const f = await catalogFixture();
  try {
    const adapter = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { alias: "fixture" } });
    const request = { model: "fixture", input: "go", tools: noteTools, tool_choice: { type: "function" as const, name: "write_note" } };
    process.env.GATEWAY_FIXTURE_CALL = "wrong";
    const events = await drain(adapter.infer(request, new AbortController().signal));
    assert.deepEqual(events.map(event => event.type === "tool" ? event.call.function.name : event.type), ["write_note", "done"]);
    const [first, retry] = await f.captured();
    assert.equal(JSON.parse(first.catalog).length, 2); assert.equal(JSON.parse(retry.catalog).length, 1, "the retry offers only the forced tool");
    // Text already streamed cannot be taken back, so that attempt fails instead of retrying,
    // with a code Codex treats as final rather than repeating the full-catalog inference.
    process.env.GATEWAY_FIXTURE_CALL = "wrong-text";
    await assert.rejects(drain(adapter.infer(request, new AbortController().signal)), (error: unknown) => error instanceof ProviderError && error.code === "upstream_rejected" &&
      error.upstream?.code === "forced_tool_mismatch" && streamFailureCode(error) === "invalid_prompt");
    assert.equal((await f.captured()).length, 3);
  } finally { await f.restore(); }
});

test("live mode without the live module runs one-shot and records the fallback once", async () => {
  const f = await catalogFixture();
  configureTelemetry(f.directory, "test"); const since = Date.now();
  try {
    const adapter = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { alias: "fixture" }, claudeSessions: { mode: "live" } }, undefined, undefined, "./claude-live-missing-fixture.js");
    for (const context of [{ threadId: "thread-1", requestKind: "compaction" as const }, {}, { threadId: "thread-1", requestKind: "turn" as const }, { threadId: "thread-1" }]) {
      const events = await drain(adapter.infer({ model: "fixture", input: "go" }, new AbortController().signal, context));
      assert.equal(events.at(-1)?.type, "done");
    }
    assert.equal((await f.captured()).length, 4, "every request ran one-shot");
    await flushTelemetry();
    const sessions = (await readTelemetry(f.directory, since)).filter(entry => entry.event === "claude_session");
    assert.deepEqual(sessions.map(entry => [entry.outcome, entry.missReason]), [["fallback", "unavailable"]]);
  } finally { await f.restore(); }
});

test("a live attach that throws before streaming falls back to one-shot, except for cancellation", async () => {
  const f = await catalogFixture();
  const module = join(f.directory, "live.mjs");
  await writeFile(module, `import {ProviderError} from ${JSON.stringify(new URL("../providers/provider.js", import.meta.url).href)};
export function claudeLive(){return{async attach(input){throw input.threadId==='cancel'?new ProviderError('cancelled','Request cancelled',499):new ProviderError('cli_failed','Claude CLI did not start');}};}\n`);
  configureTelemetry(f.directory, "test"); const since = Date.now();
  try {
    const adapter = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { alias: "fixture" }, claudeSessions: { mode: "live" } }, undefined, undefined, pathToFileURL(module).href);
    assert.equal((await drain(adapter.infer({ model: "fixture", input: "go" }, new AbortController().signal, { threadId: "thread-1" }))).at(-1)?.type, "done");
    await assert.rejects(drain(adapter.infer({ model: "fixture", input: "go" }, new AbortController().signal, { threadId: "cancel" })), { code: "cancelled" });
    assert.equal((await f.captured()).length, 1, "only the failed attach ran one-shot");
    await flushTelemetry();
    const sessions = (await readTelemetry(f.directory, since)).filter(entry => entry.event === "claude_session");
    assert.deepEqual(sessions.map(entry => [entry.outcome, entry.missReason]), [["fallback", "spawn_failed"]]);
  } finally { await f.restore(); }
});
