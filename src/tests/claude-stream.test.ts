import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ClaudeMessageStream } from "../providers/claude-stream.js";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeNativeToolName } from "../providers/claude-tool-names.js";
import { ProviderError } from "../providers/provider.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { InferenceEvent, OpenAITool } from "../protocol/types.js";

const tools: OpenAITool[] = ["alpha", "beta"].map(name => ({ type: "function", function: { name, parameters: { type: "object", properties: { path: { type: "string" } } }, responseTool: { type: "function", name } } }));
const alpha = claudeNativeToolName(tools[0]); const beta = claudeNativeToolName(tools[1]);
const event = (value: Record<string, unknown>) => ({ type: "stream_event", event: value });
const start = { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 24 } } };
const use = (index: number, id: string, name: string) => event({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } });
const assistant = (id: string, name: string, input: unknown) => ({ type: "assistant", message: { id: "msg_1", content: [{ type: "tool_use", id, name, input }], usage: { input_tokens: 10, output_tokens: 24 } } });
const delta = (stop: string, output: number) => event({ type: "message_delta", delta: { stop_reason: stop }, usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: output } });
// The observed CLI order: one assistant line per block, all sharing the message id, then message_delta.
const parallel = [event(start), use(0, "toolu_a", alpha), event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a\"}" } }),
  assistant("toolu_a", alpha, { path: "a" }), event({ type: "content_block_stop", index: 0 }), use(1, "toolu_b", beta), assistant("toolu_b", beta, { path: "b" }),
  event({ type: "content_block_stop", index: 1 }), delta("tool_use", 64), event({ type: "message_stop" })];

test("parallel tool calls end the request only at message_delta, with its output tokens", () => {
  const stream = new ClaudeMessageStream({ tools, summaryVisible: true });
  const steps = parallel.map(message => stream.accept(message));
  assert.equal(steps.findIndex(step => step.end), 8, "no end at the first assistant line");
  const end = steps[8].end!; assert.equal(end.kind, "tool_use");
  assert.deepEqual(end.kind === "tool_use" && end.calls.map(call => [call.id, call.function.name, call.function.arguments]), [["toolu_a", "alpha", "{\"path\":\"a\"}"], ["toolu_b", "beta", "{\"path\":\"b\"}"]]);
  assert.deepEqual(end.usage, { input_tokens: 115, output_tokens: 64, total_tokens: 179, input_tokens_details: { cached_tokens: 100 } });
  assert.deepEqual(end.tokens, { input: 10, cacheRead: 100, cacheWrite: 5, output: 64 });
  assert.equal(steps[9].end, undefined, "message_stop after the end adds nothing");
});

test("a late assistant line completes the calls, and a missing one falls back to the streamed input", () => {
  const late = new ClaudeMessageStream({ tools, summaryVisible: true });
  const order = [parallel[0], parallel[1], parallel[3], parallel[5], parallel[8], parallel[6], parallel[9]];
  const ends = order.map(message => late.accept(message).end);
  assert.deepEqual(ends.map(end => !!end), [false, false, false, false, false, true, false]);
  const fallback = new ClaudeMessageStream({ tools, summaryVisible: true });
  const missing = parallel.filter(message => !(message.type === "assistant" && (message as { message: { content: Array<{ id: string }> } }).message.content[0].id === "toolu_a"));
  const steps = missing.map(message => fallback.accept(message));
  const end = steps.find(step => step.end)!.end!;
  assert.equal(steps.at(-1)!.end, end, "the end waits for message_stop");
  assert.deepEqual(end.kind === "tool_use" && end.calls.map(call => call.function.arguments), ["{\"path\":\"a\"}", "{\"path\":\"b\"}"]);
});

test("a foreign tool fails at its content block start, before any input arrives", () => {
  const stream = new ClaudeMessageStream({ tools, summaryVisible: true });
  stream.accept(event(start));
  assert.throws(() => stream.accept(use(0, "toolu_x", "Bash")), (error: unknown) => error instanceof ProviderError && error.code === "invalid_tool_call" && error.upstream?.code === "native_builtin_tool");
  const other = new ClaudeMessageStream({ tools, summaryVisible: true }); other.accept(event(start));
  assert.throws(() => other.accept(use(0, "toolu_y", "private-caller-data")), (error: unknown) => error instanceof ProviderError && error.upstream?.code === "unknown_tool" && !error.message.includes("private"));
});

test("a text turn takes output tokens from message_delta, not the turn total in result.usage", () => {
  const stream = new ClaudeMessageStream({ tools: [], summaryVisible: false });
  const messages = [event({ type: "message_start", message: { id: "msg_t", usage: { input_tokens: 3, cache_read_input_tokens: 7, output_tokens: 2 } } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hidden" } }),
    event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hel" } }), event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } }),
    event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } }), event({ type: "message_stop" }),
    { type: "result", subtype: "success", is_error: false, result: "Hello!", usage: { input_tokens: 50, cache_read_input_tokens: 500, output_tokens: 999 } }];
  const steps = messages.map(message => stream.accept(message));
  assert.deepEqual(steps.flatMap(step => step.events), [{ type: "text", text: "Hel" }, { type: "text", text: "lo" }, { type: "text", text: "!" }], "hidden reasoning stays local");
  assert.deepEqual(steps.at(-1)!.end?.usage, { input_tokens: 10, output_tokens: 12, total_tokens: 22, input_tokens_details: { cached_tokens: 7 } });
  const bare = new ClaudeMessageStream({ tools: [], summaryVisible: true });
  assert.deepEqual(bare.accept({ type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 2, output_tokens: 1 } }).end?.usage,
    { input_tokens: 2, output_tokens: 1, total_tokens: 3, input_tokens_details: { cached_tokens: 0 } }, "without stream events the result usage is used");
  assert.throws(() => new ClaudeMessageStream({ tools: [], summaryVisible: true }).accept({ type: "result", subtype: "error_max_turns", is_error: true, result: "private" }), (error: unknown) => error instanceof ProviderError && error.upstream?.subtype === "error_max_turns");
});

// Observed with CLI 2.1.293: max_tokens hit after one complete call, in the middle of the next one.
const cut = [event(start), use(0, "toolu_a", alpha), assistant("toolu_a", alpha, { path: "a" }), event({ type: "content_block_stop", index: 0 }), use(1, "toolu_b", beta),
  delta("max_tokens", 300), event({ type: "message_stop" }), { type: "system", subtype: "task_summary" }];

test("a message cut short ends with only the calls the CLI runs, and without one the CLI recovers", () => {
  const stream = new ClaudeMessageStream({ tools, summaryVisible: true });
  const steps = cut.map(message => stream.accept(message));
  assert.deepEqual(steps.map(step => !!step.end), [false, false, false, false, false, true, false, false], "the end comes at message_delta");
  const end = steps[5].end!;
  assert.deepEqual(end.kind === "tool_use" && end.calls.map(call => [call.id, call.function.name, call.function.arguments]), [["toolu_a", "alpha", "{\"path\":\"a\"}"]]);
  assert.equal(end.tokens.output, 300);
  const late = new ClaudeMessageStream({ tools, summaryVisible: true });
  const order = [cut[0], cut[1], cut[4], cut[5], cut[2], cut[6]];
  assert.deepEqual(order.map(message => late.accept(message).end?.kind), [undefined, undefined, undefined, undefined, "tool_use", undefined], "a late assistant line ends at once");
  const partial = new ClaudeMessageStream({ tools, summaryVisible: true });
  const recovery = [event(start), use(0, "toolu_a", alpha), event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a\"}" } }),
    delta("max_tokens", 300), event({ type: "message_stop" }), event({ type: "message_start", message: { id: "msg_2", usage: { input_tokens: 4 } } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }), event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
    event({ type: "message_stop" }), { type: "result", subtype: "success", is_error: false, result: "ok" }];
  const ends = recovery.map(message => partial.accept(message).end);
  assert.deepEqual(ends.map(end => end?.kind), [...Array(9).fill(undefined), "result"], "an incomplete call is not forwarded");
  assert.equal(ends.at(-1)!.tokens.output, 3);
});

// A CLI that prints `lines` under the catalog's native names, then stays alive and silent; it ignores SIGTERM.
async function silentCli(lines: unknown[], after = (_directory: string) => "") {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-stream-"));
  const pidFile = join(directory, "pid");
  const script = `#!${process.execPath}\nimport {readFileSync,writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});for await(const _ of process.stdin){}writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
const args=process.argv.slice(2);const mcp=JSON.parse(readFileSync(args[args.indexOf('--mcp-config')+1],'utf8'));const names=JSON.parse(readFileSync(mcp.mcpServers.gateway.args[1],'utf8')).map(tool=>'mcp__gateway__'+tool.name);
const lines=${JSON.stringify(lines)}.map(line=>JSON.stringify(line).replaceAll(${JSON.stringify(alpha)},names[0]).replaceAll(${JSON.stringify(beta)},names[1]));
for(const line of lines)console.log(line);${after(directory)}setInterval(()=>{},1000);\n`;
  await writeFile(join(directory, "claude"), script); await chmod(join(directory, "claude"), 0o700);
  const previous = process.env.PATH; process.env.PATH = directory + delimiter + process.env.PATH;
  const infer = async (signal = new AbortController().signal) => {
    const adapter = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { alias: "fixture" } });
    const events: InferenceEvent[] = [];
    for await (const item of adapter.infer({ model: "fixture", input: "read both", tools: ["alpha", "beta"].map(name => ({ type: "function" as const, name, parameters: { type: "object", properties: { path: { type: "string" } } } })) }, signal)) events.push(item);
    return events;
  };
  return { directory, infer, pid: () => Number(readFileSync(pidFile, "utf8")),
    restore: async () => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; await rm(directory, { recursive: true, force: true }); } };
}

test("the provider forwards every parallel call and stops the CLI before it can post again", async () => {
  // Like the real CLI, the fixture would continue after message_stop; the marker shows whether it got that far.
  const f = await silentCli(parallel, directory => `setTimeout(()=>writeFileSync(${JSON.stringify(join(directory, "posted"))},'posted'),150);`);
  const posted = join(f.directory, "posted");
  configureTelemetry(f.directory, "test"); const since = Date.now();
  try {
    const events = await f.infer();
    assert.deepEqual(events.map(item => item.type === "tool" ? item.call.function.name : item.type), ["alpha", "beta", "done"]);
    assert.deepEqual(events.at(-1), { type: "done", usage: { input_tokens: 115, output_tokens: 64, total_tokens: 179, input_tokens_details: { cached_tokens: 100 } }, accounting: { cacheWriteTokens: 5 } });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(existsSync(posted), false, "the CLI was stopped at message_delta");
    assert.throws(() => process.kill(f.pid(), 0), { code: "ESRCH" });
    await flushTelemetry();
    const cli = (await readTelemetry(f.directory, since)).find(entry => entry.event === "claude_cli")!;
    assert.deepEqual({ mode: cli.mode, result: cli.result, toolCalls: cli.toolCalls, outputTokens: cli.outputTokens, cacheReadTokens: cli.cacheReadTokens, cacheWriteTokens: cli.cacheWriteTokens, inputTokens: cli.inputTokens, interrupted: cli.interrupted },
      { mode: "oneshot", result: "tool_use", toolCalls: 2, outputTokens: 64, cacheReadTokens: 100, cacheWriteTokens: 5, inputTokens: 10, interrupted: false });
  } finally { await f.restore(); }
});

test("a tool message cut short by max_tokens returns its complete call at once instead of waiting on the silent CLI", async () => {
  const f = await silentCli(cut);
  try {
    // Like the real CLI, the fixture then waits on the gateway MCP server forever; the abort only bounds a regression.
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 2000); const began = Date.now();
    const events = await f.infer(controller.signal).finally(() => clearTimeout(timer));
    assert.deepEqual(events.map(item => item.type === "tool" ? item.call.function.name : item.type), ["alpha", "done"]);
    assert.ok(Date.now() - began < 2000);
    // The fixture ignores SIGTERM, so only the SIGKILL can have stopped it.
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.throws(() => process.kill(f.pid(), 0), { code: "ESRCH" });
  } finally { await f.restore(); }
});

test("text that resumes after a tool call starts a new paragraph; adjacent text blocks join as they are", () => {
  const text = (index: number, value: string) => event({ type: "content_block_delta", index, delta: { type: "text_delta", text: value } });
  const stream = new ClaudeMessageStream({ tools, summaryVisible: true });
  const steps = [event(start), event({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }), text(1, "First I will read alpha."), text(2, " Cited."),
    use(3, "toolu_a", alpha), assistant("toolu_a", alpha, { path: "a" }), text(4, "Then beta."), use(5, "toolu_b", beta), assistant("toolu_b", beta, { path: "b" }), delta("tool_use", 64)]
    .map(message => stream.accept(message));
  assert.deepEqual(steps.flatMap(step => step.events).map(item => item.type === "text" ? item.text : item.type), ["First I will read alpha.", " Cited.", "\n\nThen beta."]);
  const end = steps.at(-1)!.end!; assert.deepEqual(end.kind === "tool_use" && end.calls.map(call => call.function.name), ["alpha", "beta"]);
  assert.equal(stream.text, "First I will read alpha. Cited.Then beta.", "the native text stays unchanged for the result check");
});
