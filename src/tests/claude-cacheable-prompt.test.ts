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
