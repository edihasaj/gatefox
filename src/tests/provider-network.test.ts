import test from "node:test";
import assert from "node:assert/strict";
import { classifyNetworkFailure } from "../provider-network.js";
import { providerFailureDiagnostic } from "../provider-failure.js";
import { ProviderError } from "../providers/provider.js";

const failure = (code: string) => Object.assign(new Error("private network detail"), { code });

test("allowlists transient network codes while permanent, abort, aggregate and hostile values veto recovery", () => {
  for (const code of ["ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]) {
    assert.deepEqual(classifyNetworkFailure({ cause: failure(code) }), { kind: "transient", code });
  }
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]) {
    assert.deepEqual(classifyNetworkFailure(failure(code)), { kind: "diagnostic", code });
  }
  assert.equal(classifyNetworkFailure(new AggregateError([failure("ECONNRESET"), failure("ENOTFOUND")])).kind, "diagnostic");
  assert.equal(classifyNetworkFailure(new AggregateError([failure("ECONNRESET"), new Error("private unknown")])).kind, "unknown");
  assert.equal(classifyNetworkFailure(Object.assign(new Error("private"), { code: "ABORT_ERR" })).kind, "abort");
  const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
  assert.equal(classifyNetworkFailure(cycle).kind, "unknown");
  const getter = Object.defineProperty({}, "cause", { get() { throw new Error("private getter"); } });
  assert.equal(classifyNetworkFailure(getter).kind, "unknown");
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.equal(classifyNetworkFailure(revoked.proxy).kind, "unknown");
});

test("network diagnostics retain only the allowlisted code and fixed stage", () => {
  const secret = "https://private.invalid/?token=private";
  const record = providerFailureDiagnostic({ requestId: secret, durationMs: 1,
    failure: new ProviderError("upstream_unavailable", secret, 503, { code: "ECONNRESET", event: "network", stage: "stream" }) });
  assert.deepEqual(Object.fromEntries(Object.entries(record).filter(([key]) => key !== "timestamp")), {
    event: "provider_failure", durationMs: 1, code: "upstream_unavailable", status: 503, upstreamCode: "ECONNRESET", upstreamEvent: "network", upstreamStage: "stream",
  });
  assert.ok(!JSON.stringify(record).includes(secret));
});
