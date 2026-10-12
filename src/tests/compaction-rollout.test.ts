import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCompactionUsage } from "../compaction-rollout.js";

const at = "2026-10-12T12:00:00.000Z";
const session = (id = "chat") => ({ timestamp: at, type: "session_meta", payload: { id } });
const counts = (last = 600000) => ({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: {
  total_token_usage: { total_tokens: 900000000 }, last_token_usage: { total_tokens: last }, model_context_window: 1000000,
} } });
async function fixture(records: unknown[], archive = false) {
  const home = await mkdtemp(join(tmpdir(), "gateway-rollout-")); const directory = join(home, archive ? "archived_sessions" : "sessions", "2026");
  await mkdir(directory, { recursive: true }); const path = join(directory, "rollout.jsonl");
  await writeFile(path, records.map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
  return { home, path };
}

test("guarded SDK rollout fallback returns only the latest per-turn counters, never cumulative usage or model history", async () => {
  for (const archive of [false, true]) {
    const f = await fixture([session(), { timestamp: at, type: "turn_context", payload: { model: "private-prior-model" } }, counts(), counts(20)], archive);
    const before = await readFile(f.path);
    assert.deepEqual(await readCompactionUsage(f.home, "chat", f.path), { lastTokens: 20, contextWindow: 1000000, emittedAtMs: Date.parse(at) });
    assert.deepEqual(await readFile(f.path), before, "fallback must never modify a rollout");
    assert.equal(await readCompactionUsage(f.home, "wrong-chat", f.path), undefined);
  }
});

test("compacted and rolled-back history invalidates counters until a new authoritative token_count", async () => {
  for (const reset of [{ timestamp: at, type: "compacted", payload: { message: "private summary" } },
    { timestamp: at, type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }]) {
    const f = await fixture([session(), counts(), reset]); assert.equal(await readCompactionUsage(f.home, "chat", f.path), undefined);
    await writeFile(f.path, [session(), counts(), reset, counts(12)].map(value => JSON.stringify(value)).join("\n") + "\n");
    assert.equal((await readCompactionUsage(f.home, "chat", f.path))!.lastTokens, 12);
  }
});

test("foreign paths, symlink escapes, malformed metadata, truncation, and oversized files stay unknown", async () => {
  const f = await fixture([session(), counts()]); const other = await fixture([session(), counts()]);
  assert.equal(await readCompactionUsage(f.home, "chat", other.path), undefined);
  const link = join(f.home, "sessions", "foreign.jsonl"); await symlink(other.path, link);
  assert.equal(await readCompactionUsage(f.home, "chat", link), undefined);
  for (const suffix of ['{"type":"event_msg","payload":{"type":"token_count"',
    JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 999 }, model_context_window: 1000000 } } }) + "\n"]) {
    await writeFile(f.path, [session(), counts()].map(value => JSON.stringify(value)).join("\n") + "\n" + suffix);
    assert.equal(await readCompactionUsage(f.home, "chat", f.path), undefined);
  }
  const file = await open(f.path, "w"); try { await file.truncate(64 * 1024 * 1024 + 1); } finally { await file.close(); }
  assert.equal(await readCompactionUsage(f.home, "chat", f.path), undefined);
});

test("oversized message or compaction lines cannot retain pre-replacement counters", async () => {
  const f = await fixture([session(), counts(), { timestamp: at, type: "compacted", payload: { message: "x".repeat(70000) } }]);
  assert.equal(await readCompactionUsage(f.home, "chat", f.path), undefined);
  await writeFile(f.path, [session(), { type: "response_item", payload: { type: "message", content: "x".repeat(70000) } }, counts(25)].map(value => JSON.stringify(value)).join("\n") + "\n");
  assert.equal((await readCompactionUsage(f.home, "chat", f.path))!.lastTokens, 25);
});

test("source timestamps reject delayed counts both before and after history replacement", async () => {
  const newer = { ...counts(20), timestamp: "2026-10-12T12:00:01.000Z" };
  const f = await fixture([session(), newer, counts(600000)]);
  assert.equal((await readCompactionUsage(f.home, "chat", f.path))!.lastTokens, 20);
  await writeFile(f.path, [session(), newer, { type: "compacted", timestamp: "2026-10-12T12:00:02.000Z", payload: {} }, counts()].map(value => JSON.stringify(value)).join("\n") + "\n");
  assert.equal(await readCompactionUsage(f.home, "chat", f.path), undefined);
});
