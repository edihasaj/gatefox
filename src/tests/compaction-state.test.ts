import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CompactionStateStore, compactionDecision } from "../compaction-state.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-compaction-")); const home = join(directory, "native");
  return { directory, home, store: new CompactionStateStore(directory, home), peer: () => new CompactionStateStore(directory, home) };
}
const target = { effectiveContextWindow: 400000, autoCompactTokenLimit: 380000 };
const tokens = (threadId: string, at: number, lastTokens = 600000, contextWindow = 1000000) => ({ emittedAtMs: at, method: "thread/tokenUsage/updated", params: {
  threadId, tokenUsage: { last: { totalTokens: lastTokens }, total: { totalTokens: 900000000 }, modelContextWindow: contextWindow },
} });
const item = (threadId: string, turnId: string, at: number, completed = false) => ({ emittedAtMs: at, method: completed ? "item/completed" : "item/started",
  params: { threadId, turnId, item: { type: "contextCompaction", id: "compact-item" } } });
const terminal = (threadId: string, turnId: string, at: number, status = "completed") => ({ emittedAtMs: at, method: "turn/completed", params: { threadId, turn: { id: turnId, status } } });

test("usage persists at turn completion, ignores cumulative totals, and remains scoped to the native home", async () => {
  const f = await fixture(); await f.store.observe(tokens("chat", 10)); await f.store.observe(tokens("chat", 11, 20));
  assert.deepEqual(await readdir(f.directory), [], "token updates must not write once per token");
  assert.equal((await f.store.read("chat"))!.usage!.lastTokens, 20);
  assert.deepEqual(compactionDecision(await f.store.read("chat"), target), { action: "none" });
  await f.store.observe(terminal("chat", "user", 12));
  const saved = await f.peer().read("chat"); assert.equal(saved!.usage!.lastTokens, 20);
  const files = await readdir(f.directory); assert.equal(files.length, 1);
  assert.equal((await stat(join(f.directory, files[0]))).mode & 0o777, 0o600);
  assert.equal(await new CompactionStateStore(f.directory, join(f.directory, "other-native")).read("chat"), undefined);
  const serialized = await readFile(join(f.directory, files[0]), "utf8");
  assert.ok(!serialized.includes("900000000")); assert.ok(!serialized.includes("tokenUsage"));
});

test("only an observed failed compaction qualifies for unknown-usage recovery; interruptions remain interrupted", async () => {
  const f = await fixture(); await f.store.observe(terminal("normal", "work", 1, "failed"));
  assert.deepEqual(compactionDecision(await f.store.read("normal"), target), { action: "none" });
  await f.store.observe(item("failed", "compact", 2)); await f.store.observe(terminal("failed", "compact", 3, "failed"));
  assert.equal((await f.peer().read("failed"))!.compaction!.status, "failed");
  assert.deepEqual(compactionDecision(await f.peer().read("failed"), target), { action: "compact", reason: "failed" });
  await f.store.observe(item("interrupted", "compact", 4)); await f.store.observe(terminal("interrupted", "compact", 5, "interrupted"));
  await f.store.observe(terminal("interrupted", "compact", 6, "failed"));
  assert.equal((await f.peer().read("interrupted"))!.compaction!.status, "interrupted");
  assert.deepEqual(compactionDecision(await f.store.read("interrupted"), target), { action: "none" });
  f.store.seedUsage("interrupted", { lastTokens: 600000, contextWindow: 1000000, emittedAtMs: 7 });
  assert.deepEqual(compactionDecision(await f.store.read("interrupted"), target), { action: "compact", reason: "downshift" });
});

test("successful compaction and rollback invalidate pre-replacement usage and fence delayed notifications", async () => {
  const f = await fixture(); await f.store.observe(tokens("chat", 10)); await f.store.observe(item("chat", "compact", 20));
  await f.store.observe(item("chat", "compact", 21, true));
  assert.equal((await f.store.read("chat"))!.usage, undefined);
  await f.store.observe(terminal("chat", "compact", 22)); await f.store.observe(tokens("chat", 19));
  assert.equal((await f.store.read("chat"))!.compaction!.status, "completed");
  assert.deepEqual(compactionDecision(await f.store.read("chat"), target), { action: "none" });
  await f.store.reset("chat", 30); await f.store.observe(tokens("chat", 29));
  assert.deepEqual(await f.store.read("chat"), { emittedAtMs: 30 });
  await f.store.observe(tokens("chat", 30)); assert.equal((await f.store.read("chat"))!.usage, undefined);
  await f.store.observe(tokens("chat", 31)); assert.equal((await f.store.read("chat"))!.usage!.lastTokens, 600000);
});

test("older connection flushes cannot resurrect failed compaction state after another connection replaces history", async () => {
  const f = await fixture(); await f.store.observe(item("chat", "old", 10)); await f.store.observe(terminal("chat", "old", 11, "failed"));
  await f.store.observe(tokens("chat", 12));
  const peer = f.peer(); await peer.observe(item("chat", "recovery", 20)); await peer.observe(item("chat", "recovery", 21, true)); await peer.observe(terminal("chat", "recovery", 22));
  await f.store.observe(terminal("chat", "unrelated-work", 30));
  const saved = await f.peer().read("chat"); assert.equal(saved!.compaction!.status, "completed"); assert.equal(saved!.usage, undefined);
  assert.deepEqual(compactionDecision(saved, target), { action: "none" });
});

test("pure downshift policy requires known latest usage and rejects unsupported hash changes", () => {
  const known = { emittedAtMs: 10, usage: { lastTokens: 380000, contextWindow: 1000000, emittedAtMs: 10 } };
  assert.deepEqual(compactionDecision(known, target), { action: "compact", reason: "downshift" });
  assert.deepEqual(compactionDecision({ ...known, usage: { ...known.usage, lastTokens: 379999 } }, target), { action: "none" });
  assert.deepEqual(compactionDecision({ ...known, usage: { ...known.usage, contextWindow: 400000 } }, target), { action: "none" });
  assert.deepEqual(compactionDecision(undefined, target), { action: "none" });
  assert.deepEqual(compactionDecision(known, { ...target, compactionHash: "different" }), { action: "reject", reason: "unsupported-compaction-hash" });
  assert.deepEqual(compactionDecision(known, target, "unsupported-source"), { action: "reject", reason: "unsupported-compaction-hash" });
  for (const limit of [NaN, Infinity, -1, 0, 1.5]) assert.deepEqual(compactionDecision(known, { ...target, autoCompactTokenLimit: limit }), { action: "none" });
});

test("missing or conflicting same-time counters remain unknown instead of using cumulative estimates", async () => {
  const f = await fixture(); await f.store.observe(tokens("chat", 10)); await f.store.observe(tokens("chat", 10, 30));
  assert.equal((await f.store.read("chat"))!.usage, undefined);
  await f.store.observe(tokens("chat", 10)); assert.equal((await f.store.read("chat"))!.usage, undefined);
  await f.store.observe({ method: "thread/tokenUsage/updated", params: tokens("chat", 11).params });
  assert.equal((await f.store.read("chat"))!.usage, undefined);
  await f.store.observe({ emittedAtMs: 11, method: "thread/tokenUsage/updated", params: { threadId: "chat", tokenUsage: { total: { totalTokens: 900000000 }, modelContextWindow: 1000000 } } });
  await f.store.observe(terminal("chat", "work", 12)); assert.equal((await f.peer().read("chat"))!.usage, undefined);
});

test("private compaction metadata rejects unsafe files and unknown persisted fields", async () => {
  const f = await fixture(); await f.store.observe(terminal("chat", "work", 1));
  const path = join(f.directory, (await readdir(f.directory))[0]);
  await writeFile(path, JSON.stringify({ version: 1, threads: { chat: { emittedAtMs: 1, secret: "not-metadata" } } }));
  await assert.rejects(f.store.read("chat"), /invalid or unsafe/);
  await writeFile(path, JSON.stringify({ version: 1, threads: {} }));
  if (process.platform !== "win32") { await chmod(path, 0o644); await assert.rejects(f.store.read("chat"), /invalid or unsafe/); }
  const target = join(f.directory, "native-file"); await writeFile(target, "native unchanged", { mode: 0o600 });
  const linked = join(f.directory, "linked-state"); await symlink(f.directory, linked);
  await assert.rejects(new CompactionStateStore(linked, f.home).read("chat"), /invalid or unsafe/);
  assert.equal(await readFile(target, "utf8"), "native unchanged");
});

test("a full store drops the row observed longest ago instead of refusing a new chat", async () => {
  const f = await fixture();
  const rows = Object.fromEntries(Array.from({ length: 4096 }, (_, index) => [`chat-${index}`, { emittedAtMs: 1000 + index }]));
  // Chat 7 was observed most recently, though it is not the last row, so the file order is not the age order.
  rows["chat-7"] = { emittedAtMs: 9000 };
  const path = join(f.directory, `desktop-compaction-${createHash("sha256").update(resolve(f.home)).digest("hex").slice(0, 16)}.json`);
  await writeFile(path, JSON.stringify({ version: 1, threads: rows }), { mode: 0o600 });
  await f.store.observe(terminal("new-chat", "turn", 20000));
  const saved = JSON.parse(await readFile(path, "utf8")) as { threads: Record<string, unknown> };
  assert.equal(Object.keys(saved.threads).length, 4096);
  assert.ok(await f.peer().read("new-chat"), "the new chat is saved");
  assert.equal(await f.peer().read("chat-0"), undefined, "the oldest row made room");
  assert.ok(await f.peer().read("chat-1"), "only one row left");
  assert.ok(await f.peer().read("chat-7"), "a recently observed row stays whatever its position");
  // The store stays usable: the next new chat evicts the next oldest row.
  await f.store.observe(terminal("another", "turn", 20001));
  assert.equal(await f.peer().read("chat-1"), undefined); assert.ok(await f.peer().read("another")); assert.ok(await f.peer().read("new-chat"));
  // An existing chat is rewritten in place and evicts nothing.
  await f.store.observe(terminal("another", "turn-2", 20002));
  assert.ok(await f.peer().read("chat-2"));
});

const maxBytes = 4 * 1024 * 1024;
const storePath = (f: Awaited<ReturnType<typeof fixture>>) => join(f.directory, `desktop-compaction-${createHash("sha256").update(resolve(f.home)).digest("hex").slice(0, 16)}.json`);
type Rows = Record<string, { emittedAtMs: number; compaction?: { turnId: string; status: string; emittedAtMs: number } }>;
const bytes = (threads: Rows) => Buffer.byteLength(JSON.stringify({ version: 1, threads }, null, 2) + "\n");
// A row that carries a 1000-character compaction turn id, so the byte bound is reached long before the 4096-row bound.
const bulky = (letter: string, at: number) => ({ emittedAtMs: at, compaction: { turnId: letter.repeat(1000), status: "completed", emittedAtMs: at } });
/** The most bulky rows, stamped in order, whose file still fits the byte bound. */
function byteFull(): Rows {
  const build = (count: number): Rows => Object.fromEntries(Array.from({ length: count }, (_, index) => [`chat-${index}`, bulky("a", 1000 + index)]));
  let low = 0; let high = 4095;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (bytes(build(middle)) <= maxBytes) low = middle; else high = middle - 1; }
  return build(low);
}
/** Writes a bulky row for a chat through the store: a started item then its terminal event, both stamped `at`. */
async function writeBulky(f: Awaited<ReturnType<typeof fixture>>, threadId: string, letter: string, at: number): Promise<void> {
  const turnId = letter.repeat(1000);
  await f.store.observe(item(threadId, turnId, at));
  await f.store.observe(terminal(threadId, turnId, at));
}

test("a store full by bytes ends within 4 MiB and drops only the oldest rows the new row needs", async () => {
  const f = await fixture();
  const rows = byteFull(); const count = Object.keys(rows).length;
  assert.ok(count > 2000 && count < 4096, "bulky rows reach the byte bound before the row bound");
  await writeFile(storePath(f), JSON.stringify({ version: 1, threads: rows }), { mode: 0o600 });
  await writeBulky(f, "new-chat", "b", 20000);
  const saved = JSON.parse(await readFile(storePath(f), "utf8")) as { threads: Rows };
  assert.ok((await stat(storePath(f))).size <= maxBytes, "the file ends within the byte bound");
  assert.ok(saved.threads["new-chat"], "the chat being written is saved");
  // The fewest oldest rows whose removal lets the new row fit, found by serializing the whole file each time.
  let fewest = 0;
  while (bytes({ ...Object.fromEntries(Object.entries(rows).slice(fewest)), "new-chat": saved.threads["new-chat"] }) > maxBytes) fewest++;
  assert.ok(fewest >= 1, "the store really was too full for the new row");
  const dropped = Object.keys(rows).filter(id => !(id in saved.threads));
  assert.deepEqual(dropped, Object.keys(rows).slice(0, fewest), "exactly the oldest rows went, none beyond what was needed");
  assert.equal(Object.keys(saved.threads).length, count - fewest + 1);
});

test("an existing chat whose row grows past the byte bound evicts the oldest other rows and is itself kept", async () => {
  const f = await fixture();
  const rows = byteFull(); rows["chat-5"] = { emittedAtMs: 1005 };
  // Pad the file with small rows until no other row fits, so the grown row cannot fit without an eviction.
  for (let index = 0; bytes({ ...rows, [`pad-${index}`]: { emittedAtMs: 3000 + index } }) <= maxBytes; index++) rows[`pad-${index}`] = { emittedAtMs: 3000 + index };
  await writeFile(storePath(f), JSON.stringify({ version: 1, threads: rows }), { mode: 0o600 });
  assert.ok(bytes(rows) <= maxBytes, "the file fits before the row grows");
  await writeBulky(f, "chat-5", "c", 20000);
  const saved = JSON.parse(await readFile(storePath(f), "utf8")) as { threads: Rows };
  assert.ok((await stat(storePath(f))).size <= maxBytes);
  assert.equal(saved.threads["chat-5"].compaction?.turnId, "c".repeat(1000), "the grown row is saved whole");
  assert.equal(saved.threads["chat-0"], undefined, "the oldest other row made room");
});

test("the chat being written is never evicted, even when its stamp is older than every other row", async () => {
  const f = await fixture();
  const rows: Rows = Object.fromEntries(Array.from({ length: 4096 }, (_, index) => [`chat-${index}`, { emittedAtMs: 1000 + index }]));
  await writeFile(storePath(f), JSON.stringify({ version: 1, threads: rows }), { mode: 0o600 });
  await f.store.observe(terminal("oldest", "turn", 10));
  let saved = JSON.parse(await readFile(storePath(f), "utf8")) as { threads: Rows };
  assert.equal(Object.keys(saved.threads).length, 4096);
  assert.deepEqual(saved.threads.oldest, { emittedAtMs: 10 }, "its row, the oldest of all, stayed");
  assert.equal(saved.threads["chat-0"], undefined, "the oldest other row went instead");
  assert.ok(saved.threads["chat-1"]);
  // The same holds by bytes: a bulky row stamped older than all the others keeps itself.
  const full = byteFull(); await writeFile(storePath(f), JSON.stringify({ version: 1, threads: full }), { mode: 0o600 });
  await writeBulky(f, "oldest-bulky", "d", 10);
  saved = JSON.parse(await readFile(storePath(f), "utf8")) as { threads: Rows };
  assert.ok(saved.threads["oldest-bulky"], "kept although it is the oldest row");
  assert.equal(saved.threads["chat-0"], undefined);
  assert.ok((await stat(storePath(f))).size <= maxBytes);
});
