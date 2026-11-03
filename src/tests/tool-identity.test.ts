import test from "node:test";
import assert from "node:assert/strict";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ProviderError } from "../providers/provider.js";
import { toolIdentityFailure, toolIdentityReasons } from "../providers/tool-identity.js";
import { responsesFunctionTools } from "../providers/responses-function-tools.js";
import { providerFailureDiagnostic, providerFailureStatus, streamFailureCode } from "../provider-failure.js";

const secret = "private-tool-name-and-argument";

test("identity failures retain separate diagnostic reasons, refuse retries, and never expose private tool data", () => {
  for (const reason of toolIdentityReasons) {
    const failure = toolIdentityFailure(reason);
    const diagnostic = providerFailureDiagnostic({ requestId: "fixture", durationMs: 1, failure });
    assert.equal(failure.code, "tool_identity_failure");
    assert.equal(diagnostic.code, "tool_identity_failure");
    assert.equal(diagnostic.upstreamCode, reason);
    assert.equal(diagnostic.status, 502);
    assert.equal(providerFailureStatus(failure), 400);
    assert.equal(streamFailureCode(failure), "invalid_prompt");
    assert.match(failure.message, /^Provider tool identity failure:/);
    assert.ok(!JSON.stringify({ diagnostic, message: failure.message }).includes(secret));
  }
  const unknown = providerFailureDiagnostic({ requestId: "fixture", durationMs: 1,
    failure: new ProviderError("tool_identity_failure", secret, 502, { code: secret }) });
  assert.equal(unknown.upstreamCode, undefined);
  assert.ok(!JSON.stringify(unknown).includes(secret));
});

test("function bridge distinguishes absent names, unexpected namespaces and unknown wire names", () => {
  const bridge = responsesFunctionTools({ model: "fixture", input: "go", tools: [{ type: "function", name: "inspect" }] }, "or");
  const name = (bridge.body.tools![0] as { name: string }).name;
  for (const [item, reason] of [
    [{ type: "function_call" }, "missing_tool_name"],
    [{ type: "function_call", name: "" }, "missing_tool_name"],
    [{ type: "function_call", name, namespace: secret }, "unexpected_tool_namespace"],
    [{ type: "function_call", name: secret }, "unknown_wire_tool"],
  ] as const) assert.throws(() => bridge.restoreItem(item), error => error instanceof ProviderError && error.code === "tool_identity_failure" && error.upstream?.code === reason && !error.message.includes(secret));
  assert.equal(bridge.restoreItem({ type: "function_call", name }).name, "inspect");
});

test("Responses identity refusal records the actual stream boundary and dispatches no tool or retry", async t => {
  const key = "GATEWAY_TOOL_IDENTITY_FIXTURE", before = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  for (const baseUrl of ["https://openrouter.ai/api/v1", "https://example.invalid/v1"]) {
    let requests = 0, dispatched = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      return new Response('data: ' + JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", call_id: "call", name: secret, arguments: JSON.stringify({ input: secret }), status: "completed" } }) + '\n\n');
    });
    try {
      for await (const event of new ResponsesAPI({ id: "fixture", type: "responses-api", baseUrl, apiKeyEnv: key, models: { fixture: "fixture" } }).infer(
        { model: "fixture", input: "go", tools: [{ type: "function", name: "inspect" }] }, new AbortController().signal)) if (event.type === "tool") dispatched++;
      assert.fail("undeclared tool must fail");
    } catch (error) {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "tool_identity_failure");
      assert.equal(error.upstream?.code, baseUrl.includes("openrouter") ? "unknown_wire_tool" : "undeclared_tool");
      const diagnostic = providerFailureDiagnostic({ requestId: "fixture", durationMs: 1, failure: error });
      assert.equal(diagnostic.upstreamLastEvent, "response.output_item.done");
      assert.equal(diagnostic.upstreamEvents, 1);
      assert.ok(!JSON.stringify({ diagnostic, message: error.message }).includes(secret));
    }
    assert.equal(dispatched, 0); assert.equal(requests, 1);
  }
});
