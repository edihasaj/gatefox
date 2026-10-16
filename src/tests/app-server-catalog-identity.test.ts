import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync, statSync } from "node:fs";
import { link, mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import type { GatewayConfig } from "../config.js";

/**
 * How the `model_catalog_json` guard judges a path: as a file, not as a spelling. Device and inode
 * decide for anything that already exists, both spellings (written and resolved) decide for a file
 * the engine would create, and a path too long to walk is judged on its spelling alone.
 */
const catalog = "The gateway catalog cannot be saved into native Codex configuration";
const alias = "claude/model";
const nativeAnswer = { status: "ok", version: "9", filePath: "/Users/dev/.codex/config.toml", overriddenMetadata: null };

/** A temporary tree, resolved so a spelling below it stays comparable, with the state directory inside it. */
async function fixture(nativeHome?: string) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "gateway-catalog-identity-")));
  const state = join(root, "state");
  await mkdir(state);
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: state, providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { [alias]: "model" }, modelMetadata: { [alias]: { reasoningEfforts: ["low"] } } },
  ] };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const backend = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    calls.push({ method, params });
    return method.startsWith("config/") ? nativeAnswer : { status: "ok" };
  };
  const router = new AppServerRouter(config, backend, undefined, undefined, nativeHome ?? root);
  await router.initialize(); // the catalog file itself is written here, so identity has something to read
  return { root, state, router, calls };
}

const exists = async (path: string) => { try { await stat(path); return true; } catch { return false; } };
const value = (path: string) => ({ keyPath: "model_catalog_json", value: path, mergeStrategy: "upsert" });

test("a catalog reached through another name for the same file is refused", async () => {
  const f = await fixture();
  // A hard link is the same file under a path that shares nothing with it: no spelling matches.
  const own = join(f.root, "caller-catalog.json");
  await link(f.router.catalogPath, own);
  await assert.rejects(f.router.request("config/value/write", value(own)),
    { message: catalog }, "the same inode under a path of the caller's own is the gateway catalog");
  // A file the engine would create is judged on the folders it walks through, so one inside the state
  // directory is gateway state whatever it is named, and one below the caller's own folder is not.
  await assert.rejects(f.router.request("config/value/write", value(join(f.state, "not-written", "deep.json"))),
    { message: catalog }, "a path whose existing ancestor is the state directory is inside it");
  const linked = join(f.root, "elsewhere");
  await mkdir(linked); await symlink(linked, join(f.root, "elsewhere-link"));
  assert.equal(await f.router.request("config/value/write", value(join(f.root, "elsewhere-link", "catalog.json"))), nativeAnswer,
    "a catalog of the caller's own, behind a link, is still the caller's own");
  assert.equal(f.calls.length, 1, "only the caller's own file reached the engine");
});

test("a case-variant spelling of the gateway catalog is refused", async () => {
  const f = await fixture();
  const probe = join(f.state, "Case-Probe-File");
  await writeFile(probe, "x");
  if (!await exists(join(f.state, "case-probe-file"))) return; // a case-sensitive volume cannot show this
  const variant = (path: string) => path.replace(`${f.root}/state/`, `${f.root}/STATE/`);
  await assert.rejects(f.router.request("config/value/write", value(variant(f.router.catalogPath))),
    { message: catalog }, "the catalog named with another casing of its folder");
  await assert.rejects(f.router.request("config/value/write", value(join(f.root, "STATE", "later.json"))),
    { message: catalog }, "a file the engine would create below another casing of the state directory");
  assert.deepEqual(f.calls, [], "neither spelling forwarded anything");
});

test("a firmlink spelling of the gateway catalog is refused", async () => {
  const f = await fixture();
  const firmlink = "/System/Volumes/Data" + f.router.catalogPath;
  if (!await exists(firmlink)) return; // only macOS data volumes carry this spelling of the same tree
  assert.equal((await stat(firmlink)).ino, (await stat(f.router.catalogPath)).ino, "both spellings name one file");
  await assert.rejects(f.router.request("config/value/write", value(firmlink)),
    { message: catalog }, "the catalog spelled from the other end of the firmlink is the same file");
  await assert.rejects(f.router.request("config/value/write", value("/System/Volumes/Data" + join(f.state, "later.json"))),
    { message: catalog }, "a file below the state directory spelled through the firmlink is gateway state");
  assert.deepEqual(f.calls, [], "neither spelling forwarded anything");
});

test("the catalog guard judges a long path without walking it", async () => {
  const f = await fixture();
  const deep = "/" + Array.from({ length: 32_000 }, (_, index) => `p${index}`).join("/"); // 64k path components
  let started = performance.now();
  assert.equal(await f.router.request("config/value/write", value(deep)), nativeAnswer, "64k components of the caller's own tree stay native");
  const deepMs = performance.now() - started;
  started = performance.now();
  assert.equal(await f.router.request("config/value/write", value("/" + "x".repeat(128 * 1024))), nativeAnswer, "a 128 KB name is the caller's own");
  const longMs = performance.now() - started;
  assert.ok(deepMs < 200 && longMs < 200, `a long value was judged in ${deepMs.toFixed(0)}ms and ${longMs.toFixed(0)}ms`);
  // The spelling alone still decides what a walk would have: below the state directory is gateway state.
  await assert.rejects(f.router.request("config/value/write", value(join(f.state, "x".repeat(4096)))),
    { message: catalog }, "a gateway path that is merely long is refused on its spelling");
});

test("a batch of 20k profiles is guarded in one pass", async () => {
  const f = await fixture();
  const edits = (relative: string) => Array.from({ length: 20_000 }, (_, index) =>
    ({ keyPath: `profiles.p${index}.model_catalog_json`, value: relative, mergeStrategy: "upsert" }));
  let started = performance.now();
  assert.equal(await f.router.request("config/batchWrite", { edits: edits("own/catalog.json") }), nativeAnswer,
    "a relative file of the caller's own is forwarded for every profile");
  const forwardedMs = performance.now() - started;
  assert.equal(f.calls.length, 1, "the whole batch reached the engine once");
  started = performance.now();
  await assert.rejects(f.router.request("config/batchWrite", { edits: edits("state/codex-models.json") }),
    { message: catalog }, "the catalog spelled below the native home is refused however many profiles carry it");
  const refusedMs = performance.now() - started;
  assert.equal(f.calls.length, 1, "the refused batch forwarded nothing more");
  assert.ok(forwardedMs < 200 && refusedMs < 200, `20k profiles were guarded in ${forwardedMs.toFixed(0)}ms and ${refusedMs.toFixed(0)}ms`);
});
