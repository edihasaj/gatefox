import test from "node:test";
import assert from "node:assert/strict";
import { compareModels, familyOf, parseModelId } from "../model-auto-latest/families.js";
import { maximumReleasedAt, minimumReleasedAt } from "../model-auto-latest/metadata.js";

const at = (year: number, month: number, day: number, hour = 0) => Date.UTC(year, month - 1, day, hour) / 1000;
const cmp = (a: string, b: string, aAt?: number, bAt?: number) =>
  compareModels({ id: a, ...(aAt === undefined ? {} : { releasedAt: aAt }) }, { id: b, ...(bAt === undefined ? {} : { releasedAt: bAt }) });

test("known GPT and Claude IDs resolve to their exact family", () => {
  const expected: Array<[string, string]> = [
    ["gpt-6-astra", "gpt-astra"], ["gpt-6.1-sol", "gpt-sol"], ["gpt-5.6-terra", "gpt-terra"], ["gpt-6-luna", "gpt-luna"],
    ["claude-opus-5-5", "claude-opus"], ["claude-opus-5.5", "claude-opus"], ["claude-sonnet-5-5-20261001", "claude-sonnet"],
    ["claude-fable-5", "claude-fable"], ["claude-haiku-5.1-20261001", "claude-haiku"], ["gpt-daybreak-blue-latest", "gpt-daybreak-blue"],
  ];
  for (const [id, family] of expected) assert.equal(familyOf(id), family, id);
});

test("parseModelId reports numeric versions, a valid ID date and floating IDs", () => {
  assert.deepEqual(parseModelId("gpt-6.10-sol"), { family: "gpt-sol", version: [6, 10] });
  assert.deepEqual(parseModelId("claude-opus-5-5"), { family: "claude-opus", version: [5, 5] });
  assert.deepEqual(parseModelId("claude-opus-5.5"), { family: "claude-opus", version: [5, 5] });
  assert.deepEqual(parseModelId("claude-sonnet-5-5-20261001"), { family: "claude-sonnet", version: [5, 5], date: at(2026, 10, 1) });
  assert.deepEqual(parseModelId("gpt-daybreak-blue-latest"), { family: "gpt-daybreak-blue", version: [], floating: true });
});

test("unknown, malformed, preview, fast, thinking and auto IDs are rejected, with no family guessing", () => {
  const rejected = [
    "", " ", "gpt-5.3-codex", "gpt-5-codex", "gpt-6.1-sol-preview", "gpt-6.1-sol-fast", "gpt-6.1-sol-auto", "gpt-6.1-sol-thinking",
    "claude-opus-5-5-thinking", "claude-opus-5-5-fast", "claude-opus-5-5-preview", "auto", "gpt-auto", "claude-auto", "gpt-6-sol-mini",
    "GPT-6-sol", "Claude-opus-5-5", " gpt-6-sol", "gpt-6-sol ", "gpt-6-sol\n", "gpt-6-sol\u0000", "gpt-6.01-sol", "gpt-06-sol",
    "gpt-6.1.2.3-sol", "gpt-1000-sol", "gpt-6-", "gpt--sol", "gpt-6-sol-", "gpt-6-solx", "gpt-6.sol", "gpt-sol",
    "claude-opus", "claude-opus-", "claude-opus-20261001", "claude-opus-5-5-5-5", "claude-opus-5.5-1", "claude-opus-5-5.1", "claude-opus-5.5.5-1",
    "claude-3-5-sonnet-20241022", "claude-unknown-5", "claude-opus-5-5-2026-10-01", "claude-opus-5-5-2026100", "claude-opus-5-5-202610011",
    "gpt-daybreak-blue", "gpt-daybreak-blue-latest-fast", "gpt-daybreak-blue-preview", "gpt-6-daybreak-blue", "gpt-daybreak-green-latest",
    "claude-fable-latest", "gpt-latest", "o3", "gemini-3-pro", "gpt-6.1-sol/other", "gpt-6.1-sol?x", "a".repeat(200), `gpt-6-sol${"-1".repeat(100)}`,
  ];
  for (const id of rejected) { assert.equal(familyOf(id), undefined, JSON.stringify(id)); assert.equal(parseModelId(id), undefined, JSON.stringify(id)); }
  for (const value of [undefined, null, 6, {}, [], ["gpt-6-sol"], Symbol.iterator as unknown]) assert.equal(familyOf(value as string), undefined);
});

test("invalid calendar dates and dates outside the accepted range are rejected", () => {
  for (const date of ["20261301", "20260230", "20250229", "20261032", "20260000", "20260100", "20261000", "00000000", "20091231", "21000101", "99991231"]) {
    assert.equal(familyOf(`claude-opus-5-5-${date}`), undefined, date);
    assert.equal(familyOf(`gpt-6-sol-${date}`), undefined, date);
  }
  for (const date of ["20240229", "20100101", "20991231"]) assert.equal(familyOf(`claude-opus-5-5-${date}`), "claude-opus", date);
});

test("numeric versions decide first, segment by segment, never as text", () => {
  assert.ok(cmp("gpt-6.10-sol", "gpt-6.9-sol") > 0);
  assert.ok(cmp("gpt-6.9-sol", "gpt-6.10-sol") < 0);
  assert.ok(cmp("gpt-6.1-sol", "gpt-5.6-sol") > 0);
  assert.ok(cmp("gpt-6.1.1-sol", "gpt-6.1-sol") > 0);
  assert.ok(cmp("claude-opus-5-10", "claude-opus-5-9") > 0);
  assert.ok(cmp("claude-opus-5.5", "claude-opus-5-4") > 0);
  assert.ok(cmp("claude-opus-6", "claude-opus-5.9") > 0);
});

test("an equal version with different IDs and no known dates is ambiguous: zero in both directions, no lexical tiebreak", () => {
  assert.equal(cmp("claude-opus-5-5", "claude-opus-5.5"), 0);
  assert.equal(cmp("claude-opus-5.5", "claude-opus-5-5"), 0);
  assert.equal(cmp("gpt-6-sol", "gpt-6.0-sol"), 0);
  assert.equal(cmp("gpt-6.0-sol", "gpt-6-sol"), 0);
  assert.equal(cmp("claude-opus-5-5-20261001", "claude-opus-5.5"), 0, "only one date is known");
  assert.equal(cmp("claude-opus-5-5", "claude-opus-5.5", at(2026, 10, 1)), 0, "only one release time is known");
});

test("the same semantic version is ranked by date only when both dates are known", () => {
  assert.ok(cmp("claude-opus-5-5-20261001", "claude-opus-5.5-20260901") > 0);
  assert.ok(cmp("claude-opus-5.5-20260901", "claude-opus-5-5-20261001") < 0);
  assert.ok(cmp("claude-opus-5-5", "claude-opus-5.5", at(2026, 10, 5), at(2026, 10, 3)) > 0);
  assert.ok(cmp("claude-opus-5-5", "claude-opus-5.5", at(2026, 10, 3), at(2026, 10, 5)) < 0);
  assert.equal(cmp("claude-opus-5-5", "claude-opus-5.5", at(2026, 10, 3), at(2026, 10, 3)), 0);
  // An explicit release time wins over an ID date.
  assert.ok(cmp("claude-opus-5-5-20261001", "claude-opus-5.5", at(2026, 10, 5), at(2026, 10, 3)) > 0);
  assert.ok(cmp("claude-opus-5-5-20261001", "claude-opus-5.5", undefined, at(2026, 9, 30)) > 0);
  // An ID date has day precision: the same day is a tie, whatever the hour.
  assert.equal(cmp("claude-opus-5-5-20261001", "claude-opus-5.5", undefined, at(2026, 10, 1, 12)), 0);
});

test("an older semantic version is never promoted by a newer timestamp or date", () => {
  assert.ok(cmp("gpt-6.1-sol", "gpt-6.2-sol", at(2027, 1, 1), at(2026, 1, 1)) < 0);
  assert.ok(cmp("gpt-6.2-sol", "gpt-6.1-sol", at(2026, 1, 1), at(2027, 1, 1)) > 0);
  assert.ok(cmp("claude-opus-5-4-20270101", "claude-opus-5-5-20260101") < 0);
  assert.ok(cmp("claude-opus-5-5-20260101", "claude-opus-5-4-20270101") > 0);
});

test("different families, unknown IDs and identical IDs are never ranked", () => {
  assert.equal(cmp("gpt-6.1-sol", "gpt-6.1-terra"), 0);
  assert.equal(cmp("gpt-6.2-sol", "claude-opus-5-5"), 0);
  assert.equal(cmp("claude-opus-5-5", "claude-sonnet-5-4"), 0);
  assert.equal(cmp("gpt-5.3-codex", "gpt-5.6-terra"), 0);
  assert.equal(cmp("gpt-5.6-terra", "gpt-5.3-codex"), 0);
  assert.equal(cmp("gpt-6.1-sol-preview", "gpt-6.2-sol"), 0);
  assert.equal(cmp("unknown", "other", at(2026, 1, 1), at(2027, 1, 1)), 0);
  assert.equal(cmp("gpt-6.1-sol", "gpt-6.1-sol", at(2026, 1, 1), at(2027, 1, 1)), 0);
  assert.equal(cmp("", ""), 0);
});

test("a floating ID is recognized but never ranked, including against itself and other daybreak IDs", () => {
  assert.equal(familyOf("gpt-daybreak-blue-latest"), "gpt-daybreak-blue");
  assert.equal(cmp("gpt-daybreak-blue-latest", "gpt-daybreak-blue-latest", at(2026, 1, 1), at(2027, 1, 1)), 0);
  assert.equal(cmp("gpt-daybreak-blue-latest", "gpt-6.1-sol", at(2027, 1, 1), at(2026, 1, 1)), 0);
  assert.equal(cmp("gpt-6.1-sol", "gpt-daybreak-blue-latest", at(2026, 1, 1), at(2027, 1, 1)), 0);
  assert.equal(cmp("gpt-daybreak-blue-latest", "gpt-daybreak-blue-20261001"), 0);
});

test("release times that are not finite or fall outside the accepted bounds count as unknown", () => {
  const good = at(2026, 10, 3);
  for (const bad of [Number.NaN, Infinity, -Infinity, 0, -1, minimumReleasedAt - 1, maximumReleasedAt, maximumReleasedAt + 1, 5e12, "2026-10-05" as unknown as number]) {
    assert.equal(cmp("claude-opus-5-5", "claude-opus-5.5", bad, good), 0, String(bad));
    assert.equal(cmp("claude-opus-5-5", "claude-opus-5.5", good, bad), 0, String(bad));
    // An unusable release time falls back to the ID date rather than being trusted.
    assert.ok(cmp("claude-opus-5-5-20261001", "claude-opus-5.5-20260901", bad, undefined) > 0, String(bad));
  }
  assert.ok(cmp("claude-opus-5-5", "claude-opus-5.5", minimumReleasedAt + 1, minimumReleasedAt) > 0);
  assert.ok(cmp("claude-opus-5-5", "claude-opus-5.5", maximumReleasedAt - 1, minimumReleasedAt) > 0);
});

test("comparison is antisymmetric across a mixed set and never throws on bad input", () => {
  const models = ["gpt-6.10-sol", "gpt-6.9-sol", "gpt-6-sol", "claude-opus-5-5", "claude-opus-5.5-20260901", "claude-opus-5-5-20261001", "claude-haiku-5", "nope", "gpt-daybreak-blue-latest"];
  for (const a of models) for (const b of models) assert.equal(Math.sign(cmp(a, b)), -Math.sign(cmp(b, a)) || 0, `${a} ${b}`);
  assert.equal(compareModels({ id: undefined as unknown as string }, { id: "gpt-6-sol" }), 0);
  assert.equal(compareModels(undefined as never, undefined as never), 0);
});
