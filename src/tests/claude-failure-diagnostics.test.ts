import test from "node:test";
import assert from "node:assert/strict";
import { providerFailureDiagnostic } from "../provider-failure.js";
import { ProviderError } from "../providers/provider.js";
import { telemetryFields } from "../telemetry.js";

const diagnose = (upstream: NonNullable<ProviderError["upstream"]>) =>
  providerFailureDiagnostic({ requestId: "invalid", durationMs: 1, failure: new ProviderError("authentication", "private diagnostic", 401, upstream) });

test("Claude credential diagnostics preserve only fixed reasons on native authentication failures", () => {
  for (const reason of ["login_unavailable", "session_expired", "credential_revoked", "upstream_rejected", "unknown"] as const) {
    for (const event of ["claude.assistant", "claude.result"]) {
      const fields = diagnose({ code: "authentication_failed", event, reason });
      assert.equal(fields.upstreamReason, reason);
      assert.equal(telemetryFields(fields).upstreamReason, reason);
      assert.ok(!JSON.stringify(fields).includes("private diagnostic"));
    }
  }
});

test("Claude credential diagnostics reject unrelated, arbitrary, inherited and unreadable reasons", () => {
  let reads = 0;
  const read = () => { reads++; throw Error("private diagnostic"); };
  const valid = { code: "authentication_failed", event: "claude.assistant" };
  for (const upstream of [
    { ...valid, reason: "private diagnostic" },
    { ...valid, reason: { toString: read, toJSON: read } },
    { ...valid, code: "billing_error", reason: "upstream_rejected" },
    { ...valid, event: "response.failed", reason: "upstream_rejected" },
    Object.assign(Object.create({ reason: "upstream_rejected" }), valid),
    Object.defineProperty({ ...valid }, "reason", { get: read }),
  ]) {
    const fields = diagnose(upstream as NonNullable<ProviderError["upstream"]>);
    assert.equal(fields.upstreamReason, undefined);
    assert.ok(!JSON.stringify(fields).includes("private diagnostic"));
  }
  assert.equal(reads, 0);
});
