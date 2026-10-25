#!/usr/bin/env node
// Opt-in check of API mode against the real signed engine, in a throwaway native home.
//
//   node scripts/e2e-api-mode-native-config.mjs --codex /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --root /tmp/FRESH
//
// Nothing here launches the app, registers a desktop adapter, or touches a real `~/.codex`: the only state it writes is
// under `--root`, which must not exist. It runs the real `on` and `off` logic over a real JSON-RPC connection to the
// engine, with register/unregister and the app-running probe stubbed out, and then reads the resulting `config.toml`
// to prove the round trip: API mode's keys appear and disappear, the user's own keys and comments never move, and a key
// that was absent comes back absent rather than empty.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { desktopApiMode } from "../dist/desktop-api-mode.js";
import { openNativeConfig } from "../dist/desktop-api-mode-native.js";
import { nativeEngineExecutable } from "../dist/native-engine-path.js";
import { writePrivateJson } from "../dist/config.js";

const argv = process.argv.slice(2);
const flag = (name) => { const at = argv.indexOf(`--${name}`); return at < 0 ? undefined : argv[at + 1]; };
const codex = flag("codex"); const root = flag("root") ? resolve(flag("root")) : undefined;
if (!codex || !root) { console.error("usage: node scripts/e2e-api-mode-native-config.mjs --codex PATH --root /tmp/FRESH"); process.exit(2); }
if (existsSync(root)) { console.error(`refusing to run: --root ${root} already exists`); process.exit(2); }
// The app's own state is never in reach here: `appRunning` is injected false, and the only native home this touches is
// the one under `--root`, so a running ChatGPT is not disturbed and does not have to be quit first.

const home = join(root, "home"); const state = join(root, "state");
await mkdir(home, { recursive: true, mode: 0o700 });
const original = [
  "# a comment API mode must never touch",
  'model = "gpt-5.1"',
  'model_reasoning_summary = "auto"',
  "",
  "[model_providers.other]",
  'name = "Other"',
  'base_url = "http://127.0.0.1:9/v1"',
  'wire_api = "responses"',
  "",
].join("\n");
await writeFile(join(home, "config.toml"), original);
const configPath = join(root, "gateway.json");
await writePrivateJson(configPath, { version: 1, port: 3457, stateDirectory: state,
  providers: [{ id: "api", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "HG_E2E_UNUSED_KEY", models: { "e2e-model": "upstream" } }] });

const engine = await nativeEngineExecutable(resolve(codex));
const deps = {
  native: async nativeHome => await openNativeConfig(engine, nativeHome),
  appRunning: async () => false,
  nativeHome: () => home,
  cliPathOwner: async () => "none",
  clearCliPath: async () => { throw new Error("this check never touches the login session"); },
  presetEnv: async () => "skipped",
  now: () => new Date(),
};

const toml = async () => await readFile(join(home, "config.toml"), "utf8");
const receipt = async () => JSON.parse(await readFile(join(state, "api-mode.json"), "utf8"));
const says = (label, ok, detail) => { console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`); if (!ok) process.exitCode = 1; };

// on
const on = await desktopApiMode("on", configPath, {}, deps);
const after = await toml();
says("on returns the model it selected", on.model === "e2e-model" && on.mode === "api", JSON.stringify(on));
says("the user's comment survived", after.includes("# a comment API mode must never touch"));
says("the unrelated provider table survived", after.includes("[model_providers.other]") && after.includes('base_url = "http://127.0.0.1:9/v1"'));
says("model_reasoning_summary is untouched", /^\s*model_reasoning_summary = "auto"$/m.test(after));
says("the gateway provider is in the native file", after.includes("[model_providers.harness_gateway]") && after.includes('wire_api = "responses"') && after.includes("stream_idle_timeout_ms = 90000"));
says("the selection points at it", after.includes('model_provider = "harness_gateway"') && after.includes(`model = "e2e-model"`));
says("the catalog path is this gateway's own file", after.includes(join(state, "api-mode-models.json")));
const catalog = JSON.parse(await readFile(join(state, "api-mode-models.json"), "utf8"));
says("the catalog holds the configured alias", catalog.models.length === 1 && catalog.models[0].slug === "e2e-model");
const stored = await receipt();
says("the receipt remembers only what was there", stored.original.model === "gpt-5.1" && !("model_provider" in stored.original) && !("model_catalog_json" in stored.original), JSON.stringify(stored.original));
says("the receipt found no provider table", stored.providerTableExisted === false && stored.nativeHome === home && stored.cliPathCleared === false);
says("receipt and catalog are private", (await stat(join(state, "api-mode.json"))).mode % 0o1000 === 0o600 && (await stat(join(state, "api-mode-models.json"))).mode % 0o1000 === 0o600);
const status = await desktopApiMode("status", configPath, {}, deps);
says("status reads the same answer from the engine", status.mode === "api" && status.receipt === true && status.nativeProviderMatches === true && status.catalogPresent === true && status.cliPathOverride === "none", JSON.stringify(status));

// The engine refuses to read a configuration whose catalog is missing or empty, so this proves the file API mode
// writes is the one the app will actually load, and that a broken one is reported rather than thrown at a caller.
await writeFile(join(state, "api-mode-models.json"), '{"models":[]}\n');
const broken = await desktopApiMode("status", configPath, {}, deps);
says("a catalog the engine cannot load shows up as a mismatch, not a crash", broken.mode === "api" && broken.nativeProviderMatches === false && broken.catalogPresent === true);
await writePrivateJson(join(state, "api-mode-models.json"), catalog);
says("and the same read passes once the catalog is whole", (await desktopApiMode("status", configPath, {}, deps)).nativeProviderMatches === true);

// off
const off = await desktopApiMode("off", configPath, {}, deps);
const back = await toml();
says("off reports what it restored", off.mode === "adapter" && off.restored.includes("model") && off.restored.includes("model_provider") && off.restored.includes("model_catalog_json") && off.changedSinceEnable.length === 0, JSON.stringify(off));
says("the original model is back", /^\s*model = "gpt-5.1"$/m.test(back), back.split("\n").filter(l => l.startsWith("model")).join(" | "));
says("a key that was absent is absent again", !/^\s*model_provider\s*=/m.test(back) && !/^\s*model_catalog_json\s*=/m.test(back));
says("the provider table API mode created is gone", !back.includes("harness_gateway"));
says("the user's file is otherwise as it was", back.includes("# a comment API mode must never touch") && /^\s*model_reasoning_summary = "auto"$/m.test(back) && back.includes("[model_providers.other]"));
says("the receipt is gone", existsSync(join(state, "api-mode.json")) === false);
says("status says the desktop is back", (await desktopApiMode("status", configPath, {}, deps)).mode === "neither");

// A second cycle, and a key the user moved while API mode was on, which `off` must leave where they left it.
says("API mode can be turned on again after it is turned off", (await desktopApiMode("on", configPath, {}, deps)).mode === "api");
{
  const client = await deps.native(home, "/Applications/ChatGPT.app");
  const read = await client.read();
  await client.write([{ keyPath: "model", value: "someone-elses-choice", mergeStrategy: "replace" }], read.version);
  await client.close();
}
const offAgain = await desktopApiMode("off", configPath, {}, deps);
says("off leaves a key the user changed, and says so", offAgain.changedSinceEnable.includes("model") && offAgain.restored.includes("model_provider"), JSON.stringify(offAgain));
says("that choice survives", (await toml()).includes('model = "someone-elses-choice"'));
console.log(process.exitCode ? "FAILED" : "PASSED");
