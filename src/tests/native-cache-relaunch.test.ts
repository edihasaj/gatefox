import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appPathFromEngine, watchNativeCacheForRelaunch, type CacheRelaunchDeps, type CacheRelaunchOutcome } from "../native-cache-relaunch.js";

const app = "/Applications/ChatGPT.app";
const options = { cachePath: "/home/.codex/models_cache.json", sessionsDirectory: "/home/.codex/sessions", appPath: app, appPid: 100, startedAtMs: 1_000 };

function fake(overrides: Partial<CacheRelaunchDeps> = {}) {
  let tick: (() => void) | undefined; let stopped = false; const outcomes: CacheRelaunchOutcome[] = []; const relaunched: Array<[number, string]> = [];
  let ready = false;
  const deps: Partial<CacheRelaunchDeps> = {
    cacheReady: async () => ready, newestSessionMs: async () => undefined, parentCommand: async () => `${app}/Contents/MacOS/ChatGPT`,
    relaunch: (pid, path) => { relaunched.push([pid, path]); },
    every: (_ms, fn) => { tick = fn; return () => { stopped = true; }; },
    record: outcome => { outcomes.push(outcome); }, ...overrides,
  };
  const step = async () => { tick?.(); await new Promise(done => setImmediate(done)); await new Promise(done => setImmediate(done)); };
  return { deps, step, outcomes, relaunched, setReady: () => { ready = true; }, stopped: () => stopped };
}

test("the app bundle is found from its bundled engine path only", () => {
  assert.equal(appPathFromEngine("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"), "/Applications/ChatGPT.app");
  assert.equal(appPathFromEngine("/opt/homebrew/bin/codex"), undefined);
});

test("nothing happens until the native cache appears, then the app is reopened once", async () => {
  const f = fake(); watchNativeCacheForRelaunch(options, f.deps);
  await f.step(); await f.step();
  assert.deepEqual(f.relaunched, []); assert.deepEqual(f.outcomes, []);
  f.setReady(); await f.step(); await f.step();
  assert.deepEqual(f.relaunched, [[100, app]]); assert.deepEqual(f.outcomes, ["relaunched"]); assert.ok(f.stopped());
});

test("a chat started since the adapter began leaves the app alone", async () => {
  const f = fake({ newestSessionMs: async () => 1_500 }); f.setReady(); watchNativeCacheForRelaunch(options, f.deps);
  await f.step();
  assert.deepEqual(f.relaunched, []); assert.deepEqual(f.outcomes, ["chat_started"]);
});

test("an adapter whose parent is not that ChatGPT app never quits anything", async () => {
  for (const parent of [undefined, "/Applications/Other.app/Contents/MacOS/Other", `${app}/Contents/MacOS/ChatGPT --flag`]) {
    const f = fake({ parentCommand: async () => parent }); f.setReady(); watchNativeCacheForRelaunch(options, f.deps);
    await f.step();
    assert.deepEqual(f.relaunched, []); assert.deepEqual(f.outcomes, ["not_app"]);
  }
});

test("stopping before the cache appears records nothing", async () => {
  const f = fake(); const stop = watchNativeCacheForRelaunch(options, f.deps); stop(); f.setReady();
  await f.step();
  assert.deepEqual(f.relaunched, []); assert.deepEqual(f.outcomes, []);
});

test("the real readers accept only a cache with models and find the newest nested session file", async () => {
  const home = await mkdtemp(join(tmpdir(), "gw-cache-relaunch-")); const cache = join(home, "models_cache.json"); const sessions = join(home, "sessions");
  const recorded: CacheRelaunchOutcome[] = []; let tick: (() => void) | undefined;
  const watch = () => watchNativeCacheForRelaunch({ ...options, cachePath: cache, sessionsDirectory: sessions, startedAtMs: 5_000_000 },
    { parentCommand: async () => `${app}/Contents/MacOS/ChatGPT`, relaunch: () => {}, every: (_ms, fn) => { tick = fn; return () => {}; }, record: outcome => { recorded.push(outcome); } });
  const settle = () => new Promise(done => setTimeout(done, 50));
  watch(); await writeFile(cache, "{\"partial\": true}"); tick!(); await settle();
  assert.deepEqual(recorded, [], "a cache without models is not ready");
  await writeFile(cache, JSON.stringify({ models: [] })); await mkdir(join(sessions, "2026", "11", "17"), { recursive: true });
  const rollout = join(sessions, "2026", "11", "17", "rollout.jsonl"); await writeFile(rollout, "{}\n"); await utimes(rollout, 6_000, 6_000);
  tick!(); await settle();
  assert.deepEqual(recorded, ["chat_started"]);
});

test("desktop registration names the plain ChatGPT chat app instead of failing with ENOENT", async () => {
  const { requireCodexDesktopApp } = await import("../desktop-launch.js");
  const has = (paths: string[]) => async (path: string) => paths.includes(path);
  await assert.rejects(requireCodexDesktopApp(app, has([])), /No ChatGPT app at \/Applications\/ChatGPT\.app/);
  await assert.rejects(requireCodexDesktopApp(app, has([`${app}/Contents/MacOS/ChatGPT`])), /ChatGPT chat app without Codex.*openai\.com\/codex/);
  await requireCodexDesktopApp(app, has([`${app}/Contents/MacOS/ChatGPT`, `${app}/Contents/Resources/codex-cli/bin/codex`]));
});
