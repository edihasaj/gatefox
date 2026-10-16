import test, { after } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { link, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGuardLimits, gatewayCatalogMessage, inspectBudgetMessage, nativeWritesViolation, type GatewayIdentity, type GuardLimits } from "../app-server-config-writes.js";
import { AppServerRouter } from "../app-server-router.js";
import type { GatewayConfig } from "../config.js";

/**
 * What the catalog guard costs and what it must never stop doing. The memo it keeps only caches an
 * answer, so a request that fills it still has every later path judged by the file it names. The
 * work one request may spend is bounded, counted in steps of a path walk and in file-system reads,
 * and a request that spends it all is refused whole instead of being checked by spelling alone. The
 * cost is asserted on the reads the guard makes, never on the clock, which a loaded machine stretches.
 */
const nativeAnswer = { status: "ok", version: "9", filePath: "/Users/dev/.codex/config.toml", overriddenMetadata: null };

const scratchFolders: string[] = [];
after(async () => { await Promise.all(scratchFolders.map(folder => rm(folder, { recursive: true, force: true }))); });
/** A new temporary folder, resolved so a spelling below it stays comparable. */
async function scratch(prefix: string): Promise<string> {
  const folder = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
  scratchFolders.push(folder);
  return folder;
}

/** A state directory holding the catalog, and the identity a guard is prepared from. */
async function gatewayTree() {
  const root = await scratch("gateway-budget-");
  const state = join(root, "state");
  await mkdir(state);
  const catalogPath = join(state, "codex-models.json");
  await writeFile(catalogPath, "{}");
  const identity: GatewayIdentity = { provider: "subscription_gateway", isGatewayModel: () => false,
    stateDirectory: state, catalogPath, homeDirectory: join(root, "home"), nativeHome: join(root, "native") };
  return { root, state, catalogPath, identity };
}

const catalogEdit = (value: string, keyPath = "model_catalog_json") => ({ keyPath, value, mergeStrategy: "upsert" });
/** `count` folders of the caller's own that exist, each with a file name that does not: distinct paths, one read each. */
const distinctPaths = (folder: string, count: number) => Array.from({ length: count }, (_, index) => catalogEdit(join(folder, `own-${index}.json`), `profiles.p${index}.model_catalog_json`));

/** Every other spelling of the gateway catalog that the file system itself equates with it. */
async function spellingsOfTheCatalog(tree: Awaited<ReturnType<typeof gatewayTree>>): Promise<Record<string, string>> {
  const spellings: Record<string, string> = {};
  spellings["hard link"] = join(tree.root, "hard-link.json");
  await link(tree.catalogPath, spellings["hard link"]);
  spellings.symlink = join(tree.root, "symlink.json");
  await symlink(tree.catalogPath, spellings.symlink);
  const upper = tree.catalogPath.replace(`${tree.root}/state/`, `${tree.root}/STATE/`);
  if (await stat(upper).then(() => true, () => false)) spellings["case variant"] = upper; // only a case-insensitive volume has one
  const firmlink = "/System/Volumes/Data" + tree.catalogPath;
  if (await stat(firmlink).then(() => true, () => false)) spellings.firmlink = firmlink; // only a macOS data volume has one
  return spellings;
}

test("a full memo never lets a spelling of the gateway catalog through", async () => {
  const tree = await gatewayTree();
  const spellings = await spellingsOfTheCatalog(tree);
  assert.ok(Object.keys(spellings).length >= 2, "at least the hard link and the symlink exist on every volume");
  const own = join(tree.root, "own");
  await mkdir(own);
  // Past the memo's size every read is recomputed, so what follows is judged as if the memo were empty.
  const unlimited = 1_000_000;
  const cases: [string, number, unknown[]][] = [["a memo of 4096", 4096, distinctPaths(own, 4200)]];
  // Fifteen deep paths, as a reviewer's batch carries them: each prefix of each one takes a place in the memo.
  const deep = join(tree.root, ...Array.from({ length: 140 }, (_, level) => `d${level}`));
  await mkdir(deep, { recursive: true });
  cases.push(["a small memo and deep paths", 64, Array.from({ length: 15 }, (_, index) => catalogEdit(join(deep, `leaf-${index}`, "x.json"), `profiles.p${index}.model_catalog_json`))]);
  for (const [label, memo, filler] of cases) {
    assert.equal(nativeWritesViolation(filler, tree.identity, { memo, budget: unlimited }), undefined, `${label}: paths of the caller's own are fine`);
    for (const [name, spelling] of Object.entries(spellings)) {
      assert.equal(nativeWritesViolation([...filler, catalogEdit(spelling)], tree.identity, { memo, budget: unlimited }), gatewayCatalogMessage,
        `${label}: the ${name} is refused after the memo is full`);
    }
    // A file the engine would create inside the gateway's folder is refused the same way.
    assert.equal(nativeWritesViolation([...filler, catalogEdit(join(tree.state, "not-written", "later.json"))], tree.identity, { memo, budget: unlimited }), gatewayCatalogMessage,
      `${label}: a new file below the state directory is refused after the memo is full`);
  }
});

test("a request that names more paths than the budget allows is refused whole", async () => {
  const tree = await gatewayTree();
  const own = join(tree.root, "own");
  await mkdir(own);
  const many = distinctPaths(own, 5000);
  // The budget holds the real cost down; it does not stand in for the identity check, so the catalog
  // behind the same filler is refused by the budget and never judged by its spelling.
  assert.equal(nativeWritesViolation(many, tree.identity), inspectBudgetMessage);
  assert.equal(nativeWritesViolation([...many, catalogEdit(tree.catalogPath)], tree.identity), inspectBudgetMessage);
  assert.equal(nativeWritesViolation([...many.slice(0, 100), catalogEdit(tree.catalogPath)], tree.identity), gatewayCatalogMessage, "a real batch is still judged on the file");
  assert.equal(nativeWritesViolation(many.slice(0, 100), tree.identity), undefined, "and a real batch of the caller's own is forwarded");
  assert.equal(nativeWritesViolation(many, tree.identity, { memo: 4096, budget: 100_000_000 }), undefined, "the same paths pass when the budget allows them");
  assert.ok(!inspectBudgetMessage.includes(own) && !inspectBudgetMessage.includes(tree.root), "the refusal names no path");
});

/** The longest stretch the event loop went without running a timer while `work` ran. Only a diagnostic. */
async function worstBlock(work: () => Promise<unknown>): Promise<{ worst: number; total: number }> {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 5);
  const started = performance.now();
  try { await work(); } finally {
    await new Promise(done => setTimeout(done, 20)); // let a pending tick report the gap
    clearInterval(timer);
  }
  return { worst, total: performance.now() - started };
}

/** Limits that count every file-system read the guard really makes. */
function counting(base: Partial<GuardLimits> = {}) {
  const reads = { stat: 0, lstat: 0, readlink: 0 };
  const limits: GuardLimits = { ...defaultGuardLimits, ...base, observe: operation => { reads[operation]++; } };
  return { reads, limits, total: () => reads.stat + reads.lstat + reads.readlink };
}

/** The deepest folder of one-letter names the platform opens below `root`, a path of at most `maxBytes`
 * (macOS stops at 1024 bytes, Linux at 4096). One folder is a single `mkdir`, so the tree is cheap. */
async function deepestFolder(root: string, maxBytes: number): Promise<{ folder: string; levels: number }> {
  let levels = Math.floor((maxBytes - Buffer.byteLength(root) - 48) / 2);
  for (;;) {
    const folder = join(root, ...Array.from({ length: levels }, () => "d"));
    try { await mkdir(folder, { recursive: true }); return { folder, levels }; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENAMETOOLONG" || levels < 20) throw error;
      levels -= 10;
    }
  }
}
const platformPathBytes = process.platform === "linux" ? 4096 : 1024;

async function routerOver(tree: Awaited<ReturnType<typeof gatewayTree>>) {
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: tree.state, providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { "claude/model": "model" }, modelMetadata: { "claude/model": { reasoningEfforts: ["low"] } } },
  ] };
  const calls: string[] = [];
  const backend = async (method: string): Promise<Record<string, unknown>> => { calls.push(method); return method.startsWith("config/") ? nativeAnswer : { status: "ok" }; };
  const router = new AppServerRouter(config, backend, undefined, undefined, tree.root);
  await router.initialize();
  return { router, calls };
}

test("20k distinct paths in the deepest tree never cost more than the budget in reads", async t => {
  const tree = await gatewayTree();
  const f = await routerOver(tree);
  const { folder: deep, levels } = await deepestFolder(tree.root, platformPathBytes);
  assert.ok(levels >= 100, `the platform opens a deep tree (${levels} levels)`);
  // Folders that exist below the deep one give leaves different deepest ancestors, the case a memo helps least.
  const existing = 300;
  await Promise.all(Array.from({ length: existing }, (_, index) => mkdir(join(deep, `e${index}`))));
  const edits = Array.from({ length: 20_000 }, (_, index) =>
    catalogEdit(join(deep, index < existing ? `e${index}` : `m${index}`, "catalog.json"), `profiles.p${index}.model_catalog_json`));
  // With the memo off every step is read from the file system: the most work the budget can buy.
  for (const memo of [defaultGuardLimits.memo, 0]) {
    const counted = counting({ memo });
    assert.equal(nativeWritesViolation(edits, tree.identity, counted.limits), inspectBudgetMessage, `memo ${memo}: refused by the budget`);
    assert.ok(counted.total() <= defaultGuardLimits.budget, `memo ${memo}: ${counted.total()} reads stay within the budget of ${defaultGuardLimits.budget}`);
    assert.ok(counted.total() > 0, "the guard did read the file system");
  }
  const { worst, total } = await worstBlock(() => assert.rejects(f.router.request("config/batchWrite", { edits }), { message: inspectBudgetMessage }));
  assert.equal(f.calls.length, 0, "the refused request forwarded nothing");
  t.diagnostic(`20k paths ${levels} levels deep: refused in ${total.toFixed(0)}ms, event loop blocked at most ${worst.toFixed(0)}ms`);
});

test("a deep path costs a unit for every folder it passes, remembered or not", async () => {
  const tree = await gatewayTree();
  const { folder: deep, levels } = await deepestFolder(tree.root, platformPathBytes);
  const leaves = Array.from({ length: 10 }, (_, index) => catalogEdit(join(deep, `leaf-${index}`, "catalog.json"), `profiles.p${index}.model_catalog_json`));
  // One path walks `levels` folders at least once; ten leaves in one folder repeat that walk ten times,
  // so a budget of a few walks is spent although only the first walk reads anything.
  const walk = levels + 1;
  assert.equal(nativeWritesViolation(leaves.slice(0, 1), tree.identity, { memo: 4096, budget: 20 * walk }), undefined, "one deep path fits");
  assert.equal(nativeWritesViolation(leaves, tree.identity, { memo: 4096, budget: 3 * walk }), inspectBudgetMessage, "ten walks of remembered folders still spend the budget");
  const counted = counting({ memo: 4096, budget: 3 * walk });
  nativeWritesViolation(leaves, tree.identity, counted.limits);
  assert.ok(counted.total() < 3 * walk, "and the remembered folders were not read again");
  assert.equal(nativeWritesViolation([leaves[0]!, leaves[0]!, leaves[0]!, leaves[0]!], tree.identity, { memo: 4096, budget: 20 * walk }), undefined, "a repeated identical path is free once answered");
  const repeated = counting({ memo: 4096, budget: 20 * walk });
  nativeWritesViolation([leaves[0]!], tree.identity, repeated.limits);
  const once = repeated.total();
  const again = counting({ memo: 4096, budget: 20 * walk });
  nativeWritesViolation(Array.from({ length: 500 }, () => leaves[0]!), tree.identity, again.limits);
  assert.equal(again.total(), once, "500 copies of one path read the file system as often as one");
});

test("links are followed one step at a time, each charged to the budget", async () => {
  const tree = await gatewayTree();
  const { folder: deep } = await deepestFolder(tree.root, platformPathBytes);
  // Every link leads to the deep folder, so a resolver that read a whole path for one unit would spend hundreds of reads per link.
  const fan = join(tree.root, "fan");
  await mkdir(fan);
  await Promise.all(Array.from({ length: 60 }, (_, index) => symlink(deep, join(fan, `l${index}`))));
  const edits = Array.from({ length: 5000 }, (_, index) => catalogEdit(join(fan, `l${index % 60}`, `m${index}`, "catalog.json"), `profiles.p${index}.model_catalog_json`));
  const counted = counting({ memo: 0 });
  assert.equal(nativeWritesViolation(edits, tree.identity, counted.limits), inspectBudgetMessage);
  assert.ok(counted.total() <= defaultGuardLimits.budget, `${counted.total()} reads stay within the budget`);
  // A link that leads back to itself is followed at most 40 times, then given up on: forwarded, not refused and not hung.
  const loop = join(tree.root, "loop");
  await symlink(loop, loop);
  const looped = counting();
  assert.equal(nativeWritesViolation([catalogEdit(join(loop, "x.json"))], tree.identity, looped.limits), undefined);
  assert.ok(looped.total() < 100, "a loop of links is cut off, not walked to the budget");
});

test("a chain of links, a relative one among them, still leads to the gateway's folder", async () => {
  const tree = await gatewayTree();
  const up = join(tree.root, "a");
  await mkdir(up);
  await symlink("../state", join(up, "up")); // relative, climbs out of its own folder
  const second = join(tree.root, "second");
  await symlink(join(up, "up"), second); // absolute, to a link
  const third = join(tree.root, "third");
  await symlink("second", third); // relative, to a link
  assert.equal(nativeWritesViolation([catalogEdit(join(third, "codex-models.json"))], tree.identity), gatewayCatalogMessage);
  assert.equal(nativeWritesViolation([catalogEdit(join(third, "not-written", "x.json"))], tree.identity), gatewayCatalogMessage);
  assert.equal(nativeWritesViolation([catalogEdit(join(tree.root, "a", "other.json"))], tree.identity), undefined, "a neighbour is the caller's own");
});

test("a real batch of 50 edits stays well inside the budget", async () => {
  const tree = await gatewayTree();
  const f = await routerOver(tree);
  // About 12 folders of the caller's own, under a temporary folder that is already several deep.
  const base = join(tree.root, ...Array.from({ length: 12 }, (_, level) => `d${level}`));
  await mkdir(base, { recursive: true });
  // Fifty profiles, each with a catalog file of its own in a folder of its own: more than a settings screen sends.
  await Promise.all(Array.from({ length: 50 }, (_, index) => mkdir(join(base, `profile-${index}`))));
  const edits = Array.from({ length: 50 }, (_, index) => catalogEdit(join(base, `profile-${index}`, "catalog.json"), `profiles.p${index}.model_catalog_json`));
  const counted = counting({ budget: defaultGuardLimits.budget / 2 });
  assert.equal(nativeWritesViolation(edits, tree.identity, counted.limits), undefined, "half the real budget is enough");
  assert.equal(await f.router.request("config/batchWrite", { edits }), nativeAnswer, "the batch reaches the engine");
  // What ChatGPT sends: one or two catalog paths of about ten folders.
  const home = join(base, "profile-0", "catalog.json");
  assert.equal(nativeWritesViolation([catalogEdit(home), catalogEdit(join(base, "profile-1", "catalog.json"))], tree.identity,
    { memo: 4096, budget: defaultGuardLimits.budget / 64 }), undefined, "two paths use a small fraction of the budget");
});

test("a path up to 4096 bytes is judged by the file it names on every platform", async () => {
  const tree = await gatewayTree();
  const link = join(tree.root, "state-link");
  await symlink(tree.state, link);
  const long = (bytes: number) => Array.from({ length: Math.ceil(bytes / 101) }, (_, index) => `${index}`.padEnd(100, "n")).join("/");
  // About 2000 bytes: past what macOS opens, within what Linux does. The folder it begins in is the state directory.
  const inside = join(link, long(2000));
  assert.ok(Buffer.byteLength(inside) > 1024 && Buffer.byteLength(inside) < 4096);
  assert.equal(nativeWritesViolation([catalogEdit(inside)], tree.identity), gatewayCatalogMessage, "judged by its existing ancestor, not by its spelling");
  const elsewhere = join(tree.root, "own", long(2000));
  assert.equal(nativeWritesViolation([catalogEdit(elsewhere)], tree.identity), undefined, "a long path of the caller's own is forwarded");
  // Past 4096 bytes nothing is walked: the spelling alone decides, so the same shape behind a link is not recognized.
  const past = join(link, long(4200));
  assert.equal(nativeWritesViolation([catalogEdit(past)], tree.identity), undefined);
  assert.equal(nativeWritesViolation([catalogEdit(join(tree.state, long(4200)))], tree.identity), gatewayCatalogMessage, "but a spelled gateway path is still refused");
});
