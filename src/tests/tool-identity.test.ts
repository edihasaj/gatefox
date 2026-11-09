import test from "node:test";
import assert from "node:assert/strict";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ProviderError } from "../providers/provider.js";
import { resetToolIdentityFallbackCounts, toolIdentityFailure, toolIdentityFallbackCounts, toolIdentityReasons } from "../providers/tool-identity.js";
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

const wire = (bridge: ReturnType<typeof responsesFunctionTools>, index: number) => (bridge.body.tools![index] as { name: string }).name;
const refused = (bridge: ReturnType<typeof responsesFunctionTools>, name: string) => assert.throws(() => bridge.restoreItem({ type: "function_call", name }),
  error => error instanceof ProviderError && error.code === "tool_identity_failure" && error.upstream?.code === "unknown_wire_tool" && !error.message.includes(name));
const catalog = () => responsesFunctionTools({ model: "fixture", input: "go", tools: [
  { type: "function", name: "exec_command" },
  { type: "namespace", name: "files", tools: [{ type: "function", name: "read" }, { type: "custom", name: "patch" }] },
] }, "or");

test("function bridge restores a returned caller alias only when it names exactly one declared tool", t => {
  const bridge = catalog(); resetToolIdentityFallbackCounts(); t.after(resetToolIdentityFallbackCounts);
  let n = 0;
  const call = (name: string, extra: Record<string, unknown> = {}) => ({ type: "function_call", call_id: `c${n++}`, name, arguments: JSON.stringify({ cmd: "ls" }), status: "completed", ...extra });
  const restored = (name: string, expected: { name: string; namespace?: string }, extra: Record<string, unknown> = {}) => {
    const item = call(name, extra);
    assert.deepEqual(bridge.restoreItem(item), { ...item, ...expected });
  };
  restored(wire(bridge, 0), { name: "exec_command" });
  assert.deepEqual(toolIdentityFallbackCounts(), { alias: 0, namespaced_alias: 0, functions_prefix: 0, wire_case: 0 }, "the exact wire name is not a fallback");
  restored("exec_command", { name: "exec_command" });
  restored("functions.exec_command", { name: "exec_command" });
  restored("files.read", { name: "read", namespace: "files" });
  restored("functions.files.read", { name: "read", namespace: "files" });
  assert.deepEqual(toolIdentityFallbackCounts(), { alias: 1, namespaced_alias: 1, functions_prefix: 2, wire_case: 0 });
  // The arguments are never touched, so a custom tool's `{input}` envelope reaches the same validator as on the wire path.
  const envelope = JSON.stringify({ input: "*** Begin Patch\n" });
  const viaAlias = bridge.restoreItem(call("files.patch", { arguments: envelope }));
  const viaWire = bridge.restoreItem(call(wire(bridge, 2), { arguments: envelope }));
  assert.deepEqual({ ...viaAlias, call_id: "" }, { ...viaWire, call_id: "" });
  assert.equal(viaAlias.arguments, envelope); assert.equal(viaAlias.namespace, "files");
  // A call is restored once when it is added and once when it is done; it counts once.
  const again = call("exec_command"); bridge.restoreItem(again); bridge.restoreItem(again);
  assert.deepEqual(toolIdentityFallbackCounts(), { alias: 2, namespaced_alias: 2, functions_prefix: 2, wire_case: 0 });
});

test("function bridge accepts a wire name that differs only by case, but never a near miss", t => {
  const bridge = catalog(); resetToolIdentityFallbackCounts(); t.after(resetToolIdentityFallbackCounts);
  const exact = wire(bridge, 0);
  assert.equal(bridge.restoreItem({ type: "function_call", name: exact.toLowerCase() }).name, "exec_command");
  assert.equal(toolIdentityFallbackCounts().wire_case, 1);
  for (const near of [exact.slice(0, -1), `${exact}x`, exact.slice(0, -1) + (exact.endsWith("A") ? "B" : "A"), "exec_comman", "Exec_Command", "files.", "functions.", "functions.functions.exec_command", "read", "patch"]) refused(bridge, near);
  assert.equal(toolIdentityFallbackCounts().wire_case, 1);
});

test("function bridge refuses an ambiguous alias and an undeclared name", t => {
  resetToolIdentityFallbackCounts(); t.after(resetToolIdentityFallbackCounts);
  // `functions.x` names both the tool `x` (with its prefix) and a tool whose literal name is `functions.x`.
  const ambiguous = responsesFunctionTools({ model: "fixture", input: "go", tools: [{ type: "function", name: "x" }, { type: "function", name: "functions.x" }] }, "or");
  refused(ambiguous, "functions.x"); assert.equal(ambiguous.restoreItem({ type: "function_call", name: "x" }).name, "x");
  assert.equal(ambiguous.restoreItem({ type: "function_call", name: wire(ambiguous, 1) }).name, "functions.x");
  // The same bare name in two namespaces is only reachable by its qualified alias; the bare name is undeclared.
  const spaces = responsesFunctionTools({ model: "fixture", input: "go", tools: [
    { type: "namespace", name: "a", tools: [{ type: "function", name: "run" }] }, { type: "namespace", name: "b", tools: [{ type: "function", name: "run" }] }] }, "or");
  refused(spaces, "run"); refused(spaces, "functions.run"); refused(spaces, "c.run");
  assert.equal(spaces.restoreItem({ type: "function_call", name: "b.run" }).namespace, "b");
  refused(catalog(), secret); refused(catalog(), `functions.${secret}`);
  assert.deepEqual(toolIdentityFallbackCounts(), { alias: 1, namespaced_alias: 1, functions_prefix: 0, wire_case: 0 });
  assert.ok(!JSON.stringify(toolIdentityFallbackCounts()).includes("exec_command"), "counters hold only fixed labels");
});

test("function bridge still refuses a namespace on a returned call, even when the alias matches", () => {
  assert.throws(() => catalog().restoreItem({ type: "function_call", name: "exec_command", namespace: "files" }),
    error => error instanceof ProviderError && error.upstream?.code === "unexpected_tool_namespace");
});

test("function bridge refuses a name that is the alias of one tool and a case variant of another tool's wire name", t => {
  resetToolIdentityFallbackCounts(); t.after(resetToolIdentityFallbackCounts);
  const exec = wire(catalog(), 0), variant = exec.toLowerCase();
  assert.notEqual(variant, exec, "the fixture needs a wire name with upper-case letters");
  const bridge = responsesFunctionTools({ model: "fixture", input: "go", tools: [{ type: "function", name: "exec_command" }, { type: "function", name: variant }] }, "or");
  assert.equal(wire(bridge, 0), exec);
  refused(bridge, variant);
  assert.deepEqual(toolIdentityFallbackCounts(), { alias: 0, namespaced_alias: 0, functions_prefix: 0, wire_case: 0 });
  // Each tool is still reachable by an unambiguous spelling, and the exact wire name is never a fallback.
  assert.equal(bridge.restoreItem({ type: "function_call", name: exec }).name, "exec_command");
  assert.equal(bridge.restoreItem({ type: "function_call", name: "exec_command" }).name, "exec_command");
  assert.equal(bridge.restoreItem({ type: "function_call", name: wire(bridge, 1) }).name, variant);
});

test("function bridge bounds what it remembers about fallback calls, and still counts normal calls once", t => {
  resetToolIdentityFallbackCounts(); t.after(resetToolIdentityFallbackCounts);
  const bridge = catalog();
  const call = (call_id: string) => ({ type: "function_call", call_id, name: "exec_command", arguments: "{}" });
  // Added-only items are never validated by the provider, so an oversized id is neither remembered nor counted, and the call runs.
  for (let i = 0; i < 64; i++) assert.equal(bridge.restoreItem(call(`${i}`.padEnd(256 * 1024, "x"))).name, "exec_command");
  assert.equal(toolIdentityFallbackCounts().alias, 0);
  // Normal ids count once each (added, then done), up to the tool-call limit; further calls still run but are not counted.
  for (let i = 0; i < 1100; i++) { bridge.restoreItem(call(`call-${i}`)); bridge.restoreItem(call(`call-${i}`)); }
  assert.equal(toolIdentityFallbackCounts().alias, 1024);
  assert.equal(bridge.restoreItem(call("call-1099")).name, "exec_command");
  assert.equal(toolIdentityFallbackCounts().alias, 1024);
});

test("function bridge folds case on ASCII letters only, so a look-alike Unicode letter never matches a wire name", t => {
  resetToolIdentityFallbackCounts(); t.after(resetToolIdentityFallbackCounts);
  // `toLowerCase` maps U+212A KELVIN SIGN to `k`; find a tool whose wire name has a k so the fixture exercises it.
  let bridge = catalog(), index = 0, tool = "";
  while (!/k/i.test(tool)) { tool = wire(bridge = responsesFunctionTools({ model: "fixture", input: "go", tools: [{ type: "function", name: `t${index++}` }] }, "or"), 0); }
  const lookalike = tool.replace(/k/i, "K");
  assert.equal(lookalike.toLowerCase(), tool.toLowerCase(), "the fixture must be one that Unicode case folding would accept");
  refused(bridge, lookalike);
  assert.deepEqual(toolIdentityFallbackCounts(), { alias: 0, namespaced_alias: 0, functions_prefix: 0, wire_case: 0 });
  // ASCII case variants of the same name are still accepted.
  assert.equal(bridge.restoreItem({ type: "function_call", name: tool.toUpperCase() }).name, `t${index - 1}`);
  assert.equal(toolIdentityFallbackCounts().wire_case, 1);
});
