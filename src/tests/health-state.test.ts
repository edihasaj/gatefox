import test from "node:test";
import assert from "node:assert/strict";
import { appPairChanged, healthStatePath, readHealthState, smokeCovers, writeHealthState, type HealthState } from "../health-state.js";

const readOf = (value: string) => async () => value;
const json = (value: unknown) => readOf(JSON.stringify(value));

test("the state file sits in the gateway state directory", () => {
  assert.equal(healthStatePath("/state"), "/state/health-state.json");
});

test("unreadable or foreign state files read as no record", async () => {
  assert.equal(await readHealthState("/s", readOf("")), undefined);
  assert.equal(await readHealthState("/s", readOf("{not json")), undefined);
  assert.equal(await readHealthState("/s", readOf("[1,2]")), undefined);
  assert.equal(await readHealthState("/s", json({ version: 2, app: { bundle: "1", engine: "2", seenAt: "x" } })), undefined);
});

test("a recorded pair and smoke answer survive, and stray fields do not", async () => {
  const state = await readHealthState("/s", json({ version: 1, app: { bundle: "26.10", engine: "0.4.4", seenAt: "then", path: "/secret/App.app", token: "hunter2" },
    smoke: { bundle: "26.10", engine: "0.4.4", result: "fail", phase: "thread-start", at: "later", argv: ["-x"] }, extra: { nested: "value" } }));
  assert.deepEqual(state, { version: 1,
    app: { bundle: "26.10", engine: "0.4.4", seenAt: "then" },
    smoke: { bundle: "26.10", engine: "0.4.4", result: "fail", phase: "thread-start", at: "later" } });
  const text = JSON.stringify(state);
  assert.equal(text.includes("hunter2") || text.includes("/secret"), false);
});

test("malformed values are reduced, and an unusable record is dropped", async () => {
  const state = await readHealthState("/s", json({ version: 1, app: { bundle: "space here", engine: "0.4.4" }, smoke: { bundle: "1", engine: "2", result: "maybe" } }));
  // A version that is a sentence is not a version: it reads as unknown, not as text.
  assert.deepEqual(state, { version: 1, app: { bundle: null, engine: "0.4.4", seenAt: "" } });
  // A smoke record whose answer is not pass or fail is no answer at all.
  assert.equal(state?.smoke, undefined);
});

test("a recorded phase is a phase name, never whatever was in the file", async () => {
  // Too long, and not a slug at all: both say `unknown`, neither is carried through.
  const long = await readHealthState("/s", json({ version: 1, smoke: { bundle: "1", engine: "2", result: "pass", phase: "x".repeat(200), at: 5 } }));
  assert.equal(long?.smoke?.phase, "unknown");
  assert.equal(long?.smoke?.at, "");
  const pathish = await readHealthState("/s", json({ version: 1, smoke: { bundle: "1", engine: "2", result: "fail", phase: "TypeError: /tmp/gw-fast-x:1 boom", at: "then" } }));
  assert.equal(pathish?.smoke?.phase, "unknown");
  assert.equal(JSON.stringify(pathish).includes("/tmp"), false);
  assert.equal((await readHealthState("/s", json({ version: 1, smoke: { bundle: "1", engine: "2", result: "fail", phase: "turn-start", at: "then" } })))?.smoke?.phase, "turn-start");
});

test("appPairChanged answers first, same, and moved", () => {
  assert.equal(appPairChanged(undefined, { bundle: "1", engine: "2" }), true);
  assert.equal(appPairChanged({ bundle: "1", engine: "2", seenAt: "x" }, { bundle: "1", engine: "2" }), false);
  assert.equal(appPairChanged({ bundle: "1", engine: "2", seenAt: "x" }, { bundle: "1", engine: null }), true);
  assert.equal(appPairChanged({ bundle: null, engine: null, seenAt: "x" }, { bundle: null, engine: null }), false);
});

test("smokeCovers only trusts an answer earned against this exact pair", () => {
  assert.equal(smokeCovers(undefined, { bundle: "1", engine: "2" }), false);
  const seen = { bundle: "1", engine: "2", result: "pass" as const, at: "x" };
  assert.equal(smokeCovers(seen, { bundle: "1", engine: "2" }), true);
  assert.equal(smokeCovers(seen, { bundle: "1", engine: "3" }), false);
});

test("writing goes through the private writer at the state path", async () => {
  const writes: Array<[string, unknown]> = [];
  const state: HealthState = { version: 1, app: { bundle: "1", engine: "2", seenAt: "x" } };
  await writeHealthState("/state", state, async (path, value) => { writes.push([path, value]); });
  assert.deepEqual(writes, [["/state/health-state.json", state]]);
});
