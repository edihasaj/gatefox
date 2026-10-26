import test from "node:test";
import assert from "node:assert/strict";
import { classifyNetworkFailure, networkCodesField } from "../provider-network.js";
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

test("a mixed transient aggregate names every socket code it held", () => {
  assert.deepEqual(classifyNetworkFailure(new AggregateError([fault("ECONNRESET"), fault("ETIMEDOUT"), fault("EAI_AGAIN")])).codes,
    ["EAI_AGAIN", "ECONNRESET", "ETIMEDOUT"]);
  // One code is the whole answer, so only a genuine mix is reported as a set, and a long one stays bounded.
  assert.equal(classifyNetworkFailure(new AggregateError([fault("ECONNRESET"), fault("ECONNRESET")])).codes, undefined);
  assert.equal(classifyNetworkFailure(new AggregateError([fault("ECONNRESET"), fault("ETIMEDOUT"), fault("EAI_AGAIN"), fault("EPIPE"), fault("ENETDOWN"), fault("EHOSTUNREACH")])).codes?.length, 4);
});

test("the network-code record is read once from own data properties and never through a method", () => {
  const leak = "https://private.invalid/?token=private-and-address";
  let reads = 0;
  const accessor = ["ETIMEDOUT"]; accessor.length = 2;
  Object.defineProperty(accessor, "1", { get() { reads++; return leak; }, configurable: true });
  assert.equal(networkCodesField(accessor), undefined);
  assert.ok(reads < 2, "an accessor was consulted more than once, so validation and output could disagree");
  const overridden = ["ECONNRESET"];
  Object.defineProperty(overridden, "every", { value: () => { throw new Error("private-method-side-effect"); } });
  assert.equal(networkCodesField(overridden), undefined);
  const iterator = ["ECONNRESET"];
  Object.defineProperty(iterator, Symbol.iterator, { value: function* () { yield leak; } });
  assert.equal(networkCodesField(iterator), undefined);
  class list extends Array {}
  assert.equal(networkCodesField(list.of("ETIMEDOUT")), undefined);
  assert.equal(networkCodesField(new Proxy(["ETIMEDOUT"], { getOwnPropertyDescriptor() { throw new Error("private-descriptor"); } })), undefined);
  // The plain path the classifier itself produces still records.
  assert.equal(networkCodesField(["ETIMEDOUT", "EHOSTUNREACH"]), "EHOSTUNREACH,ETIMEDOUT");
  assert.ok(!JSON.stringify([networkCodesField(accessor), networkCodesField(iterator)]).includes(leak));
});
