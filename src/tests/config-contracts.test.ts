import test from "node:test";
import assert from "node:assert/strict";
import { claudeSessionMax, claudeSessionSettings, validateConfig, type ModelMetadata, type ProviderConfig } from "../config.js";

const claude = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: "claude", type: "claude-subscription", models: { sonnet: "claude-sonnet" }, ...extra });
const codex = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: "codex", type: "codex-subscription", credentialFile: "codex.json", models: { "codex/sol": "sol" }, ...extra });
const config = (providers: unknown[], extra: Record<string, unknown> = {}) => validateConfig({ version: 1, port: 1, stateDirectory: "/tmp/state", providers, ...extra }, "/tmp");

test("claudeSessions is optional, defaulted, limited and only valid on Claude subscriptions", () => {
  const gib = 1024 ** 3;
  // The default cap is a tenth of RAM in 300 MB slots, clamped to 6..32: small Macs keep today's 6.
  assert.deepEqual(claudeSessionSettings(claude(), 8 * gib), { mode: "replay", max: 6, parkMinutes: 60, replayFormat: "text" });
  assert.deepEqual([claudeSessionMax(16 * gib), claudeSessionMax(64 * gib), claudeSessionMax(256 * gib), claudeSessionMax(gib)], [6, 21, 32, 6]);
  assert.deepEqual(claudeSessionSettings(claude(), 64 * gib), { mode: "replay", max: 21, parkMinutes: 60, replayFormat: "text" });
  assert.equal(claudeSessionSettings(claude({ claudeSessions: { max: 3 } }), 64 * gib).max, 3, "an explicit value wins over the memory default");
  assert.equal(claudeSessionSettings(claude()).max, claudeSessionMax(), "this machine's default comes from its own memory");
  const live = config([claude({ claudeSessions: { mode: "live", max: 16, parkMinutes: 5, replayFormat: "json" } })]).providers[0];
  assert.deepEqual(claudeSessionSettings(live), { mode: "live", max: 16, parkMinutes: 5, replayFormat: "json" });
  assert.deepEqual(claudeSessionSettings(config([claude({ claudeSessions: { max: 1, parkMinutes: 240 } })]).providers[0]), { mode: "replay", max: 1, parkMinutes: 240, replayFormat: "text" });
  for (const claudeSessions of [{ mode: "live-ish" }, { max: 0 }, { max: 33 }, { max: 2.5 }, { parkMinutes: 4 }, { parkMinutes: 241 }, { replayFormat: "yaml" }, [], null, "live"]) {
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
    [{ id: "a" }, { id: "a" }], [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
    [{ id: "a", label: "" }], [{ id: "a", label: "x".repeat(65) }], [{ id: "a", label: "line\nbreak" }], [{ id: "a", label: "tab\there" }], [{ id: "a", label: 7 }],
    [{ id: "a", workspaceId: "" }], [{ id: "a", workspaceId: "w".repeat(129) }], [{ id: "a", workspaceId: "ws/1" }],
  ]) assert.throws(() => config([codex()], { accountEngines: invalid }), Error, JSON.stringify(invalid));
  assert.equal(config([codex()], { accountEngines: [{ id: "a".repeat(32), label: "é".repeat(64) }] }).accountEngines?.length, 1);
});

test("plain HTTP is accepted only on loopback or for a tailnet chat provider, and the other URL rules still apply", () => {
  const chat = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: "qwen", type: "chat-completions-api", baseUrl: "http://dgx.example:4000/v1", credentialFile: "qwen.token", models: { "qwen/flash": "qwen" }, ...extra });
  assert.throws(() => config([chat()]), /API providers require HTTPS except on loopback/);
  assert.throws(() => config([chat({ tailnet: false })]), /API providers require HTTPS except on loopback/);
  assert.equal(config([chat({ tailnet: true })]).providers[0].tailnet, true);
  assert.equal(config([chat({ tailnet: true, baseUrl: "https://dgx.example/v1" })]).providers[0].baseUrl, "https://dgx.example/v1");
  assert.equal(config([chat({ baseUrl: "http://127.0.0.1:4400/v1" })]).providers[0].tailnet, undefined, "loopback is unchanged");
  for (const baseUrl of ["http://user:pass@dgx.example/v1", "http://dgx.example/v1?key=1", "http://dgx.example/v1#frag"]) assert.throws(() => config([chat({ tailnet: true, baseUrl })]), /must not contain credentials/, baseUrl);
  assert.throws(() => config([chat({ tailnet: "yes" as unknown as boolean })]), /tailnet must be boolean/);
  // Only the chat adapter connects through the address check, so no other provider may opt in.
  assert.throws(() => config([chat({ type: "responses-api", tailnet: true })]), /tailnet is only valid for chat-completions-api/);
  assert.throws(() => config([chat({ type: "anthropic-api", tailnet: true })]), /tailnet is only valid for chat-completions-api/);
  assert.throws(() => config([claude({ tailnet: true })]), /tailnet is only valid for chat-completions-api/);
  // The rule does not depend on the value: the key is refused on every other type, true or false.
  for (const type of ["responses-api", "anthropic-api", "claude-subscription", "codex-subscription", "copilot-subscription"] as const) {
    for (const tailnet of [true, false]) assert.throws(() => config([chat({ type, tailnet, credentialFile: "x.token" })]), /tailnet is only valid for chat-completions-api/, `${type} ${tailnet}`);
  }
  assert.throws(() => config([chat({ type: "responses-api" })]), /API providers require HTTPS except on loopback/);
});
