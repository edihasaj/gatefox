import test from "node:test";
import assert from "node:assert/strict";
import { responsesHttpError, responsesStreamError } from "../providers/responses-errors.js";
import { providerFailureDiagnostic, streamFailureCode } from "../provider-failure.js";

const capability = "subscription_sharing_unsupported_capability";
const privateMessage = "private caller data must never escape";
const http = (error: Record<string, unknown>, status = 400) => responsesHttpError(new Response(JSON.stringify({ error: { message: privateMessage, ...error } }), {
  status, headers: { "x-request-id": "req_fixture", "retry-after": "2" },
}));

test("unsupported subscription capabilities are explicit final refusals in HTTP and streams", async () => {
  const errors = [await http({ code: capability, type: "invalid_request_error" }),
    await http({ code: "invalid_request_error", type: capability }),
    responsesStreamError({ type: "response.failed", response: { error: { code: capability, message: privateMessage } } }),
    responsesStreamError({ type: "error", error: { code: "invalid_request_error", type: capability, message: privateMessage } })];
  for (const failure of errors) {
    assert.equal(failure.code, "upstream_rejected"); assert.equal(failure.status, 400);
    assert.equal(failure.upstream?.code, capability);
    assert.equal(streamFailureCode(failure), "invalid_prompt", "Codex must not repeat an unsupported capability request");
    assert.match(failure.message, /subscription-sharing endpoint.*capability/);
    assert.ok(!JSON.stringify(failure).includes(privateMessage));
    const diagnostic = providerFailureDiagnostic({ requestId: "fixture", durationMs: 1, failure });
    assert.equal(diagnostic.upstreamCode, capability);
    assert.ok(!JSON.stringify(diagnostic).includes(privateMessage));
  }
});

test("a generic code does not hide a policy refusal in error.type", async () => {
  for (const type of ["cyber_policy", "bio_policy", "misalignment_policy_violation", "usage_not_included"]) {
    for (const failure of [await http({ code: "invalid_request_error", type }),
      responsesStreamError({ type: "response.failed", response: { error: { code: "invalid_request_error", type, message: privateMessage } } }),
      responsesStreamError({ type: "error", error: { code: "invalid_request_error", type, message: privateMessage } })]) {
      assert.equal(failure.code, "upstream_rejected"); assert.equal(failure.upstream?.code, type);
      assert.equal(streamFailureCode(failure), type);
      assert.ok(!JSON.stringify(failure).includes(privateMessage));
    }
  }
});

test("HTTP quota diagnostics keep the fixed quota class without conflating throttles or native usage", async () => {
  const code = "subscription_sharing_usage_limit_exceeded";
  for (const detail of [{ code, type: "invalid_request_error" }, { code: "rate_limit_exceeded", type: code }]) {
    const failure = await http(detail, 429);
    assert.equal(failure.code, "usage_limit"); assert.equal(streamFailureCode(failure), "invalid_prompt");
    assert.deepEqual(failure.upstream, { code, event: "http", httpStatus: 429, requestId: "req_fixture" });
    assert.match(failure.message, /gateway subscription sharing/);
    assert.ok(!JSON.stringify(failure).includes(privateMessage));
  }
  const throttle = await http({ type: "rate_limit_error" }, 429);
  assert.equal(throttle.code, "rate_limit_exceeded"); assert.equal(streamFailureCode(throttle), "rate_limit_exceeded");
  assert.equal(throttle.upstream?.retryAfterMs, 2000);
  for (const status of [401, 403]) assert.equal((await http({ type: capability }, status)).code, "authentication");
  const capacity = await http({ type: capability }, 503);
  assert.equal(capacity.code, "upstream_unavailable");
  const unknown = await responsesHttpError(new Response(JSON.stringify({ error: { code: privateMessage, type: privateMessage } }), { status: 429 }));
  assert.equal(unknown.upstream?.code, "unknown"); assert.ok(!JSON.stringify(unknown).includes(privateMessage));
});
