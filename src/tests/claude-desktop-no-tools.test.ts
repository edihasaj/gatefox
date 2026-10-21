import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { noToolsOutputRecoveryRequest, relayNoToolsOutput, type NoToolsOutputRecovery } from "../claude-desktop-no-tools.js";
import type { QwenTokenizer } from "../claude-desktop-tokenizer.js";

const model = "qwen3.8-flash-next";
const prompt = [248045, 74455, 198, 248068, 198];
const eos = 248044;
const encoder = new TextEncoder();

const codec: QwenTokenizer = {
  model,
  revision: "fc694b54fb0174e0913e6adf86691ef85a4ead47",
  digest: "0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3",
  endThinkId: 248069,
  thinkStartId: 248068,
  eosIds: [248044, 248046],
  imStartId: 248045,
  decode(ids) {
    const labels = new Map<number, string>([
      [248045, "<|im_start|>"], [74455, "assistant"], [198, "\n"], [248068, "<think>"], [271, "\n\n"],
      [248069, "</think>"], [1, "private"], [2, "\n<tool_call><name>ë</name></tool_call>  "], [3, "   "],
    ]);
    const value = ids.map(id => labels.get(id)).join("");
    if (value.length !== ids.length && ids.some(id => !labels.has(id))) throw new Error("unknown fixture token");
    return value;
  },
  getAddedTokenLabel(id) {
    return id === 248069 ? "</think>" : undefined;
  },
};

function recovery(restored: Array<{ outputTokens: number; recoveredBytes: number }>): NoToolsOutputRecovery {
  return { model, codec, onRestored: event => restored.push(event) };
}

async function relayFixture(recoveryConfig: NoToolsOutputRecovery) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const abortController = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const server = createServer(async (_request, response) => {
    entered();
    await relayNoToolsOutput(response, new Response(stream), abortController.signal, recoveryConfig, {
      "content-type": "text/event-stream",
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    started,
    send(value: unknown | "[DONE]") {
      controller.enqueue(encoder.encode(value === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(value)}\n\n`));
    },
    raw(value: string) { controller.enqueue(encoder.encode(value)); },
    close() { controller.close(); },
    abort() { abortController.abort(); },
    response: () => fetch(url),
    async stop() {
      controller.error();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

const choice = (delta: Record<string, unknown>, finish_reason: string | null, token_ids: number[]) => ({
  model, choices: [{ index: 0, delta, finish_reason, token_ids }],
});

test("restores an exact XML and Unicode suffix after final reasoning, while removing raw metadata", async () => {
  const restored: Array<{ outputTokens: number; recoveredBytes: number }> = [];
  const fixture = await relayFixture(recovery(restored));
  try {
    const clientPromise = fixture.response();
    await fixture.started;
    fixture.send({
      model, prompt_token_ids: prompt,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    });
    fixture.send({
      ...choice({ reasoning_content: "private" }, null, [1]),
      prompt_text: "private prompt",
    });
    const client = await clientPromise;
    const reader = client.body!.getReader();
    let wire = "";
    for (;;) {
      const next = await reader.read();
      assert.equal(next.done, false);
      wire += new TextDecoder().decode(next.value);
      if (wire.includes('"reasoning_content":"private"')) break;
    }
    assert.doesNotMatch(wire, /\[DONE\]/);
    fixture.send({
      ...choice({ reasoning_content: "final thought" }, "stop", [248069, 2, eos]),
      usage: { prompt_tokens: prompt.length, completion_tokens: 4, total_tokens: 9 },
    });
    fixture.send("[DONE]");
    fixture.close();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      wire += new TextDecoder().decode(next.value);
    }
    assert.equal((wire.match(/prompt_token_ids|prompt_text|token_ids/g) || []).length, 0);
    assert.equal((wire.match(/\[DONE\]/g) || []).length, 1);
    const events = [...wire.matchAll(/^data: (.+)$/gm)].map(match => match[1] === "[DONE]" ? match[1] : JSON.parse(match[1]!));
    assert.deepEqual(events.filter(event => event !== "[DONE]" && event.usage).map(event => event.usage), [
      { prompt_tokens: prompt.length, completion_tokens: 4, total_tokens: 9 },
    ]);
    const text = events.filter(event => event !== "[DONE]").flatMap(event => event.choices)
      .map(choiceEvent => choiceEvent.delta?.content).filter((value): value is string => typeof value === "string" && value.length > 0);
    assert.deepEqual(text, ["\n<tool_call><name>ë</name></tool_call>  "]);
    const reasoning = events.filter(event => event !== "[DONE]").flatMap(event => event.choices)
      .map(choiceEvent => choiceEvent.delta?.reasoning_content).filter(Boolean);
    assert.deepEqual(reasoning, ["private", "final thought"]);
    assert.deepEqual(restored, [{ outputTokens: 4, recoveredBytes: Buffer.byteLength(text[0]!) }]);
  } finally { await fixture.stop(); }
});

test("visible whitespace is relayed before upstream EOF and is never duplicated", async () => {
  const restored: Array<{ outputTokens: number; recoveredBytes: number }> = [];
  const fixture = await relayFixture(recovery(restored));
  try {
    const clientPromise = fixture.response();
    await fixture.started;
    fixture.send({ ...choice({ content: " " }, null, [1]), prompt_token_ids: prompt });
    const client = await clientPromise;
    const reader = client.body!.getReader();
    const first = await reader.read();
    const beforeEOF = new TextDecoder().decode(first.value);
    assert.match(beforeEOF, /"content":" "/);
    fixture.send(choice({}, "stop", [eos]));
    fixture.send("[DONE]");
    fixture.close();
    let wire = beforeEOF;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      wire += new TextDecoder().decode(next.value);
    }
    assert.equal((wire.match(/"content":" "/g) || []).length, 1);
    assert.equal((wire.match(/\[DONE\]/g) || []).length, 1);
    assert.deepEqual(restored, []);
  } finally { await fixture.stop(); }
});

test("only exact no-tools requests gain token diagnostics", () => {
  const eligible = Buffer.from(JSON.stringify({ model, stream: true, stream_options: { include_usage: true } }));
  const rewritten = noToolsOutputRecoveryRequest(eligible, recovery([]))!;
  assert.deepEqual(JSON.parse(rewritten.toString("utf8")), {
    model, stream: true, stream_options: { include_usage: true }, return_token_ids: true,
  });
  for (const body of [
    { model, stream: true, tools: [{ type: "function" }] },
    { model, stream: true, tool_choice: "auto" },
    { model, stream: true, stop: [""] },
    { model, stream: true, return_token_ids: true },
    { model, stream: true, stream_options: [] },
  ]) {
    const bytes = Buffer.from(JSON.stringify(body));
    assert.equal(noToolsOutputRecoveryRequest(bytes, recovery([])), undefined);
  }
});

async function cleanWire(frames: Array<unknown | "[DONE]">): Promise<{ wire: string; restored: Array<{ outputTokens: number; recoveredBytes: number }> }> {
  const restored: Array<{ outputTokens: number; recoveredBytes: number }> = [];
  const fixture = await relayFixture(recovery(restored));
  try {
    const clientPromise = fixture.response();
    await fixture.started;
    for (const frame of frames) fixture.send(frame);
    fixture.close();
    return { wire: await (await clientPromise).text(), restored };
  } finally { await fixture.stop(); }
}

test("invalid literal proofs remain an empty terminal and never inject text", async () => {
  const role = { model, prompt_token_ids: prompt, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] };
  const cases: Array<{ name: string; frames: Array<unknown | "[DONE]"> }> = [
    {
      name: "whitespace suffix",
      frames: [role, choice({ reasoning_content: "private" }, null, [1]), {
        ...choice({}, "stop", [248069, 3, eos]), usage: { prompt_tokens: prompt.length, completion_tokens: 4 },
      }, "[DONE]"],
    },
    {
      name: "missing thought marker",
      frames: [role, choice({ reasoning_content: "private" }, null, [1]), {
        ...choice({}, "stop", [2, eos]), usage: { prompt_tokens: prompt.length, completion_tokens: 3 },
      }, "[DONE]"],
    },
    {
      name: "multiple thought markers",
      frames: [role, choice({ reasoning_content: "private" }, null, [1]), {
        ...choice({}, "stop", [248069, 248069, 2, eos]), usage: { prompt_tokens: prompt.length, completion_tokens: 5 },
      }, "[DONE]"],
    },
    {
      name: "mismatched usage",
      frames: [role, choice({ reasoning_content: "private" }, null, [1]), {
        ...choice({}, "stop", [248069, 2, eos]), usage: { prompt_tokens: prompt.length, completion_tokens: 3 },
      }, "[DONE]"],
    },
    {
      name: "missing usage",
      frames: [role, choice({ reasoning_content: "private" }, null, [1]), choice({}, "stop", [248069, 2, eos]), "[DONE]"],
    },
    {
      name: "malformed later usage",
      frames: [role, choice({ reasoning_content: "private" }, null, [1]), {
        ...choice({}, "stop", [248069, 2, eos]), usage: { prompt_tokens: prompt.length, completion_tokens: 4 },
      }, { model, choices: [], usage: { prompt_tokens: "bad", completion_tokens: 4 } }, "[DONE]"],
    },
    {
      name: "missing EOS",
      frames: [role, choice({ reasoning_content: "private" }, null, [1]), {
        ...choice({}, "stop", [248069, 2]), usage: { prompt_tokens: prompt.length, completion_tokens: 3 },
      }, "[DONE]"],
    },
    {
      name: "duplicate EOS",
      frames: [role, choice({ reasoning_content: "private" }, null, [1]), {
        ...choice({}, "stop", [248069, 2, eos, eos]), usage: { prompt_tokens: prompt.length, completion_tokens: 5 },
      }, "[DONE]"],
    },
    {
      name: "decoder failure",
      frames: [role, choice({ reasoning_content: "private" }, null, [1]), {
        ...choice({}, "stop", [248069, 9, eos]), usage: { prompt_tokens: prompt.length, completion_tokens: 4 },
      }, "[DONE]"],
    },
    {
      name: "error object",
      frames: [{ ...role, object: "error" }, choice({ reasoning_content: "private" }, null, [1]), {
        ...choice({}, "stop", [248069, 2, eos]), usage: { prompt_tokens: prompt.length, completion_tokens: 4 },
      }, "[DONE]"],
    },
    {
      name: "duplicate choice",
      frames: [{
        model, prompt_token_ids: prompt, choices: [
          { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
          { index: 0, delta: {}, finish_reason: null, token_ids: [] },
        ],
      }, { ...choice({}, "stop", [248069, 2, eos]), usage: { prompt_tokens: prompt.length, completion_tokens: 3 } }, "[DONE]"],
    },
    {
      name: "late reasoning after stop",
      frames: [role, choice({ reasoning_content: "private" }, null, [1]), choice({}, "stop", [248069, 2, eos]),
        { ...choice({ reasoning_content: "late" }, null, []), usage: { prompt_tokens: prompt.length, completion_tokens: 4 } }, "[DONE]"],
    },
    {
      name: "raw IDs after stop",
      frames: [role, choice({}, "stop", []), {
        ...choice({}, null, [248069, 2, eos]), usage: { prompt_tokens: prompt.length, completion_tokens: 3 },
      }, "[DONE]"],
    },
  ];
  for (const item of cases) {
    const result = await cleanWire(item.frames);
    assert.equal(result.restored.length, 0, item.name);
    assert.equal((result.wire.match(/"content":"\\n<tool_call>/g) || []).length, 0, item.name);
    assert.equal((result.wire.match(/\[DONE\]/g) || []).length, 1, item.name);
  }
});

test("a closed thinking prompt restores the whole literal suffix without another marker", async () => {
  const closed = [248045, 74455, 198, 248068, 271, 248069, 271];
  const result = await cleanWire([
    { model, prompt_token_ids: closed, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { ...choice({}, "stop", [2, eos]), usage: { prompt_tokens: closed.length, completion_tokens: 2 } },
    "[DONE]",
  ]);
  assert.deepEqual(result.restored, [{ outputTokens: 2, recoveredBytes: Buffer.byteLength("\n<tool_call><name>ë</name></tool_call>  ") }]);
  assert.match(result.wire, /"content":"\\n<tool_call><name>ë<\/name><\/tool_call>  "/);
});

test("comments never expose diagnostic metadata and a visible terminal does not wait for EOF", async () => {
  const restored: Array<{ outputTokens: number; recoveredBytes: number }> = [];
  const fixture = await relayFixture(recovery(restored));
  try {
    const clientPromise = fixture.response();
    await fixture.started;
    fixture.raw(": prompt_token_ids token_ids prompt_text\n\n");
    fixture.send({ ...choice({ content: "visible" }, null, [1]), prompt_token_ids: prompt });
    fixture.send(choice({}, "stop", [eos]));
    fixture.send("[DONE]");
    const wire = await (await clientPromise).text();
    assert.match(wire, /"content":"visible"/);
    assert.doesNotMatch(wire, /prompt_token_ids|prompt_text|token_ids/);
    assert.match(wire, /\[DONE\]/);
    assert.deepEqual(restored, []);
  } finally { await fixture.stop(); }
});

test("cancellation retains forwarded usage and cannot report a restored answer", async () => {
  const restored: Array<{ outputTokens: number; recoveredBytes: number }> = [];
  const fixture = await relayFixture(recovery(restored));
  try {
    const clientPromise = fixture.response();
    await fixture.started;
    fixture.send({
      model, prompt_token_ids: prompt, usage: { prompt_tokens: prompt.length, completion_tokens: 1 },
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    });
    const client = await clientPromise;
    const reader = client.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /"prompt_tokens":5/);
    fixture.abort();
    await assert.rejects(reader.read());
    assert.deepEqual(restored, []);
  } finally { await fixture.stop(); }
});

test("the post-DONE deadline is absolute even when a comment arrives ready", async () => {
  const restored: Array<{ outputTokens: number; recoveredBytes: number }> = [];
  const fixture = await relayFixture(recovery(restored));
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const clientPromise = fixture.response();
    await fixture.started;
    fixture.send({ model, prompt_token_ids: prompt, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    fixture.send(choice({ reasoning_content: "private" }, null, [1]));
    fixture.send({ ...choice({}, "stop", [248069, 2, eos]), usage: { prompt_tokens: prompt.length, completion_tokens: 4 } });
    fixture.send("[DONE]");
    const client = await clientPromise;
    const reader = client.body!.getReader();
    await reader.read(); // Prompt usage is deliberately forwarded before terminal proof.
    now += 5001;
    fixture.raw(": ready after deadline\n\n");
    await assert.rejects(reader.read());
    assert.deepEqual(restored, []);
  } finally {
    Date.now = originalNow;
    await fixture.stop();
  }
});

test("zero-visible invalid metadata cannot send DONE without bounded clean EOF", async () => {
  const restored: Array<{ outputTokens: number; recoveredBytes: number }> = [];
  const fixture = await relayFixture(recovery(restored));
  const originalNow = Date.now;
  let now = 20_000;
  Date.now = () => now;
  try {
    const clientPromise = fixture.response();
    await fixture.started;
    fixture.send({
      model, prompt_token_ids: prompt,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null, token_ids: "invalid" }],
    });
    fixture.send(choice({}, "stop", [248069, 2, eos]));
    fixture.send("[DONE]");
    const client = await clientPromise;
    const reader = client.body!.getReader();
    const first = await reader.read();
    assert.doesNotMatch(new TextDecoder().decode(first.value), /\[DONE\]/);
    now += 5001;
    fixture.raw(": ready after deadline\n\n");
    await assert.rejects(reader.read());
    assert.deepEqual(restored, []);
  } finally {
    Date.now = originalNow;
    await fixture.stop();
  }
});

test("duplicate completion markers do not promote or fabricate a clean terminal", async () => {
  const restored: Array<{ outputTokens: number; recoveredBytes: number }> = [];
  const fixture = await relayFixture(recovery(restored));
  try {
    const clientPromise = fixture.response();
    await fixture.started;
    fixture.send({ ...choice({ reasoning_content: "private" }, null, [1]), prompt_token_ids: prompt });
    fixture.send({ ...choice({}, "stop", [248069, 2, eos]), usage: { prompt_tokens: prompt.length, completion_tokens: 4 } });
    fixture.send("[DONE]");
    fixture.send("[DONE]");
    fixture.close();
    await assert.rejects(clientPromise);
    assert.deepEqual(restored, []);
  } finally { await fixture.stop(); }
});
