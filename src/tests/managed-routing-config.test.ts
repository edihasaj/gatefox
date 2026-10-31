import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderConfig } from "../config.js";
import { managedCandidateKind, validateManagedRouting } from "../managed-routing-config.js";
import { managedFixture } from "./managed-routing-fixture.js";

const providers = (): ProviderConfig[] => structuredClone(managedFixture("/unused").providers);
const route = (patch: Record<string, unknown> = {}) => ({ purpose: "routine", candidates: ["local/qwen", "sub/sol", "sub2/sonnet", "paid/flash"], allowPaid: true, ...patch });
const valid = (patch: Record<string, unknown> = {}, list = providers()) => validateManagedRouting({ routes: { "managed/routine": route(patch) } }, list);
const refuses = (value: unknown, pattern: RegExp, list = providers()) => assert.throws(() => validateManagedRouting(value, list), pattern);

test("a valid route is normalized with documented defaults", () => {
  assert.deepEqual(valid().routes["managed/routine"], { purpose: "routine", candidates: ["local/qwen", "sub/sol", "sub2/sonnet", "paid/flash"],
    maxContextBytes: 262144, contextWindow: 32768, minRemainingPercent: 2, allowPaid: true });
  assert.equal(valid({ allowPaid: undefined, candidates: ["sub/sol"] }).routes["managed/routine"]!.allowPaid, false);
  const strong = validateManagedRouting({ routes: { "managed/strong": { purpose: "strong", candidates: ["sub/sol", "sub2/sonnet"], maxContextBytes: 4096, contextWindow: 4096, minRemainingPercent: 50 } } }, providers());
  assert.deepEqual(strong.routes["managed/strong"], { purpose: "strong", candidates: ["sub/sol", "sub2/sonnet"], maxContextBytes: 4096, contextWindow: 4096, minRemainingPercent: 50, allowPaid: false });
});

test("unknown keys and wrong types are refused", () => {
  for (const value of [null, [], "x", { routes: {}, extra: 1 }, { routes: [] }, { routes: { "managed/a": null } }, { routes: { "managed/a": [] } }]) refuses(value, /managed/i);
  refuses({ routes: { "managed/routine": route({ extra: true }) } }, /unknown field extra/);
  for (const patch of [{ purpose: "other" }, { purpose: undefined }, { candidates: "sub/sol" }, { candidates: undefined }, { candidates: [1] },
    { allowPaid: "yes" }, { maxContextBytes: "262144" }, { contextWindow: 32768.5 }, { minRemainingPercent: null }]) {
    assert.throws(() => valid({ ...patch }), /purpose|candidates|allowPaid|maxContextBytes|contextWindow|minRemainingPercent/, JSON.stringify(patch));
  }
});

test("managed compaction thresholds must fit inside the usable context window", () => {
  const selected = valid({ contextWindow: 131072, maxContextBytes: 1048576, autoCompactTokenLimit: 104857 });
  assert.equal(selected.routes["managed/routine"].autoCompactTokenLimit, 104857);
  for (const value of [null, "10000", 1023, 32768, 1.5, Number.MAX_SAFE_INTEGER])
    assert.throws(() => valid({ autoCompactTokenLimit: value }), /autoCompactTokenLimit/);
  assert.equal(valid().routes["managed/routine"].autoCompactTokenLimit, undefined, "old pin policy shapes remain unchanged");
});

test("candidate-specific reasoning is explicit and must match a supported candidate capability", () => {
  const value = valid({ candidateReasoningEfforts: { "local/qwen": "high" } });
  assert.equal(value.routes["managed/routine"].candidateReasoningEfforts?.["local/qwen"], "high");
  for (const map of [null, [], { "missing/model": "high" }, { "local/qwen": "xhigh" }, { "local/qwen": 1 }])
    assert.throws(() => valid({ candidateReasoningEfforts: map }), /candidate|object/);
  assert.equal(valid().routes["managed/routine"].candidateReasoningEfforts, undefined, "old policy fingerprints retain their exact shape");
});

test("managed aliases are bounded, well formed and cannot collide with provider aliases", () => {
  refuses({ routes: {} }, /1 to 8/);
  const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`managed/r${i}`, route()]));
  refuses({ routes: nine }, /1 to 8/);
  const eight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`managed/r${i}`, route()]));
  assert.equal(Object.keys(validateManagedRouting({ routes: eight }, providers()).routes).length, 8);
  for (const alias of ["routine", "managed/", "managed/Routine", "managed/1a", "managed/a_b", `managed/a${"b".repeat(32)}`, "other/routine", "managed/a/b"]) {
    refuses({ routes: { [alias]: route() } }, /Managed aliases/, providers());
  }
  assert.ok(valid().routes["managed/a".concat("b".repeat(31))] === undefined);
  validateManagedRouting({ routes: { ["managed/a" + "b".repeat(31)]: route() } }, providers());
  const list = providers();
  list[1]!.models["managed/routine"] = "gpt-6.1-sol";
  refuses({ routes: { "managed/routine": route() } }, /collides/, list);
});

test("candidates are unique, bounded, existing aliases", () => {
  for (const candidates of [[], ["sub/sol", "sub/sol"], ["missing/model"], ["bad alias"], ["x".repeat(161)]]) assert.throws(() => valid({ candidates, allowPaid: false }), /candidate/);
  const many = providers();
  for (let i = 0; i < 13; i += 1) many[1]!.models[`sub/m${i}`] = "gpt-6.1-sol", many[1]!.modelMetadata![`sub/m${i}`] = { contextWindow: 500000 };
  assert.throws(() => valid({ candidates: Array.from({ length: 13 }, (_, i) => `sub/m${i}`) }, many), /1 to 12/);
  assert.equal(valid({ candidates: Array.from({ length: 12 }, (_, i) => `sub/m${i}`) }, many).routes["managed/routine"]!.candidates.length, 12);
  const ambiguous = providers();
  ambiguous[2]!.models["sub/sol"] = "claude-sonnet-5-5";
  assert.throws(() => valid({ candidates: ["sub/sol"] }, ambiguous), /exactly one/);
});

test("numeric bounds are enforced", () => {
  for (const [key, bad, good] of [["maxContextBytes", [4095, 4194305], [4096, 4194304]], ["contextWindow", [4095, 262145], [4096, 32768]], ["minRemainingPercent", [0, 51], [1, 50]]] as const) {
    for (const value of bad) assert.throws(() => valid({ [key]: value }), new RegExp(key), `${key}=${value}`);
    for (const value of good) assert.equal(valid({ [key]: value }).routes["managed/routine"]![key], value);
  }
  assert.throws(() => valid({ maxContextBytes: Number.NaN }), /maxContextBytes/);
  assert.throws(() => valid({ maxContextBytes: Infinity }), /maxContextBytes/);
});

test("candidates run local, then subscriptions, then paid, with a subscription present", () => {
  assert.throws(() => valid({ candidates: ["sub/sol", "local/qwen"] }), /ordered/);
  assert.throws(() => valid({ candidates: ["paid/flash", "sub/sol"] }), /ordered/);
  assert.throws(() => valid({ candidates: ["local/qwen", "paid/flash"] }), /subscription/);
  assert.throws(() => valid({ candidates: ["local/qwen"] }), /subscription/);
  assert.throws(() => valid({ candidates: ["paid/flash"] }), /subscription/);
  valid({ candidates: ["sub/sol", "paid/flash"] });
  valid({ candidates: ["sub2/sonnet", "sub/sol"] });
});

test("strong routes forbid local and paid candidates need allowPaid", () => {
  assert.throws(() => valid({ purpose: "strong" }), /strong routes cannot use local/);
  assert.equal(valid({ purpose: "strong", candidates: ["sub/sol", "paid/flash"] }).routes["managed/routine"]!.purpose, "strong");
  assert.throws(() => valid({ allowPaid: false }), /requires allowPaid/);
  assert.throws(() => valid({ allowPaid: undefined }), /requires allowPaid/);
});

test("a candidate that is not a supported kind is refused", () => {
  const list = providers();
  list.push({ id: "remote", type: "chat-completions-api", baseUrl: "https://example.com/v1", apiKeyEnv: "REMOTE_KEY", models: { "remote/m": "m" }, modelMetadata: { "remote/m": { contextWindow: 131072 } } },
    { id: "grok", type: "grok-subscription", models: { "grok/m": "grok" }, modelMetadata: { "grok/m": { contextWindow: 131072 } } });
  for (const alias of ["remote/m", "grok/m"]) assert.throws(() => valid({ candidates: ["sub/sol", alias], allowPaid: false }, list), /not a supported/);
});

test("a candidate window below the route window, a missing window, or a lowering cap is refused", () => {
  const small = providers();
  small[0]!.modelMetadata!["local/qwen"] = { contextWindow: 16384 };
  assert.throws(() => valid({}, small), /context window is below/);
  assert.equal(valid({ contextWindow: 16384 }, small).routes["managed/routine"]!.contextWindow, 16384);
  const unknown = providers();
  delete unknown[1]!.modelMetadata!["sub/sol"];
  assert.throws(() => valid({}, unknown), /no known context window/);
  unknown[1]!.modelMetadata!["sub/sol"] = { displayName: "no window" };
  assert.throws(() => valid({}, unknown), /no known context window/);
  const capped = providers();
  capped[1]!.modelMetadata!["sub/sol"] = { contextWindow: 500000, contextWindowCap: 16384 };
  assert.throws(() => valid({}, capped), /context window is below/);
  capped[1]!.modelMetadata!["sub/sol"] = { contextWindow: 500000, contextWindowCap: 65536 };
  valid({}, capped);
});

test("candidate kinds follow location, vendor and exact paid model", () => {
  const chat = (baseUrl: string, tailnet?: boolean) => ({ type: "chat-completions-api" as const, baseUrl, ...(tailnet === undefined ? {} : { tailnet }) });
  assert.equal(managedCandidateKind(chat("http://127.0.0.1:3000/v1"), "qwen"), "local");
  assert.equal(managedCandidateKind(chat("http://localhost:3000/v1"), "qwen"), "local");
  assert.equal(managedCandidateKind(chat("http://[::1]:3000/v1"), "qwen"), "local");
  assert.equal(managedCandidateKind(chat("http://studio.tailnet.ts.net:8000/v1", true), "qwen"), "local");
  assert.equal(managedCandidateKind(chat("http://studio.tailnet.ts.net:8000/v1"), "qwen"), undefined);
  assert.equal(managedCandidateKind(chat("https://example.com/v1", true), "qwen"), undefined);
  assert.equal(managedCandidateKind({ type: "responses-api", baseUrl: "http://127.0.0.1:3000/v1" }, "qwen"), undefined);
  assert.equal(managedCandidateKind({ type: "chat-completions-api" }, "qwen"), undefined);
  assert.equal(managedCandidateKind(chat("not a url"), "qwen"), undefined);
  for (const type of ["codex-subscription", "claude-subscription"] as const) assert.equal(managedCandidateKind({ type }, "any"), "subscription");
  for (const type of ["copilot-subscription", "grok-subscription", "anthropic-api"] as const) assert.equal(managedCandidateKind({ type, baseUrl: "https://openrouter.ai/api/v1" }, "deepseek/deepseek-v4-flash"), undefined);
  const paid = (upstream: string, type: "responses-api" | "chat-completions-api" = "responses-api", baseUrl = "https://openrouter.ai/api/v1") => managedCandidateKind({ type, baseUrl }, upstream);
  for (const upstream of ["deepseek/deepseek-v4-flash", "DeepSeek/DeepSeek-V4-Flash", "deepseek/deepseek-v4-flash:free", "deepseek/deepseek-v4-flash-0501", "deepseek/deepseek-v4-flash.1", "deepseek/deepseek-v4.1-flash-1017"]) {
    assert.equal(paid(upstream), "paid-flash", upstream);
    assert.equal(paid(upstream, "chat-completions-api"), "paid-flash", upstream);
  }
  for (const upstream of ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash-pro", "deepseek/deepseek-v4-flash:glm", "deepseek/deepseek-v4.1-pro-1017", "deepseek/deepseek-v4.1-flash-pro", "deepseek/deepseek-v4.1-flash:glm", "deepseek/deepseek-v5-flash", "z-ai/glm-5", "deepseek/deepseek-v4-flashx", "deepseek/deepseek-v4", "other/deepseek/deepseek-v4-flash"]) assert.equal(paid(upstream), undefined, upstream);
  for (const baseUrl of ["http://openrouter.ai/api/v1", "https://openrouter.ai.evil.example/v1", "https://evilopenrouter.ai/v1", "https://openrouter.ai:8443/v1", "https://user:pw@openrouter.ai/v1", "https://example.com/v1"]) {
    assert.equal(paid("deepseek/deepseek-v4-flash", "responses-api", baseUrl), undefined, baseUrl);
  }
});

test("the shipped fixture configuration is accepted unchanged", () => {
  const fixture = managedFixture("/unused");
  assert.deepEqual(validateManagedRouting(fixture.managedRouting, fixture.providers), fixture.managedRouting);
});

test("validation does not mutate its input", () => {
  const input = { routes: { "managed/routine": route() } }, before = structuredClone(input), list = providers(), copy = structuredClone(list);
  validateManagedRouting(input, list);
  assert.deepEqual(input, before);
  assert.deepEqual(list, copy);
});
