import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ClaudeSubscription } from "../providers/claude.js";
import type { InferenceEvent, ResponsesInputItem } from "../protocol/types.js";

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
    assert.deepEqual(events.at(-1), { type: "done", usage: { input_tokens: 42, output_tokens: 1, total_tokens: 43, input_tokens_details: { cached_tokens: 40 } } });
    // The fixture never calls the required tool; only the prompt it received matters here.
    await assert.rejects(drain(adapter.infer({ model: "fixture", input: second, tools, tool_choice: "required" }, new AbortController().signal)), { code: "invalid_tool_call" });
    const [a, b] = (await readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line).message.content as Array<{ type: string; text?: string }>);
    assert.ok(b.length > a.length);
    assert.deepEqual(b.slice(0, a.length), a, "every block of the shorter request is unchanged and in place");
    assert.ok(b.at(-1)?.text?.includes("required"), "per-request instructions follow the history");
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
