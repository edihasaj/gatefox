import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ResponsesAPI } from "../providers/responses-api.js";
import type { InferenceEvent } from "../protocol/types.js";

test("local summary none omits the unsupported upstream value and hides summaries without losing opaque state", async () => {
  const key = "GATEWAY_TEST_SUMMARY_KEY"; const previous = process.env[key]; process.env[key] = "fixture-only";
  const requests: Array<Record<string, unknown>> = [];
  const upstream = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [
      { type: "response.reasoning_summary_text.delta", delta: "public summary", item_id: "r1" },
      { type: "response.output_item.done", item: { type: "reasoning", id: "r1", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "public summary" }] } },
      { type: "response.output_text.delta", delta: "answer" },
      { type: "response.completed", response: { status: "completed" } },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const provider = new ResponsesAPI({ id: "test", type: "responses-api", apiKeyEnv: key, models: { test: "test" }, baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` });
  try {
    const hidden: InferenceEvent[] = [];
    for await (const event of provider.infer({ model: "test", input: "hello", reasoning: { effort: "low", summary: "none" } }, new AbortController().signal)) hidden.push(event);
    assert.deepEqual(requests[0].reasoning, { effort: "low" });
    assert.equal(hidden.some(event => event.type === "reasoning"), false);
    assert.deepEqual(hidden.find(event => event.type === "reasoning-state")?.item, { type: "reasoning", id: "r1", encrypted_content: "opaque", summary: [] });
    const visible: InferenceEvent[] = [];
    for await (const event of provider.infer({ model: "test", input: "hello", reasoning: { summary: "auto" } }, new AbortController().signal)) visible.push(event);
    assert.deepEqual(requests[1].reasoning, { summary: "auto" }); assert.equal(visible.some(event => event.type === "reasoning"), true);
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
