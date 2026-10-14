import test from "node:test";
import assert from "node:assert/strict";
import { claudeSessionSettings, validateConfig, type ModelMetadata, type ProviderConfig } from "../config.js";

const claude = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: "claude", type: "claude-subscription", models: { sonnet: "claude-sonnet" }, ...extra });
const codex = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: "codex", type: "codex-subscription", credentialFile: "codex.json", models: { "codex/sol": "sol" }, ...extra });
const config = (providers: unknown[], extra: Record<string, unknown> = {}) => validateConfig({ version: 1, port: 1, stateDirectory: "/tmp/state", providers, ...extra }, "/tmp");

test("claudeSessions is optional, defaulted, limited and only valid on Claude subscriptions", () => {
  assert.deepEqual(claudeSessionSettings(claude()), { mode: "replay", max: 6, parkMinutes: 60, replayFormat: "text" });
  const live = config([claude({ claudeSessions: { mode: "live", max: 16, parkMinutes: 5, replayFormat: "json" } })]).providers[0];
  assert.deepEqual(claudeSessionSettings(live), { mode: "live", max: 16, parkMinutes: 5, replayFormat: "json" });
  assert.deepEqual(claudeSessionSettings(config([claude({ claudeSessions: { max: 1, parkMinutes: 240 } })]).providers[0]), { mode: "replay", max: 1, parkMinutes: 240, replayFormat: "text" });
  for (const claudeSessions of [{ mode: "live-ish" }, { max: 0 }, { max: 17 }, { max: 2.5 }, { parkMinutes: 4 }, { parkMinutes: 241 }, { replayFormat: "yaml" }, [], null, "live"]) {
    assert.throws(() => config([claude({ claudeSessions: claudeSessions as ProviderConfig["claudeSessions"] })]), /claudeSessions/, JSON.stringify(claudeSessions));
  }
  assert.throws(() => config([codex({ claudeSessions: { mode: "live" } })]), /only valid for claude-subscription/);
});

test("model metadata accepts Codex catalog parity fields within their limits", () => {
  const metadata: ModelMetadata = { truncationPolicy: { mode: "bytes", limit: 1000000 }, effectiveContextWindowPercent: 50, autoCompactTokenLimit: 1024, maxContextWindow: 1024 };
  assert.deepEqual(config([codex({ modelMetadata: { "codex/sol": metadata } })]).providers[0].modelMetadata?.["codex/sol"], metadata);
  config([codex({ modelMetadata: { "codex/sol": { truncationPolicy: { mode: "tokens", limit: 1000 }, effectiveContextWindowPercent: 100 } } })]);
  for (const invalid of [
    { truncationPolicy: { mode: "lines", limit: 10000 } }, { truncationPolicy: { mode: "tokens", limit: 999 } }, { truncationPolicy: { mode: "tokens", limit: 1000001 } },
    { truncationPolicy: { mode: "tokens", limit: 1.5e4 + 0.5 } }, { truncationPolicy: null }, { truncationPolicy: [] },
    { effectiveContextWindowPercent: 49 }, { effectiveContextWindowPercent: 101 }, { effectiveContextWindowPercent: 90.5 },
    { autoCompactTokenLimit: 1023 }, { autoCompactTokenLimit: "4096" }, { maxContextWindow: 1023 }, { maxContextWindow: 2e5 + 0.1 },
  ]) assert.throws(() => config([codex({ modelMetadata: { "codex/sol": invalid as ModelMetadata } })]), Error, JSON.stringify(invalid));
});

test("accountEngines validates IDs, labels, workspaces and provider collisions, then copies through", () => {
  const engines = [{ id: "codex", label: "Codex · Work", workspaceId: "ws_A-1" }, { id: "personal" }];
  assert.deepEqual(config([claude(), codex()], { accountEngines: engines }).accountEngines, engines);
  assert.equal(config([claude()]).accountEngines, undefined);
  const copied = config([codex()], { accountEngines: [{ id: "codex", extra: "dropped" }] }).accountEngines;
  assert.deepEqual(copied, [{ id: "codex" }]);
  assert.throws(() => config([claude(), codex()], { accountEngines: [{ id: "claude" }] }), /only with a codex-subscription provider/);
  const remote = validateConfig({ version: 1, port: 3457, stateDirectory: "/tmp/state", providers: [], clientOnly: true, accountEngines: [{ id: "codex" }] });
  assert.deepEqual(remote.accountEngines, [{ id: "codex" }]); assert.equal(remote.clientOnly, true);
  for (const invalid of [
    "codex", {}, [{ id: "Codex" }], [{ id: "1codex" }], [{ id: "a".repeat(33) }], [{ id: "" }], [{}], [null],
    [{ id: "a" }, { id: "a" }], Array.from({ length: 17 }, (_, index) => ({ id: `a${index}` })), [{ id: "a", type: "claude" }],
    [{ id: "a", label: "" }], [{ id: "a", label: "x".repeat(65) }], [{ id: "a", label: "line\nbreak" }], [{ id: "a", label: "tab\there" }], [{ id: "a", label: 7 }],
    [{ id: "a", workspaceId: "" }], [{ id: "a", workspaceId: "w".repeat(129) }], [{ id: "a", workspaceId: "ws/1" }],
  ]) assert.throws(() => config([codex()], { accountEngines: invalid }), Error, JSON.stringify(invalid));
  assert.equal(config([codex()], { accountEngines: [{ id: "a".repeat(32), label: "é".repeat(64) }] }).accountEngines?.length, 1);
});
