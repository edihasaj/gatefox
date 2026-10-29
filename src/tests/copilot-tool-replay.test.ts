import test from "node:test";
import assert from "node:assert/strict";
import { copilotRun } from "../providers/copilot.js";
import { copilotPrompts } from "../providers/copilot-render.js";
import type { ProviderConfig } from "../config.js";
import type { ResponsesInputItem, ResponsesRequest } from "../protocol/types.js";
import { adapter, harness, lookupName, outputFor, turn, user } from "./copilot-live-harness.js";

const config: ProviderConfig = { id: "replay", type: "copilot-subscription", models: { fixture: "fixture" } };

test("Copilot renders historical function and custom calls with their declared native names without changing caller history", async () => {
  const request: ResponsesRequest = {
    model: "fixture",
    tools: [{ type: "namespace", name: "tools", tools: [
      { type: "function", name: "read", parameters: { type: "object", properties: {} } },
      { type: "custom", name: "patch" },
    ] }],
    input: [user("begin"),
      { type: "function_call", namespace: "tools", name: "read", call_id: "read-1", arguments: '{"path":"unchanged"}' },
      { type: "function_call_output", call_id: "read-1", output: "unchanged result" },
      { type: "custom_tool_call", namespace: "tools", name: "patch", call_id: "patch-1", input: "exact\npatch\n" },
      { type: "custom_tool_call_output", call_id: "patch-1", output: "done" },
      user("continue")],
  };
  const before = structuredClone(request);
  const run = copilotRun(config, request, new AbortController().signal);
  const canonical = structuredClone(run.conversation);
  const render = (from: number) => copilotPrompts(run.conversation, run.images, from, undefined, "/unused", run.native);
  const prompts = await render(0);
  const read = run.native.find(entry => entry.tool.function.name === "tools.read")!.name;
  const patch = run.native.find(entry => entry.tool.function.name === "tools.patch")!.name;
  assert.equal(prompts[1].prompt, `<<item 2 tool_call ${read} read-1>>\n{"path":"unchanged"}\n<</item>>`);
  assert.equal(prompts[3].prompt, `<<item 4 tool_call ${patch} patch-1>>\nexact\npatch\n\n<</item>>`);
  assert.equal(prompts[2].prompt, "<<item 3 tool_result read-1>>\nunchanged result\n<</item>>");
  assert.deepEqual(await render(3), prompts.slice(3), "a continuation renders the same names as a seed");
  assert.deepEqual(run.conversation, canonical, "the live ledger retains caller identities");
  assert.deepEqual(request, before, "caller arguments, results and tool identities remain unchanged");
});

test("Copilot replay does not guess ambiguous local names or turn unavailable historical tools into current tools", async () => {
  const request: ResponsesRequest = { model: "fixture", tools: ["a", "b"].map(name => ({ type: "namespace", name,
    tools: [{ type: "function", name: "read", parameters: { type: "object", properties: {} } }] })),
    input: ["read", "retired", "b.read"].map((name, index) => ({ type: "function_call", name, call_id: `call-${index}`, arguments: "{}" })) };
  const run = copilotRun(config, request, new AbortController().signal);
  const prompts = await copilotPrompts(run.conversation, [], 0, undefined, "/unused", run.native);
  assert.match(prompts[0].prompt, /tool_call read call-0/);
  assert.match(prompts[1].prompt, /tool_call retired call-1/);
  assert.ok(prompts[2].prompt.includes(`tool_call ${run.native.find(entry => entry.tool.function.name === "b.read")!.name} call-2`));
});

for (const mode of ["live", "oneshot"] as const) test(`Copilot ${mode} seeds replayed calls consistently and returns caller identities through the tool loop`, { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const input: ResponsesInputItem[] = [user("earlier"),
      { type: "function_call", name: "lookup", call_id: "previous", arguments: '{"id":"earlier"}' },
      { type: "function_call_output", call_id: "previous", output: "earlier result" }, user("again [tool]")];
    const before = structuredClone(input);
    const provider = adapter({ mode });
    const first = await turn(provider, input);
    const call = first.output.find(item => item.type === "function_call");
    assert.ok(call && "name" in call && "call_id" in call);
    assert.equal(call.name, "lookup");
    const second = await turn(provider, [...input, ...first.output, ...outputFor(first.output, "done")]);
    assert.match(second.text, /^answer/);
    const sends = (await h.log()).filter(entry => entry.op === "session.sendMessages");
    assert.equal(sends[0].prompts[1], `<<item 2 tool_call ${lookupName} previous>>\n{"id":"earlier"}\n<</item>>`);
    if (mode === "live") {
      assert.equal(sends.length, 1, "the caller's replay still matches the live ledger");
      assert.equal((await h.log()).filter(entry => entry.op === "deliver").length, 1);
      assert.ok((await h.sessions()).some(entry => entry.outcome === "continued"));
    } else assert.ok(sends[1].prompts.some((prompt: string) => prompt.includes(`tool_call ${lookupName} ${call?.call_id}`)));
    assert.deepEqual(input, before);
  } finally { await h.restore(); }
});
