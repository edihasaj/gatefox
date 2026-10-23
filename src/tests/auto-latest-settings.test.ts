import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig } from "../config.js";
import { seedScope } from "../model-auto-latest/planner.js";
import { strictUnion, validateAutoLatestSettings } from "../model-auto-latest/settings.js";

const scope = (extra: Record<string, unknown> = {}) => ({ families: ["claude-opus"], baselineModels: ["claude-opus-5-4"], ...extra });
const base = (extra: Record<string, unknown> = {}) => ({ version: 1, port: 3457, stateDirectory: "state",
  providers: [{ id: "claude", type: "claude-subscription", models: { "claude/claude-opus-5-4": "claude-opus-5-4" }, ...extra }] });

test("the settings schema accepts the documented shape and strips nothing it knows", () => {
  const value = { enabled: true, providers: { claude: scope({ baselinePending: true }) }, native: { families: ["gpt-luna"], baselineModels: ["gpt-6-luna"] } };
  assert.deepEqual(validateAutoLatestSettings(value), value);
  assert.deepEqual(validateAutoLatestSettings({ enabled: false, providers: {} }), { enabled: false, providers: {} });
});

test("the settings schema is strict about keys, types, families, repeats and bounds", () => {
  const bad: unknown[] = [
    null, [], "on", { enabled: "yes", providers: {} }, { providers: {} }, { enabled: true }, { enabled: true, providers: [] },
    { enabled: true, providers: {}, extra: 1 },
    { enabled: true, providers: { claude: { ...scope(), extra: 1 } } },
    { enabled: true, providers: { claude: scope({ baselinePending: "yes" }) } },
    { enabled: true, providers: { claude: scope({ families: ["claude-unknown"] }) } },
    { enabled: true, providers: { claude: scope({ families: ["claude-opus", "claude-opus"] }) } },
    { enabled: true, providers: { claude: scope({ baselineModels: ["a", "a"] }) } },
    { enabled: true, providers: { claude: scope({ baselineModels: ["bad id"] }) } },
    { enabled: true, providers: { claude: scope({ baselineModels: Array.from({ length: 257 }, (_, index) => `claude-opus-${index + 1}`) }) } },
    { enabled: true, providers: { "Bad Id": scope() } },
    { enabled: true, providers: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`p${index}`, scope()])) },
    { enabled: true, providers: {}, native: { families: "gpt-luna", baselineModels: [] } },
  ];
  for (const value of bad) assert.throws(() => validateAutoLatestSettings(value));
  // Exactly 256 entries and 32 providers are the largest accepted sizes.
  assert.doesNotThrow(() => validateAutoLatestSettings({ enabled: true, providers: { claude: scope({ baselineModels: Array.from({ length: 256 }, (_, index) => `claude-opus-${index + 1}`) }) } }));
  assert.doesNotThrow(() => validateAutoLatestSettings({ enabled: true, providers: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`p${index}`, scope()])) }));
});

test("a configuration carries the settings through validation and refuses a bad one without echoing it", () => {
  const settings = { enabled: true, providers: { claude: scope() } };
  assert.deepEqual(validateConfig({ ...base(), autoLatestModels: settings }).autoLatestModels, settings);
  assert.equal(validateConfig(base()).autoLatestModels, undefined);
  assert.throws(() => validateConfig({ ...base(), autoLatestModels: { enabled: true, providers: { claude: scope({ baselineModels: ["secret value"] }) } } }), error => !/secret value/.test((error as Error).message));
});

test("model metadata validates pickerHidden and releasedAt", () => {
  const meta = (value: Record<string, unknown>) => base({ modelMetadata: { "claude/claude-opus-5-4": value } });
  assert.doesNotThrow(() => validateConfig(meta({ pickerHidden: true, releasedAt: 1_780_000_000 })));
  for (const value of [{ pickerHidden: "yes" }, { releasedAt: 1.5 }, { releasedAt: "2026" }, { releasedAt: 1e12 }, { releasedAt: 5 }, { releasedAt: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => validateConfig(meta(value)));
  }
});

test("a baseline over the bound is refused instead of truncated", () => {
  const many = Array.from({ length: 257 }, (_, index) => `claude-opus-${index + 1}`);
  assert.equal(strictUnion(many), undefined);
  assert.equal(strictUnion(many.slice(0, 256))?.length, 256);
  assert.throws(() => seedScope([{ id: "claude-opus-5-4" }], ["claude-opus-5-4"], many, undefined, false), error => (error as { code?: string }).code === "invalid_request");
  const scopeValue = seedScope([{ id: "claude-opus-5-4" }, { id: "claude-sonnet-5-4" }], ["claude-opus-5-4", "claude-sonnet-5-4"], ["claude-haiku-5-4", "claude-opus-5-3"], undefined, true);
  assert.deepEqual(scopeValue, { families: ["claude-opus", "claude-sonnet"], baselineModels: ["claude-opus-5-4", "claude-sonnet-5-4", "claude-opus-5-3"], baselinePending: true });
  assert.equal(seedScope([{ id: "grok-4" }], ["grok-4"], [], undefined, false), undefined);
});
