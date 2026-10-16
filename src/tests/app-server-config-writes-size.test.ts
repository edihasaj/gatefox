import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultGuardLimits, inspectBudgetMessage, joinBelow, nativeWritesViolation, pathTooLongMessage, pathValueUnits, prepareGatewayPaths, walkExisting,
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
/** A tree whose native home is spelled through a link, so a relative value is judged against two bases. */
function twoBaseIdentity(): GatewayIdentity {
  const { root, identity } = treeIdentity();
  mkdirSync(join(root, "real-native"));
  symlinkSync(join(root, "real-native"), join(root, "native"));
  assert.equal(prepareGatewayPaths(identity, defaultGuardLimits).homes.length, 2, "the native home has two spellings");
  return identity;
}
const catalogEdit = (value: string, keyPath = "model_catalog_json") => ({ keyPath, value, mergeStrategy: "upsert" });
/** The least budget at which these edits are forwarded. */
function leastBudget(edits: unknown[], identity: GatewayIdentity, extra: Partial<GuardLimits> = {}): number {
  let low = 1;
  let high = 10_000_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (nativeWritesViolation(edits, identity, { memo: 4096, ...extra, budget: middle }) === undefined) high = middle; else low = middle + 1;
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

/** The same edit under a new key for each profile; `value` of every one is the exact same string. */
const profiles = (count: number, value: string) =>
  Array.from({ length: count }, (_, index) => catalogEdit(value, `profiles.p${index}.model_catalog_json`));

test("a short value repeated or aliased in a frame is bounded by the budget and the judgment cap, in counts", () => {
  const identity = twoBaseIdentity();
  // Different short values cost one unit per base each, although none of them is long: 456k fit in a 16 MiB frame.
  const distinct = Array.from({ length: 20_000 }, (_, index) => catalogEdit(`${index}/../a`, `profiles.p${index}.model_catalog_json`));
  assert.equal(pathValueUnits(distinct[0]!.value), 0, "each is a short name");
  const uncapped: GuardLimits = { ...defaultGuardLimits, judgments: Infinity };
  assert.equal(nativeWritesViolation(distinct, identity, uncapped), inspectBudgetMessage, "refused by the budget, not by the cap");
  assert.equal(nativeWritesViolation(distinct.slice(0, 2000), identity), undefined, "a real batch of different values passes");
  // Copies of one short value cost what one copy costs: the answer is remembered and the size charge is nothing.
  const value = "own/catalog.json";
  const one = leastBudget(profiles(1, value), identity);
  assert.ok(one >= 2, `the first copy pays one unit per base: ${one}`);
  const many = profiles(600_000, value);
  assert.equal(nativeWritesViolation(many, identity, { memo: 4096, budget: one, judgments: Infinity }), undefined, "600k copies fit where one copy fits");
  assert.equal(nativeWritesViolation(many, identity, { memo: 4096, budget: one - 1, judgments: Infinity }), inspectBudgetMessage, "and not a unit less");
  // A long value still pays its size every time it is judged, remembered or not.
  const long = "own/" + "x".repeat(640);
  const unitsEach = pathValueUnits(long) * 2;
  assert.equal(leastBudget(profiles(11, long), identity) - leastBudget(profiles(1, long), identity), 10 * unitsEach, "ten more copies pay the size ten more times");
  // Without room to remember it, each copy is judged again and pays the unit per base again.
  assert.ok(leastBudget(profiles(11, value), identity, { memo: 0 }) - leastBudget(profiles(1, value), identity, { memo: 0 }) >= 20, "a full memo never makes a repeat free");
});

test("a request judges at most 65,536 values against bases, and 20k profiles on two bases are far below that", () => {
  const identity = twoBaseIdentity();
  const value = "own/catalog.json";
  assert.equal(nativeWritesViolation(profiles(20_000, value), identity), undefined, "20k profiles make 40k judgments and pass");
  assert.equal(nativeWritesViolation(profiles(32_768, value), identity), undefined, "32768 copies on two bases make exactly 65536");
  assert.equal(nativeWritesViolation(profiles(32_769, value), identity), inspectBudgetMessage, "one more is refused with the budget message");
  assert.equal(nativeWritesViolation(profiles(600_000, value), identity), inspectBudgetMessage);
  assert.equal(nativeWritesViolation(profiles(32_769, value), identity, { ...defaultGuardLimits, judgments: 100_000 }), undefined, "the cap is a limit of the guard, like the budget");
  // A lone base makes a judgment per copy, so twice as many copies fit.
  const { identity: oneBase } = treeIdentity();
  assert.equal(nativeWritesViolation(profiles(65_536, value), oneBase), undefined);
  assert.equal(nativeWritesViolation(profiles(65_537, value), oneBase), inspectBudgetMessage);
});

test("a single value too long for the budget to ever cover is refused with its own message", () => {
  const identity = twoBaseIdentity();
  const edit = (length: number) => [catalogEdit("/" + "x".repeat(length - 1))];
  const fits = 64 * defaultGuardLimits.budget / 2; // two bases at one unit per 64 characters
  assert.notEqual(nativeWritesViolation(edit(fits - 64), identity), pathTooLongMessage, "just under the limit is judged on its spelling");
  assert.equal(nativeWritesViolation(edit(fits + 64), identity), pathTooLongMessage);
  assert.equal(nativeWritesViolation(edit(2 * 1024 * 1024), identity), pathTooLongMessage);
  assert.equal(nativeWritesViolation(edit(600 * 1024), treeIdentity().identity) === pathTooLongMessage, false, "one base can pay for twice the length");
  assert.equal(pathTooLongMessage, "This configuration write names a path too long to check");
  assert.ok(!pathTooLongMessage.includes("/"), "the message names no path");
  // Inside a nested value it is the same refusal.
  assert.equal(nativeWritesViolation([{ keyPath: "x", value: [{ model_catalog_json: "/" + "x".repeat(fits + 64) }] }], identity), pathTooLongMessage);
});
