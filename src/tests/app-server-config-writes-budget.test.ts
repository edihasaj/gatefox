import test, { after } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { link, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayCatalogMessage, inspectBudgetMessage, nativeWritesViolation, type GatewayIdentity } from "../app-server-config-writes.js";
import { AppServerRouter } from "../app-server-router.js";
import type { GatewayConfig } from "../config.js";

/**
 * What the catalog guard costs and what it must never stop doing. The memo it keeps only caches an
 * answer, so a request that fills it still has every later path judged by the file it names. The
 * work one request may spend on the file system is bounded, and a request that spends it all is
 * refused whole instead of being checked by spelling alone.
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
  assert.equal(nativeWritesViolation(many, tree.identity, { memo: 4096, budget: 100_000 }), undefined, "the same paths pass when the budget allows them");
  assert.ok(!inspectBudgetMessage.includes(own) && !inspectBudgetMessage.includes(tree.root), "the refusal names no path");
});

/** The longest stretch the event loop went without running a timer while `work` ran. */
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

test("20k distinct deep paths never block the event loop for a second", async t => {
  const tree = await gatewayTree();
  const f = await routerOver(tree);
  // A deep folder, as deep as a reviewer's path (about 750 bytes), with real folders below it so every
  // path has a different deepest ancestor to resolve; that is the costliest shape the guard can meet.
  const deep = join(tree.root, ...Array.from({ length: 140 }, (_, level) => `d${level}`));
  await mkdir(deep, { recursive: true });
  const existing = 1500;
  await Promise.all(Array.from({ length: existing }, (_, index) => mkdir(join(deep, `e${index}`))));
  const edits = Array.from({ length: 20_000 }, (_, index) =>
    catalogEdit(join(deep, index < existing ? `e${index}` : `m${index}`, "catalog.json"), `profiles.p${index}.model_catalog_json`));
  const { worst, total } = await worstBlock(() => assert.rejects(f.router.request("config/batchWrite", { edits }), { message: inspectBudgetMessage }));
  assert.equal(f.calls.length, 0, "the refused request forwarded nothing");
  assert.ok(worst < 1000, `the event loop was blocked for ${worst.toFixed(0)}ms of ${total.toFixed(0)}ms`);
  t.diagnostic(`20k deep paths: refused in ${total.toFixed(0)}ms, event loop blocked at most ${worst.toFixed(0)}ms`);
});

test("a real batch of 50 edits stays well inside the budget", async () => {
  const tree = await gatewayTree();
  const f = await routerOver(tree);
  const deep = join(tree.root, ...Array.from({ length: 140 }, (_, level) => `d${level}`));
  await mkdir(deep, { recursive: true });
  // Fifty profiles, each with a catalog file of its own in a folder of its own, all deep: the most a
  // settings screen sends, and the costliest shape for it.
  await Promise.all(Array.from({ length: 50 }, (_, index) => mkdir(join(deep, `profile-${index}`))));
  const edits = Array.from({ length: 50 }, (_, index) => catalogEdit(join(deep, `profile-${index}`, "catalog.json"), `profiles.p${index}.model_catalog_json`));
  // Half the real budget is already enough, so a batch of this size has room to spare.
  assert.equal(nativeWritesViolation(edits, tree.identity, { memo: 4096, budget: 1024 }), undefined);
  assert.equal(await f.router.request("config/batchWrite", { edits }), nativeAnswer, "the batch reaches the engine");
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
