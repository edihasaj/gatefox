import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultGuardLimits, inspectBudgetMessage, joinBelow, nativeWritesViolation, pathValueUnits, prepareGatewayPaths, walkExisting,
  windowsCatalogMessage, type GatewayIdentity, type GuardLimits,
} from "../app-server-config-writes.js";

/**
 * The string work of a path value is paid for by its size, every time it is judged, and the resolver
 * is exact about the one thing it computes by hand: where the rest of a path goes below a resolved
 * folder. Everything is counted in units and reads, never in milliseconds, which a loaded machine stretches.
 */
const scratchFolders: string[] = [];
after(() => { for (const folder of scratchFolders) rmSync(folder, { recursive: true, force: true }); });
function scratch(prefix: string): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratchFolders.push(folder);
  return folder;
}
function treeIdentity(): { root: string; identity: GatewayIdentity } {
  const root = scratch("gateway-size-");
  const state = join(root, "state");
  mkdirSync(state);
  return { root, identity: { provider: "subscription_gateway", isGatewayModel: () => false,
    stateDirectory: state, catalogPath: join(state, "codex-models.json"), homeDirectory: join(root, "home"), nativeHome: join(root, "native") } };
}
const catalogEdit = (value: string, keyPath = "model_catalog_json") => ({ keyPath, value, mergeStrategy: "upsert" });
/** The least budget at which these edits are forwarded. */
function leastBudget(edits: unknown[], identity: GatewayIdentity): number {
  let low = 1;
  let high = 10_000_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (nativeWritesViolation(edits, identity, { memo: 4096, budget: middle }) === undefined) high = middle; else low = middle + 1;
  }
  return low;
}

/** About 4000 bytes, below the 4096 cutoff, so every one of them is walked. */
const longPath = (head: string) => head + "/a".repeat(1990);

test("a path value is charged 1 unit per full 64 characters, and a short name nothing", () => {
  assert.equal(pathValueUnits(""), 0);
  assert.equal(pathValueUnits("own/catalog.json"), 0);
  assert.equal(pathValueUnits("x".repeat(63)), 0);
  assert.equal(pathValueUnits("x".repeat(64)), 1);
  assert.equal(pathValueUnits("x".repeat(127)), 1);
  assert.equal(pathValueUnits("x".repeat(4000)), 62);
});

test("distinct ~4000-byte paths whose first folder is missing are refused by the budget, after a handful of reads", () => {
  const { identity } = treeIdentity();
  const edits = Array.from({ length: 3200 }, (_, index) => catalogEdit(longPath(`/zz-missing-${index}`), `profiles.p${index}.model_catalog_json`));
  assert.ok(Buffer.byteLength(edits[0]!.value) > 3900 && Buffer.byteLength(edits[0]!.value) < 4096);
  const units = pathValueUnits(edits[0]!.value);
  const reads = { stat: 0, lstat: 0, readlink: 0 };
  const limits: GuardLimits = { ...defaultGuardLimits, observe: operation => { reads[operation]++; } };
  assert.equal(nativeWritesViolation(edits, identity, limits), inspectBudgetMessage);
  // Each judged path pays `units` before any of it is resolved, so the budget stops the batch after at most
  // budget / units paths; each of those reads the file system only a few times (the first folder, once).
  const judged = defaultGuardLimits.budget / units;
  assert.ok(reads.stat <= 4 * judged + 16, `${reads.stat} stats for at most ${Math.floor(judged)} judged paths`);
  assert.ok(judged < 400, "a few hundred such paths spend the budget, not thousands");
  // A batch of such paths that a real request could send still goes through.
  assert.equal(nativeWritesViolation(edits.slice(0, 40), identity), undefined);
});

test("copies of one ~4000-byte path are charged every time, although their answer is remembered", () => {
  const { identity } = treeIdentity();
  const value = longPath("/zz-missing-same");
  const copies = (count: number) => Array.from({ length: count }, (_, index) => catalogEdit(value, `profiles.p${index}.model_catalog_json`));
  assert.equal(nativeWritesViolation(copies(3900), identity), inspectBudgetMessage);
  assert.equal(nativeWritesViolation(copies(50), identity), undefined, "a real batch of the same path is forwarded");
  // The least budget grows with every copy by at least the size charge, however well the answer is remembered.
  const one = leastBudget(copies(1), identity);
  const eleven = leastBudget(copies(11), identity);
  assert.ok(eleven - one >= 10 * pathValueUnits(value), `${eleven} - ${one} covers ten more copies at ${pathValueUnits(value)} units each`);
  // A relative copy and one through `~/` are the same kind of work and are charged as well.
  const relative = Array.from({ length: 3900 }, (_, index) => catalogEdit("zz-same" + "/a".repeat(1990), `profiles.p${index}.model_catalog_json`));
  assert.equal(nativeWritesViolation(relative, identity), inspectBudgetMessage);
  const home = Array.from({ length: 3900 }, (_, index) => catalogEdit("~" + longPath("/zz-same"), `profiles.p${index}.model_catalog_json`));
  assert.equal(nativeWritesViolation(home, identity), inspectBudgetMessage);
});

test("a path that collapses to a short one is charged for the text it was sent as", () => {
  const { identity } = treeIdentity();
  const collapsing = Array.from({ length: 3200 }, (_, index) => catalogEdit(`/zz${index}` + "/..".repeat(1300), `profiles.p${index}.model_catalog_json`));
  assert.equal(nativeWritesViolation(collapsing, identity), inspectBudgetMessage);
});

/** A small deterministic generator, so a failing property case can be replayed. */
function generator(seed: number) {
  let state = seed >>> 0;
  return (below: number): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % below; };
}
const names = ["a", "b", "c d", "é", "..", ".", "", "x.y", "~", "..."];

test("the rest of a path goes below its resolved folder exactly as resolve puts it", () => {
  const next = generator(20261017);
  const pick = () => Array.from({ length: next(8) }, () => names[next(names.length)]!);
  for (let round = 0; round < 5000; round++) {
    const lexical = resolve("/", ...pick());
    const components = lexical.split("/").filter(component => component.length > 0);
    const stopped = next(components.length + 1);
    const rest = components.slice(stopped).join("/");
    const real = resolve("/", ...pick());
    assert.equal(joinBelow(real, rest), resolve(real, ...components.slice(stopped)), `real ${JSON.stringify(real)} rest ${JSON.stringify(rest)}`);
  }
});

test("walking a path by scanning gives the same prefixes and rest as splitting it", () => {
  const { root, identity } = treeIdentity();
  mkdirSync(join(root, "d0", "d1", "d2"), { recursive: true });
  writeFileSync(join(root, "d0", "file"), "x");
  const next = generator(7);
  const existing = [root, join(root, "d0"), join(root, "d0", "d1"), join(root, "d0", "d1", "d2"), join(root, "d0", "file"), "/"];
  const missing = ["m", "n o", "é", "...", "file", "d0"];
  const exists = (path: string) => { try { statSync(path); return true; } catch { return false; } };
  for (let round = 0; round < 400; round++) {
    const base = existing[next(existing.length)]!;
    const tail = Array.from({ length: next(5) }, () => missing[next(missing.length)]!);
    const target = resolve(base, ...tail);
    // The reference splits the whole path into components and stops at the first one that cannot be read.
    const components = target.split("/").filter(component => component.length > 0);
    const ancestors: string[] = [];
    let current = "/";
    let rest: string | undefined;
    for (let index = 0; index < components.length; index++) {
      const prefix = current === "/" ? "/" + components[index] : current + "/" + components[index];
      if (!exists(prefix)) { rest = components.slice(index).join("/"); break; }
      if (index < components.length - 1) ancestors.push(prefix);
      current = prefix;
    }
    const guard = prepareGatewayPaths(identity, { memo: 4096, budget: 1e9 });
    const walked = walkExisting(guard, target);
    assert.deepEqual(walked, { ancestors, deepest: current, rest: rest ?? "" }, target);
  }
});

test("on Windows any string catalog path is refused with a fixed message, and clearing the key is not", () => {
  const { identity } = treeIdentity();
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const refused = (value: unknown, keyPath = "model_catalog_json") => nativeWritesViolation([catalogEdit(value as string, keyPath)], identity);
    assert.equal(refused("C:\\Users\\dev\\catalog.json"), windowsCatalogMessage);
    assert.equal(refused("catalog.json"), windowsCatalogMessage);
    assert.equal(refused(""), windowsCatalogMessage);
    assert.equal(refused({ model_catalog_json: "x.json" }, "profiles.work"), windowsCatalogMessage, "inside a value as well");
    assert.equal(refused([{ nested: { model_catalog_json: "x.json" } }], "plugins"), windowsCatalogMessage);
    assert.equal(refused(null), undefined, "clearing is forwarded");
    assert.equal(refused("x.json", "profiles.work.other_key"), undefined, "other keys are not catalog paths");
    assert.ok(!windowsCatalogMessage.includes("x.json") && !windowsCatalogMessage.includes(identity.stateDirectory), "the message names no path");
  } finally { Object.defineProperty(process, "platform", original); }
  assert.equal(nativeWritesViolation([catalogEdit(identity.catalogPath)], identity) === windowsCatalogMessage, false, "and the platform is back to its own");
});
