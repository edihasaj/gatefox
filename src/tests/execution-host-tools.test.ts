import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExecutionTools } from "../execution-host-tools.js";
import type { ExecutionDescriptor } from "../execution-host-engine.js";

const descriptor = (): ExecutionDescriptor => ({
  revision: "a".repeat(64),
  args: ["app-server"],
  settings: { model: "preserved" },
  catalog: { models: [
    { slug: "missing", model: "kept" },
    { slug: "unknown", tool_mode: "future", instructions: "kept" },
    { slug: "direct", tool_mode: "direct", permissions: { allow: ["exec"] } },
  ] },
  aliases: ["missing", "unknown", "direct"],
  gatewaySdkSha256: "b".repeat(64),
});

test("an executable with Code Mode keeps an adapter descriptor byte-for-byte", () => {
  const input = descriptor();
  assert.equal(normalizeExecutionTools(input, true), input);
});

test("a host without Code Mode gives every row direct tools and has a stable replacement revision", () => {
  const input = descriptor(); const first = normalizeExecutionTools(input, false); const second = normalizeExecutionTools(input, false);
  assert.notEqual(first.revision, input.revision);
  assert.equal(first.revision, second.revision);
  assert.deepEqual(first.catalog.models, [
    { slug: "missing", model: "kept", tool_mode: "direct" },
    { slug: "unknown", tool_mode: "direct", instructions: "kept" },
    { slug: "direct", tool_mode: "direct", permissions: { allow: ["exec"] } },
  ]);
  assert.deepEqual(input, descriptor(), "normalization does not mutate the caller's catalog");
  assert.equal(normalizeExecutionTools({ ...input, catalog: { models: input.catalog.models.map(model => ({ ...model, tool_mode: "direct" })) } }, false).revision, input.revision);
});
