import test from "node:test";
import assert from "node:assert/strict";
import { claudeSessionMax, claudeSessionSettings, validateConfig, type ModelMetadata, type ProviderConfig } from "../config.js";

const claude = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: "claude", type: "claude-subscription", models: { sonnet: "claude-sonnet" }, ...extra });
const codex = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: "codex", type: "codex-subscription", credentialFile: "codex.json", models: { "codex/sol": "sol" }, ...extra });
const config = (providers: unknown[], extra: Record<string, unknown> = {}) => validateConfig({ version: 1, port: 1, stateDirectory: "/tmp/state", providers, ...extra }, "/tmp");

test("template reasoning transport is an explicit chat-provider boolean", () => {
  const chat = { id: "chat", type: "chat-completions-api", baseUrl: "http://127.0.0.1:8000/v1", apiKeyEnv: "TEST_KEY", models: { model: "model" } };
  assert.equal(config([chat]).providers[0].chatTemplateReasoningEffort, undefined);
  for (const value of [true, false]) assert.equal(config([{ ...chat, chatTemplateReasoningEffort: value }]).providers[0].chatTemplateReasoningEffort, value);
  for (const value of [null, "true", 1, {}]) assert.throws(() => config([{ ...chat, chatTemplateReasoningEffort: value }]), /must be boolean/);
  assert.throws(() => config([{ ...chat, type: "responses-api", chatTemplateReasoningEffort: true }]), /only valid for chat-completions-api/);
});

test("capacity discovery requires an explicit local-provider boolean and preserves static limits", () => {
  const local = { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:8000/v1", apiKeyEnv: "TEST_KEY", models: { qwen: "qwen" }, capacityDiscovery: true };
  const result = config([local], { maxConcurrent: 8 });
  assert.equal(result.providers[0].capacityDiscovery, true);
  assert.equal(result.providers[0].maxConcurrent, undefined);
  assert.equal(result.maxConcurrent, 8);
  assert.equal(config([{ ...local, type: "responses-api" }]).providers[0].capacityDiscovery, true);
  assert.equal(config([{ ...local, baseUrl: "http://farm.test/v1", tailnet: true }]).providers[0].capacityDiscovery, true);
  assert.throws(() => config([{ ...local, baseUrl: "https://remote.test/v1" }]), /requires a loopback or tailnet/);
  assert.throws(() => config([claude({ capacityDiscovery: true })]), /requires a loopback or tailnet/);
  assert.equal(config([claude({ capacityDiscovery: false })]).providers[0].capacityDiscovery, false);
  for (const capacityDiscovery of [null, "true", 1, {}]) assert.throws(() => config([{ ...local, capacityDiscovery }]), /must be boolean/);
});

test("automatic project trust requires an explicit boolean operator choice", () => {
  assert.equal(config([codex()]).trustAllProjects, undefined);
  for (const value of [true, false]) assert.equal(config([codex()], { trustAllProjects: value }).trustAllProjects, value);
  for (const value of [null, "true", 1, [], {}]) assert.throws(() => config([codex()], { trustAllProjects: value }), /trustAllProjects must be boolean/);
});

test("mid-turn model switching is off unless the operator sets it to true", () => {
  assert.equal(config([codex()]).midTurnModelSwitch, undefined);
  assert.equal(config([codex()], { midTurnModelSwitch: false }).midTurnModelSwitch, undefined);
  assert.equal(config([codex()], { midTurnModelSwitch: true }).midTurnModelSwitch, true);
  for (const value of [null, "true", 1, [], {}]) assert.throws(() => config([codex()], { midTurnModelSwitch: value }), /midTurnModelSwitch must be boolean/);
});

test("bare-model defaults require subscription accounts and one boolean designation per vendor", () => {
  const first = codex({ defaultForBareModels: true });
  const second = codex({ id: "personal", models: { "personal/sol": "sol" }, defaultForBareModels: false });
  const configured = config([first, second, claude({ defaultForBareModels: true })]);
  assert.equal(configured.providers[0].defaultForBareModels, true);
  assert.equal(configured.providers[1].defaultForBareModels, false);
  assert.equal(configured.providers[2].defaultForBareModels, true);
  assert.throws(() => config([first, { ...second, defaultForBareModels: true }]), /Only one codex-subscription/);
  assert.throws(() => config([claude({ defaultForBareModels: true }), claude({ id: "claude2", models: { other: "other" }, defaultForBareModels: true })]), /Only one claude-subscription/);
  for (const value of [null, 0, 1, "true", [], {}]) assert.throws(() => config([{ ...first, defaultForBareModels: value }]), /must be boolean/);
  for (const type of ["responses-api", "anthropic-api", "chat-completions-api"] as const) {
    for (const value of [false, true]) assert.throws(() => config([{ ...first, type, baseUrl: "https://example.test/v1", defaultForBareModels: value }]), /only valid for codex-subscription or claude-subscription/);
  }
});

test("claudeSessions is optional, defaulted, limited and only valid on Claude subscriptions", () => {
  const gib = 1024 ** 3;
  // The default cap is a tenth of RAM in 300 MB slots, clamped to 6..32: small Macs keep today's 6.
  assert.deepEqual(claudeSessionSettings(claude(), 8 * gib), { mode: "live", max: 6, parkMinutes: 60, warmup: 1, replayFormat: "text" });
  assert.deepEqual([claudeSessionMax(16 * gib), claudeSessionMax(64 * gib), claudeSessionMax(256 * gib), claudeSessionMax(gib)], [6, 21, 32, 6]);
  assert.deepEqual(claudeSessionSettings(claude(), 64 * gib), { mode: "live", max: 21, parkMinutes: 60, warmup: 1, replayFormat: "text" });
  assert.equal(claudeSessionSettings(claude({ claudeSessions: { max: 3 } }), 64 * gib).max, 3, "an explicit value wins over the memory default");
  assert.equal(claudeSessionSettings(claude()).max, claudeSessionMax(), "this machine's default comes from its own memory");
  const live = config([claude({ claudeSessions: { mode: "live", max: 16, parkMinutes: 5, warmup: 2, replayFormat: "json" } })]).providers[0];
  assert.deepEqual(claudeSessionSettings(live), { mode: "live", max: 16, parkMinutes: 5, warmup: 2, replayFormat: "json" });
  assert.deepEqual(claudeSessionSettings(config([claude({ claudeSessions: { max: 1, parkMinutes: 240 } })]).providers[0]), { mode: "live", max: 1, parkMinutes: 240, warmup: 1, replayFormat: "text" });
  for (const max of [33, 64, 128, Number.MAX_SAFE_INTEGER]) {
    assert.equal(claudeSessionSettings(config([claude({ claudeSessions: { max } })]).providers[0]).max, max);
  }
  for (const claudeSessions of [{ mode: "live-ish" }, { max: 0 }, { max: -1 }, { max: Number.MAX_SAFE_INTEGER + 1 }, { max: Infinity }, { max: NaN }, { max: "64" }, { max: 2.5 }, { parkMinutes: 4 }, { parkMinutes: 241 }, { warmup: -1 }, { warmup: 6 }, { warmup: 1.5 }, { warmup: "1" }, { replayFormat: "yaml" }, [], null, "live"]) {
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

test("sessionAffinity is an opt-in boolean accepted only on chat-completions-api providers", () => {
  const chat = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: "qwen", type: "chat-completions-api", baseUrl: "http://dgx.example:4000/v1", credentialFile: "qwen.token", models: { "qwen/flash": "qwen" }, tailnet: true, ...extra });
  assert.equal(config([chat()]).providers[0].sessionAffinity, undefined, "off unless configured");
  assert.equal(config([chat({ sessionAffinity: true })]).providers[0].sessionAffinity, true);
  assert.equal(config([chat({ sessionAffinity: false })]).providers[0].sessionAffinity, false);
  assert.throws(() => config([chat({ sessionAffinity: "yes" as unknown as boolean })]), /sessionAffinity must be boolean/);
  for (const type of ["responses-api", "anthropic-api", "claude-subscription", "codex-subscription", "copilot-subscription"] as const) {
    for (const sessionAffinity of [true, false]) assert.throws(() => config([chat({ type, tailnet: undefined, baseUrl: "https://api.example/v1", sessionAffinity, credentialFile: "x.token" })]), /sessionAffinity is only valid for chat-completions-api/, `${type} ${sessionAffinity}`);
  }
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
