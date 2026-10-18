import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import {
  normalizeOptionalToolResponse,
  prepareOptionalToolArguments,
  SseResponseRewriter,
} from "../claude-desktop-optional-tools.mjs";

function toolSchema() {
  return {
    type: "object",
    properties: {
      optional: { type: "string" },
      model: { enum: ["haiku", "sonnet", "opus"] },
      explicitNullable: { type: ["string", "null"] },
      requiredValue: { type: "string" },
      nested: {
        type: "object",
        properties: { optionalLeaf: { type: "number" }, explicitLeaf: { type: "null" } },
      },
      rows: {
        type: "array",
        items: { type: "object", properties: { optionalColumn: { type: "boolean" }, requiredColumn: { type: "string" } },
          required: ["requiredColumn"] },
      },
      referenced: { $ref: "#/$defs/value" },
      composed: { anyOf: [{ type: "string" }, { type: "number" }] },
    },
    required: ["requiredValue"],
    $defs: { value: { type: "string" } },
  };
}

test("widens only optional plain properties and restores only introduced nulls", () => {
  const payload = { tools: [{ name: "call", input_schema: toolSchema() }] };
  const prepared = prepareOptionalToolArguments(payload);
  const schema = prepared.payload.tools[0].input_schema;
  assert.deepEqual(schema.properties.optional, { anyOf: [{ type: "string" }, { type: "null" }] });
  assert.deepEqual(schema.properties.model, { anyOf: [{ enum: ["haiku", "sonnet", "opus"] }, { type: "null" }] });
  assert.deepEqual(schema.properties.explicitNullable, { type: ["string", "null"] });
  assert.equal(schema.properties.referenced.$ref, "#/$defs/value");
  assert.deepEqual(schema.properties.composed, { anyOf: [{ type: "string" }, { type: "number" }] });
  assert.equal(schema.properties.nested.anyOf[0].properties.optionalLeaf.anyOf[1].type, "null");
  assert.equal(schema.properties.rows.anyOf[0].items.properties.optionalColumn.anyOf[1].type, "null");

  const response = normalizeOptionalToolResponse({
    content: [{ type: "tool_use", name: "call", input: {
      optional: null, model: null, explicitNullable: null, requiredValue: null,
      nested: { optionalLeaf: null, explicitLeaf: null },
      rows: [{ optionalColumn: null, requiredColumn: null }],
      referenced: null, composed: null,
    } }],
  }, prepared.plans);
  assert.deepEqual(response.content[0].input, {
    explicitNullable: null, requiredValue: null,
    nested: { explicitLeaf: null },
    rows: [{ requiredColumn: null }],
    referenced: null, composed: null,
  });

  const composedRoot = {
    tools: [{ name: "guarded", input_schema: {
      type: "object", properties: { count: { type: "integer" } },
      allOf: [{ required: ["count"] }],
    } }],
  };
  const untouched = prepareOptionalToolArguments(composedRoot);
  assert.equal(untouched.plans.size, 0);
  assert.equal(untouched.payload, composedRoot);
});

function event(type, value, index) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...(index === undefined ? {} : { index }), ...value })}\n\n`;
}

test("buffers fragmented tool JSON independently for concurrent content blocks", async () => {
  const prepared = prepareOptionalToolArguments({ tools: [{ name: "call", input_schema: toolSchema() }] });
  const stream = new SseResponseRewriter({
    upstreamModel: "upstream", exposedModel: "alias", plans: prepared.plans, observeModel: () => {},
  });
  let output = "";
  stream.on("data", (chunk) => { output += chunk; });
  stream.write(": ping\n\n");
  stream.write(event("content_block_start", { content_block: { type: "tool_use", name: "call", input: {} } }, 0));
  stream.write(event("content_block_delta", { delta: { type: "input_json_delta", partial_json: "{\"optional\":n" } }, 0));
  stream.write(event("content_block_start", { content_block: { type: "tool_use", name: "call", input: {} } }, 1));
  stream.write(event("content_block_delta", { delta: { type: "input_json_delta", partial_json: "{\"nested\":{\"optionalLeaf\":null},\"requiredValue\":null}" } }, 1));
  stream.write(event("content_block_delta", { delta: { type: "input_json_delta", partial_json: "ull,\"requiredValue\":null}" } }, 0));
  stream.write(event("content_block_stop", {}, 1));
  stream.end(event("content_block_stop", {}, 0));
  await once(stream, "end");

  assert.match(output, /^: ping\n\n/);
  assert.equal((output.match(/"partial_json"/g) ?? []).length, 2);
  const deltas = [...output.matchAll(/data: (\{"type":"content_block_delta".*?\})\n\n/g)]
    .map((match) => JSON.parse(match[1]));
  assert.deepEqual(JSON.parse(deltas.find((delta) => delta.index === 0).delta.partial_json), { requiredValue: null });
  assert.deepEqual(JSON.parse(deltas.find((delta) => delta.index === 1).delta.partial_json), {
    nested: {}, requiredValue: null,
  });
});
