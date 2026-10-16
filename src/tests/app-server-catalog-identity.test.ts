import test, { after } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { link, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import { defaultGuardLimits, nativeWritesViolation, type GatewayIdentity, type GuardLimits } from "../app-server-config-writes.js";
import type { GatewayConfig } from "../config.js";

/**
 * How the `model_catalog_json` guard judges a path: as a file, not as a spelling. Device and inode
 * decide for anything that already exists, both spellings (written and resolved) decide for a file
 * the engine would create, and a path too long to walk is judged on its spelling alone.
 */
const catalog = "The gateway catalog cannot be saved into native Codex configuration";
const alias = "claude/model";
const nativeFile = "/Users/dev/.codex/config.toml";
const nativeAnswer = { status: "ok", version: "9", filePath: nativeFile, overriddenMetadata: null };

/** Every temporary tree a test makes, removed once the file is done so none is left behind. */
const scratchFolders: string[] = [];
after(async () => { await Promise.all(scratchFolders.map(folder => rm(folder, { recursive: true, force: true }))); });
/** A new temporary folder, resolved so a spelling below it stays comparable. */
async function scratch(prefix: string): Promise<string> {
  const folder = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
  scratchFolders.push(folder);
  return folder;
}

/** A refusal names its rule and nothing else: no key, no value, no path from the caller's request. */
const leaks = (message: string, values: unknown[]) =>
  values.some(value => typeof value === "string" && value.length > 1 && message.includes(value));

/** A temporary tree with the state directory inside it. */
async function fixture(nativeHome?: string) {
  const root = await scratch("gateway-catalog-identity-");
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
  /** The forwarded calls only, so a refusal that sent something anyway cannot hide. */
  const forwarded = () => calls.filter(call => call.method.startsWith("config/"));
  return { root, state, config, backend, router, calls, forwarded };
}

/** The identity the router builds for this fixture, and a counter of the file-system reads a guard makes. Cost is
 * asserted in reads, never in milliseconds, which a loaded machine stretches. */
const identityOf = (f: Awaited<ReturnType<typeof fixture>>): GatewayIdentity => ({ provider: "subscription_gateway", isGatewayModel: () => false,
  stateDirectory: f.state, catalogPath: f.router.catalogPath, homeDirectory: homedir(), nativeHome: f.root });
function counted() {
  const reads = { stat: 0, lstat: 0, readlink: 0 };
  const limits: GuardLimits = { ...defaultGuardLimits, observe: operation => { reads[operation]++; } };
  return { limits, total: () => reads.stat + reads.lstat + reads.readlink };
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
  assert.equal(await f.router.request("config/value/write", value(deep)), nativeAnswer, "64k components of the caller's own tree stay native");
  assert.equal(await f.router.request("config/value/write", value("/" + "x".repeat(128 * 1024))), nativeAnswer, "a 128 KB name is the caller's own");
  // Neither is walked: a path past the cutoff is judged on its spelling, so the file system is not read at all.
  const identity = identityOf(f);
  const baseline = counted(); // preparing the guard reads the gateway's own paths, whatever the batch holds
  nativeWritesViolation([], identity, baseline.limits);
  const reads = counted();
  const edit = (path: string) => [{ keyPath: "model_catalog_json", value: path, mergeStrategy: "upsert" }];
  assert.equal(nativeWritesViolation(edit(deep), identity, reads.limits), undefined);
  assert.equal(nativeWritesViolation(edit("/" + "x".repeat(128 * 1024)), identity, reads.limits), undefined);
  assert.equal(reads.total(), 2 * baseline.total(), "a path too long to walk costs no file-system read beyond preparing the guard");
  // The spelling alone still decides what a walk would have: below the state directory is gateway state.
  await assert.rejects(f.router.request("config/value/write", value(join(f.state, "x".repeat(4096)))),
    { message: catalog }, "a gateway path that is merely long is refused on its spelling");
});

test("a batch of 20k profiles is guarded in one pass", async () => {
  const f = await fixture();
  const edits = (relative: string) => Array.from({ length: 20_000 }, (_, index) =>
    ({ keyPath: `profiles.p${index}.model_catalog_json`, value: relative, mergeStrategy: "upsert" }));
  assert.equal(await f.router.request("config/batchWrite", { edits: edits("own/catalog.json") }), nativeAnswer,
    "a relative file of the caller's own is forwarded for every profile");
  assert.equal(f.calls.length, 1, "the whole batch reached the engine once");
  await assert.rejects(f.router.request("config/batchWrite", { edits: edits("state/codex-models.json") }),
    { message: catalog }, "the catalog spelled below the native home is refused however many profiles carry it");
  assert.equal(f.calls.length, 1, "the refused batch forwarded nothing more");
  // One pass: 20k profiles that repeat a path read the file system exactly as often as one profile does.
  const identity = identityOf(f);
  const reads = (count: number) => { const c = counted(); nativeWritesViolation(edits("own/catalog.json").slice(0, count), identity, c.limits); return c.total(); };
  assert.ok(reads(1) > 0, "the one profile does read the tree");
  assert.equal(reads(20_000), reads(1), "20k copies of one path add no read to the first");
});

test("the native home is the only base a relative catalog path reads against", async () => {
  const f = await fixture();
  // The engine expands a lone `~`, and `~/rest`, against the home directory.
  const homeSpelling = "~/" + relative(homedir(), f.router.catalogPath);
  await assert.rejects(f.router.request("config/value/write", { keyPath: "model_catalog_json", value: homeSpelling, mergeStrategy: "upsert" }),
    error => (error as Error).message === catalog && !leaks((error as Error).message, [f.router.catalogPath, f.state]));
  if (process.platform !== "win32") {
    // A slash is the only separator the engine trims after a tilde here, so a backslash starts a
    // name instead of expanding one: the `..` that follows climbs back out of that name and reads
    // the catalog all the same, and so does a doubled slash, which the engine collapses to one.
    const backslash = "\\";
    const climbed = relative(homedir(), f.router.catalogPath);
    for (const value of [`~/${backslash}/../${climbed}`, `~//${climbed}`]) {
      await assert.rejects(f.router.request("config/value/write", { keyPath: "model_catalog_json", value, mergeStrategy: "upsert" }),
        { message: catalog }, `${JSON.stringify(value)} is the catalog spelled from the home directory`);
    }
  }

  // A relative path is read below the native home, whatever the request's own filePath says: none,
  // a `~` spelling of the native config, and a symlink pointing at one all share that same base.
  const root = await scratch("gateway-native-base-");
  const state = join(root, "state");
  const nativeHome = join(root, "native-home");
  await mkdir(state); await mkdir(nativeHome);
  const scoped = new AppServerRouter({ ...f.config, stateDirectory: state }, f.backend, undefined, undefined, nativeHome);
  const aliasConfig = join(root, "native-config-link.toml");
  await symlink(join(nativeHome, "config.toml"), aliasConfig);
  const climbing = relative(nativeHome, scoped.catalogPath); // ../state/codex-models.json
  assert.ok(climbing.startsWith("../"), `the catalog spelled below the native home: ${climbing}`);
  for (const filePath of [undefined, "~/.codex/config.toml", aliasConfig]) {
    const edit = { keyPath: "model_catalog_json", value: climbing, ...(filePath ? { filePath } : {}), mergeStrategy: "upsert" };
    await assert.rejects(scoped.request("config/value/write", structuredClone(edit)), { message: catalog },
      `the catalog reached from the native home is refused with filePath ${String(filePath)}`);
  }
  // A symlinked native home is that same home once the guard resolves it.
  const homeAlias = join(root, "native-home-link");
  await symlink(nativeHome, homeAlias);
  await assert.rejects(new AppServerRouter({ ...f.config, stateDirectory: state }, f.backend, undefined, undefined, homeAlias)
    .request("config/value/write", { keyPath: "model_catalog_json", value: climbing, mergeStrategy: "upsert" }),
    { message: catalog }, "a ../ spelling of the catalog is refused however the native home is spelled");
  assert.deepEqual(f.calls, [], "none of the refusals forwarded anything");

  // The caller's own files stay native: one beside the config the write targets, one the engine
  // expands onto the home directory, and two that only look like one: a backslash expands nowhere
  // outside Windows, and a tilde with no separator after it is just the first character of a name.
  for (const value of ["elsewhere.json", "~/elsewhere.json", "~.x/foo.json", "~\\elsewhere.json"]) {
    const edit = { keyPath: "model_catalog_json", value, filePath: nativeFile, mergeStrategy: "upsert" };
    const sent = structuredClone(edit);
    assert.equal(await scoped.request("config/value/write", edit), nativeAnswer, `${value} stays the caller's own file`);
    assert.deepEqual(f.calls.at(-1), { method: "config/value/write", params: sent }, `${value} is forwarded as it was sent`);
  }
});

test("the catalog guard compares the file a path names, not its spelling", async () => {
  const f = await fixture();
  const root = await scratch("gateway-catalog-identity-");
  // One refusal per spelling, and nothing reaches the engine for any of them.
  const refused = (router: AppServerRouter, value: string, note: string) =>
    assert.rejects(router.request("config/value/write", { keyPath: "model_catalog_json", value, mergeStrategy: "upsert" }),
      error => (error as Error).message === catalog && !leaks((error as Error).message, [f.router.catalogPath, f.state]), note);
  const sent = () => f.forwarded().length;

  // A state directory behind a link is that directory: the guard reads a path through the links it
  // crosses, so the catalog is refused whichever spelling of it the caller sends.
  const realState = join(root, "real-state");
  const stateLink = join(root, "state-link");
  await mkdir(realState); await symlink(realState, stateLink);
  await refused(new AppServerRouter({ ...f.config, stateDirectory: stateLink }, f.backend), join(realState, "codex-models.json"),
    "the catalog spelled through the directory a link leads to");
  await refused(new AppServerRouter({ ...f.config, stateDirectory: realState }, f.backend), join(stateLink, "codex-models.json"),
    "the same catalog spelled through the link itself");
  await refused(new AppServerRouter({ ...f.config, stateDirectory: realState }, f.backend), join(stateLink, "anything.json"),
    "any file inside the state directory, reached through its link");

  // A native home behind a link is that home, so a relative value is read against both spellings of
  // it: the place the link itself holds in the tree, and the directory the link leads to.
  const deepHome = join(root, "deep", "native-home");
  const deepState = join(root, "deep", "state");
  const shallowState = join(root, "state");
  await mkdir(deepHome, { recursive: true }); await mkdir(deepState); await mkdir(shallowState);
  const homeLink = join(root, "native-home-link");
  await symlink(deepHome, homeLink);
  const climbing = "../state/codex-models.json";
  await refused(new AppServerRouter({ ...f.config, stateDirectory: deepState }, f.backend, undefined, undefined, homeLink), climbing,
    "the catalog below the home a link leads to, which only the resolved home reaches");
  await refused(new AppServerRouter({ ...f.config, stateDirectory: shallowState }, f.backend, undefined, undefined, homeLink), climbing,
    "the catalog beside the link, which only the spelled home reaches");
  assert.equal(sent(), 0, "none of these refusals forwarded anything");

  // The caller's own files stay native across a link: the guard refuses the gateway's, not the folder.
  const linked = join(root, "elsewhere");
  await mkdir(linked); await symlink(linked, join(root, "elsewhere-link"));
  const before = sent();
  assert.equal(await new AppServerRouter({ ...f.config, stateDirectory: shallowState }, f.backend).request("config/value/write",
    { keyPath: "model_catalog_json", value: join(root, "elsewhere-link", "catalog.json"), mergeStrategy: "upsert" }), nativeAnswer,
    "a catalog of the caller's own, behind a link, is still the caller's own");
  assert.equal(sent(), before + 1);
});
