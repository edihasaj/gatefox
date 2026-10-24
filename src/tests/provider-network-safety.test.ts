import test from "node:test";
import assert from "node:assert/strict";
import { classifyNetworkFailure } from "../provider-network.js";
import { classifyProviderFailure, providerFailureDiagnostic } from "../provider-failure.js";
const fault = (code: string, cause?: unknown) => Object.assign(new Error("private-diagnostic-and-address"), { code, ...(cause ? { cause } : {}) });

test("unknown native fetch causes preserve the generic 503 without leaking private diagnostics", () => {
  const error = new TypeError("fetch failed", { cause: fault("PRIVATE_CODE") });
  assert.deepEqual(classifyNetworkFailure(error), { kind: "diagnostic" });
  const failure = classifyProviderFailure(error, undefined);
  assert.equal(failure.status, 503);
  assert.equal(failure.code, "upstream_unavailable");
  const diagnostic = providerFailureDiagnostic({ requestId: "fixture", durationMs: 0, failure });
  assert.doesNotMatch(JSON.stringify({ failure, diagnostic }), /PRIVATE_CODE|private-diagnostic-and-address/);
  assert.notEqual(classifyNetworkFailure(new AggregateError([fault("ECONNRESET"), error])).kind, "transient");
});

test("unknown fetch wrappers and permanent nested causes cannot acquire automatic recovery", () => {
  assert.notEqual(classifyNetworkFailure(new TypeError("fetch failed")).kind, "transient");
  for (const code of ["CERT_HAS_EXPIRED", "ENOTFOUND", "ABORT_ERR"]) {
    assert.notEqual(classifyNetworkFailure(fault("ECONNRESET", fault(code))).kind, "transient", code);
  }
  assert.notEqual(classifyNetworkFailure(Object.assign(fault("CERT_HAS_EXPIRED"), { errors: [fault("ECONNRESET")] })).kind, "transient");
});

test("aggregate inspection never evaluates array accessors or hostile proxy properties", () => {
  let reads = 0;
  const children: unknown[] = [];
  Object.defineProperty(children, "0", { get() { reads++; throw new Error("private-accessor-value"); }, configurable: true });
  assert.doesNotThrow(() => assert.notEqual(classifyNetworkFailure({ errors: children }).kind, "transient"));
  assert.equal(reads, 0);
  const causeAccessor = Object.assign(new Error("private"), { code: "ECONNRESET" });
  Object.defineProperty(causeAccessor, "cause", { get() { reads++; throw new Error("private-cause"); } });
  assert.notEqual(classifyNetworkFailure(causeAccessor).kind, "transient");
  assert.equal(reads, 0);
  const revoked = Proxy.revocable([], {}); revoked.revoke();
  assert.doesNotThrow(() => assert.notEqual(classifyNetworkFailure({ errors: revoked.proxy }).kind, "transient"));
  const hostile = new Proxy([], { get() { reads++; throw new Error("private-proxy-value"); } });
  assert.doesNotThrow(() => assert.notEqual(classifyNetworkFailure({ errors: hostile }).kind, "transient"));
  assert.equal(reads, 0);
});

test("mixed known transient aggregate codes remain eligible but unknown leaves veto recovery", () => {
  assert.equal(classifyNetworkFailure(new AggregateError([fault("ECONNRESET"), fault("ETIMEDOUT"), fault("EAI_AGAIN")])).kind, "transient");
  assert.notEqual(classifyNetworkFailure(new AggregateError([fault("ECONNRESET"), new Error("private-unknown")])).kind, "transient");
});
