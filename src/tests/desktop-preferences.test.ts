import test from "node:test";
import assert from "node:assert/strict";
import { applyDesktopEdits, isDesktopPreferenceKey, mergeDesktopPreferences, readDesktopPreferences } from "../desktop-preferences.js";

test("desktop-only reasoning settings survive JSON reload and retain native display settings", () => {
  const enabled = ["low", "medium", "high", "xhigh", "max", "ultra", "persistent"];
  const desktop = applyDesktopEdits({}, [
    { keyPath: "desktop.enabled-reasoning-efforts", value: enabled, mergeStrategy: "replace" },
    { keyPath: "desktop.show-ultra-in-model-picker-slider", value: true, mergeStrategy: "replace" },
    { keyPath: "desktop.followUpQueueMode", value: "steer", mergeStrategy: "replace" },
    { keyPath: "desktop.conversationDetailMode", value: "STEPS_COMMANDS", mergeStrategy: "replace" },
    { keyPath: "desktop.appearanceTheme", value: "dark", mergeStrategy: "replace" },
    { keyPath: "desktop.reduced-motion-preference", value: "system", mergeStrategy: "replace" },
    { keyPath: "desktop.confirm-before-close", value: "keyboardOnly", mergeStrategy: "replace" },
    { keyPath: "desktop.pagesFontSize", value: 16, mergeStrategy: "replace" },
    { keyPath: "desktop.browser-annotation-screenshots-mode", value: "necessary", mergeStrategy: "replace" },
    { keyPath: "desktop.open-in-target-preferences", value: { global: "vscode", perPath: { "/fixture": "terminal" } }, mergeStrategy: "replace" },
    { keyPath: "desktop.browser-family-enabled:chrome", value: true, mergeStrategy: "replace" },
  ]);
  const stored = JSON.parse(JSON.stringify({ desktop }));
  assert.equal(Object.hasOwn(stored, "model"), false);
  const reloaded = readDesktopPreferences(stored.desktop);
  const native = { model: "native", model_provider: "openai", desktop: { "unknown-native-option": true, appearanceTheme: "light" } };
  const result = mergeDesktopPreferences(native, reloaded);
  assert.deepEqual(result, { ...native, desktop: { ...native.desktop, ...desktop } });
  assert.deepEqual(reloaded["enabled-reasoning-efforts"], enabled);
  assert.equal(native.desktop.appearanceTheme, "light");
  enabled.pop();
  assert.deepEqual(desktop["enabled-reasoning-efforts"], reloaded["enabled-reasoning-efforts"]);
});

test("invalid desktop batches reject atomically without changing earlier settings", () => {
  const current = { "enabled-reasoning-efforts": ["low", "high", "max"], appearanceTheme: "dark" };
  const snapshot = structuredClone(current);
  const invalid = [
    { keyPath: "desktop.enabled-reasoning-efforts", value: ["high", "super-max"], mergeStrategy: "replace" },
    { keyPath: "desktop.enabled-reasoning-efforts", value: ["max", "max"], mergeStrategy: "replace" },
    { keyPath: "desktop.show-ultra-in-model-picker-slider", value: "true", mergeStrategy: "replace" },
    { keyPath: "desktop.followUpQueueMode", value: "automatic", mergeStrategy: "replace" },
    { keyPath: "desktop.sansFontSize", value: 99, mergeStrategy: "replace" },
    { keyPath: "desktop.appearanceTheme", value: "light", mergeStrategy: "delete" },
    { keyPath: "desktop.unrecognized-option", value: true, mergeStrategy: "replace" },
    { keyPath: "desktop.auth", value: { token: "fixture" }, mergeStrategy: "replace" },
    { keyPath: "sandbox_mode", value: "danger-full-access", mergeStrategy: "replace" },
  ];
  for (const edit of invalid) {
    assert.throws(() => applyDesktopEdits(current, [
      { keyPath: "desktop.appearanceTheme", value: "light", mergeStrategy: "replace" }, edit,
    ]));
    assert.deepEqual(current, snapshot);
  }
  assert.throws(() => readDesktopPreferences({ "show-ultra-in-model-picker-slider": 1 }), /Invalid value/);
});

test("appearance migration accepts bounded data but rejects executable, credential, and prototype fields", () => {
  const theme = { name: "Moss", colors: { accent: "#55756C" }, overrides: ["muted"] };
  const saved = applyDesktopEdits({}, [{ keyPath: "desktop.appearanceLightChromeTheme", value: theme, mergeStrategy: "replace" }]);
  theme.colors.accent = "#000000";
  assert.deepEqual(saved.appearanceLightChromeTheme, { name: "Moss", colors: { accent: "#55756C" }, overrides: ["muted"] });
  const forbidden = [
    { token: "fixture" }, { client_token: "fixture" }, { secret: "fixture" }, { credentials: {} }, { command: "fixture" },
    JSON.parse('{"__proto__":{"polluted":true}}'), { content: "x".repeat(4097) },
    { choices: Array(257).fill("moss") }, { number: Infinity }, { callback: () => undefined },
  ];
  for (const value of forbidden) assert.throws(() => applyDesktopEdits({}, [{
    keyPath: "desktop.appearanceLightChromeTheme", value, mergeStrategy: "replace",
  }]), /Invalid value/);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => readDesktopPreferences({ appearanceLightChromeTheme: cycle }), /Invalid value/);
  assert.equal(isDesktopPreferenceKey("desktop.enabled-reasoning-efforts"), true);
  assert.equal(isDesktopPreferenceKey("desktop.provider.auth"), false);
  assert.equal(isDesktopPreferenceKey("model_reasoning_effort"), false);
});
