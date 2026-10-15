import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ThreadServiceTiers, type ThreadServiceTier } from "../thread-service-tiers.js";
import { oldBuildAccepts } from "./thread-tier-0-4-0-parser.js";

const maxBytes = 4 * 1024 * 1024; const maxThreads = 16384;
const fast = { model: "gateway/model", serviceTier: "priority" };
const standard = { model: "gateway/model", serviceTier: null };
const longModel = (letter: string) => letter.repeat(1024);
const markerKey = (id: string) => `tier-unknown:${createHash("sha256").update(id).digest("hex")}`;
const pretty = (threads: Record<string, ThreadServiceTier>) => JSON.stringify({ version: 1, threads }, null, 2) + "\n";
const size = (threads: Record<string, ThreadServiceTier>) => Buffer.byteLength(pretty(threads));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-tier-marker-room-"));
  const state = join(root, "state"); const native = join(root, "native"); await mkdir(native, { mode: 0o700 }); await mkdir(state, { mode: 0o700 });
  const scope = createHash("sha256").update(resolve(native)).digest("hex").slice(0, 16);
  const path = join(state, `desktop-thread-tiers-${scope}.json`);
  return { path, store: new ThreadServiceTiers(state, native), close: () => rm(root, { recursive: true, force: true }),
    put: (threads: Record<string, ThreadServiceTier>) => writeFile(path, pretty(threads), { mode: 0o600 }),
    async threads(): Promise<Record<string, ThreadServiceTier>> { const saved = JSON.parse(await readFile(path, "utf8")); oldBuildAccepts(saved); return saved.threads; } };
}
/** Exactly maxThreads rows: `extra` first, then standard chats stamped in order. */
function countFull(extra: Record<string, ThreadServiceTier> = {}): Record<string, ThreadServiceTier> {
  const others = maxThreads - Object.keys(extra).length;
  return { ...extra, ...Object.fromEntries(Array.from({ length: others }, (_, i) => [`chat-${i}`, { ...standard, emittedAtMs: 1000 + i }])) };
}
/** The most rows with 1 KiB model names that fit the byte limit; every `unit` row is a marker when `markers` is set. */
function sizeFull(markers: boolean): Record<string, ThreadServiceTier> {
  const build = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) =>
    [markers ? markerKey(`chat-${i}`) : `chat-${i}`, { model: longModel("m"), serviceTier: null, emittedAtMs: 1000 + i }]));
  let low = 0; let high = maxThreads;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (size(build(middle)) <= maxBytes) low = middle; else high = middle - 1; }
  return build(low);
}
const chats = (count: number, from = 6000): Record<string, ThreadServiceTier> =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`chat-${i}`, { ...standard, emittedAtMs: from + i }]));
const names = (threads: Record<string, ThreadServiceTier>) => Object.keys(threads);

test("an unknown tier for a new chat in a store full by count evicts the oldest chat instead of failing", async () => {
  const f = await fixture();
  try {
    await f.put(countFull());
    assert.equal(await f.store.markUnknown("new-chat", { model: "gateway/model", emittedAtMs: 5000 }), true);
    const saved = await f.threads();
    assert.equal(names(saved).length, maxThreads);
    assert.equal(saved["chat-0"], undefined, "the oldest chat went");
    assert.equal(saved["chat-1"], undefined, "the pair adds two entries, so a second chat went");
    assert.ok(saved["chat-2"] && saved[markerKey("new-chat")] && saved["new-chat"], "the marker and its Standard row are kept");
    assert.equal(await f.store.read("new-chat"), undefined);
    assert.equal(await f.store.write("new-chat", { ...fast, emittedAtMs: 4000 }), false, "the marker's watermark still blocks an older tier");
  } finally { await f.close(); }
});

for (const markers of [false, true]) test(`an unknown tier in a store full by size (${markers ? "markers" : "rows"}) evicts exactly the oldest chats it needs`, async () => {
  const f = await fixture();
  try {
    const rows = sizeFull(markers); const count = names(rows).length;
    assert.ok(count > 2000 && count < maxThreads, "long model names reach the byte limit before the row limit");
    await f.put(rows);
    const model = longModel("n");
    assert.equal(await f.store.markUnknown("new-chat", { model, emittedAtMs: 5000 }), true);
    const saved = await f.threads(); const marker = saved[markerKey("new-chat")];
    assert.deepEqual(marker, { model, serviceTier: null, revision: 1, emittedAtMs: 5000 });
    assert.deepEqual(saved["new-chat"], marker, "the chat's Standard row carries the marker's stamp");
    assert.ok((await stat(f.path)).size <= maxBytes);
    const evicted = names(rows).filter(id => !(id in saved));
    // The fewest oldest rows whose removal lets the pair fit, found by serializing the whole file each time.
    let fewest = 0; while (size({ ...Object.fromEntries(names(rows).slice(fewest).map(id => [id, rows[id]])), "new-chat": saved["new-chat"], [markerKey("new-chat")]: marker }) > maxBytes) fewest++;
    assert.ok(fewest >= 1, "the store really was too full for the pair");
    assert.equal(evicted.length, fewest, "both entries are counted by their exact size, no more rows are dropped");
    assert.deepEqual(evicted, names(rows).slice(0, fewest));
  } finally { await f.close(); }
});

test("a known tier written over a store full of markers evicts by their exact size too", async () => {
  const f = await fixture();
  try {
    const rows = sizeFull(true); await f.put(rows);
    assert.equal(await f.store.write("new-chat", { model: longModel("n"), serviceTier: null }), true);
    const saved = await f.threads();
    assert.ok((await stat(f.path)).size <= maxBytes);
    assert.ok(saved["new-chat"]);
    const evicted = names(rows).filter(id => !(id in saved));
    let fewest = 0; while (size({ ...Object.fromEntries(names(rows).slice(fewest).map(id => [id, rows[id]])), "new-chat": saved["new-chat"] }) > maxBytes) fewest++;
    assert.ok(fewest >= 1, "the store really was too full for the chat");
    assert.equal(evicted.length, fewest, "no more markers were dropped than needed");
    assert.deepEqual(evicted, names(rows).slice(0, fewest));
  } finally { await f.close(); }
});

test("at the row limit a known tier for a chat that only has a marker evicts nobody", async () => {
  const f = await fixture();
  try {
    await f.put(countFull({ [markerKey("marked")]: { ...standard, revision: 1, emittedAtMs: 500 } }));
    assert.equal(await f.store.write("marked", { ...fast, emittedAtMs: 600 }), true);
    const saved = await f.threads();
    assert.equal(names(saved).length, maxThreads);
    assert.equal(saved[markerKey("marked")], undefined, "the marker gave way to the row");
    assert.equal(saved.marked.serviceTier, "priority");
    assert.ok(saved["chat-0"], "no other chat was evicted");
    assert.equal((await f.store.read("marked"))?.serviceTier, "priority");
  } finally { await f.close(); }
});

test("at the row limit an unknown tier for a chat that already has a row evicts exactly one other chat", async () => {
  const f = await fixture();
  try {
    await f.put(countFull({ chat: { ...fast, revision: 1, emittedAtMs: 500 } }));
    assert.equal(await f.store.markUnknown("chat", { model: "gateway/model", emittedAtMs: 600 }), true);
    const saved = await f.threads();
    assert.equal(names(saved).length, maxThreads);
    assert.deepEqual(saved.chat, { model: "gateway/model", serviceTier: null, revision: 2, emittedAtMs: 600 }, "the row became Standard beside the marker");
    assert.ok(saved[markerKey("chat")], "the marker is kept");
    assert.equal(saved["chat-0"], undefined, "the marker is one entry more than the row, so the oldest other chat went");
    assert.ok(saved["chat-1"]);
    assert.equal(await f.store.read("chat"), undefined);
  } finally { await f.close(); }
});

test("a chat's row and marker are evicted together, by the newest stamp of either", async () => {
  const f = await fixture();
  try {
    // A 0.4.0 downgrade left Fast at 5000 beside a marker (1000, uncertain until 9000) that still wins: evicting the marker alone would bring Fast back.
    const pair = { chat: { ...fast, revision: 3, emittedAtMs: 5000 }, [markerKey("chat")]: { ...standard, revision: 2, emittedAtMs: 1000, uncertainBeforeMs: 9000 } };
    await f.put({ ...pair, single: { ...standard, emittedAtMs: 3000 }, ...chats(maxThreads - 3) });
    assert.equal(await f.store.write("new-chat", standard), true);
    let saved = await f.threads();
    assert.equal(saved.single, undefined, "the single row (3000) is older than the pair (newest 5000)");
    assert.ok(saved.chat && saved[markerKey("chat")], "the pair stays whole");
    assert.equal(await f.store.read("chat"), undefined, "the marker still wins");
    // Now the pair is the oldest chat: both of its entries go together, one eviction making room for the next chat.
    await f.put({ ...pair, ...chats(maxThreads - 2) });
    assert.equal(await f.store.write("new-chat", standard), true);
    saved = await f.threads();
    assert.equal(saved.chat, undefined); assert.equal(saved[markerKey("chat")], undefined);
    assert.ok(saved["chat-0"] && saved["new-chat"]);
    assert.equal(names(saved).length, maxThreads - 1);
  } finally { await f.close(); }
});

test("a pair whose marker is newer than its row is aged by the marker", async () => {
  const f = await fixture();
  try {
    // The row is old (1000) but the marker is recent (5000): the pair is newer than a single chat at 3000.
    const pair = { chat: { ...fast, revision: 1, emittedAtMs: 1000 }, [markerKey("chat")]: { ...standard, revision: 2, emittedAtMs: 5000 } };
    await f.put({ ...pair, single: { ...standard, emittedAtMs: 3000 }, ...chats(maxThreads - 3) });
    assert.equal(await f.store.write("new-chat", standard), true);
    const saved = await f.threads();
    assert.equal(saved.single, undefined, "the single row (3000) goes before the pair (newest 5000)");
    assert.ok(saved.chat && saved[markerKey("chat")], "the pair stays whole");
  } finally { await f.close(); }
});

test("in a store full by count a marker with the oldest stamp of all keeps itself and evicts the oldest other chat", async () => {
  const f = await fixture();
  try {
    await f.put(countFull());
    assert.equal(await f.store.markUnknown("new-chat", { model: "gateway/model", emittedAtMs: 500 }), true);
    const saved = await f.threads();
    assert.equal(names(saved).length, maxThreads);
    assert.ok(saved[markerKey("new-chat")] && saved["new-chat"], "the marker and its row stayed although they are the oldest entries");
    assert.equal(saved["chat-0"], undefined, "the oldest other chats went instead");
    assert.equal(saved["chat-1"], undefined);
    assert.ok(saved["chat-2"]);
    assert.equal(await f.store.write("new-chat", { ...fast, emittedAtMs: 400 }), false, "its watermark still blocks an older tier");
  } finally { await f.close(); }
});

test("in a store full by count a known tier with the oldest stamp of all keeps its own row", async () => {
  const f = await fixture();
  try {
    await f.put(countFull());
    assert.equal(await f.store.write("new-chat", { ...fast, emittedAtMs: 500 }), true);
    const saved = await f.threads();
    assert.equal(names(saved).length, maxThreads);
    assert.equal(saved["new-chat"]?.serviceTier, "priority");
    assert.equal(saved["chat-0"], undefined);
  } finally { await f.close(); }
});

test("the Standard row and marker of an unknown chat are evicted together when that chat is the oldest", async () => {
  const f = await fixture();
  try {
    const pair = { chat: { ...standard, revision: 1, emittedAtMs: 100 }, [markerKey("chat")]: { ...standard, revision: 1, emittedAtMs: 100 } };
    await f.put({ ...pair, ...chats(maxThreads - 2) });
    assert.equal(await f.store.write("new-chat", standard), true);
    const saved = await f.threads();
    assert.equal(saved.chat, undefined); assert.equal(saved[markerKey("chat")], undefined);
    assert.ok(saved["chat-0"] && saved["new-chat"]);
    assert.equal(names(saved).length, maxThreads - 1, "the pair left whole, never one half");
    // The chat being written keeps both entries even when its stamp is the oldest of all.
    await f.put({ ...pair, ...chats(maxThreads - 2) });
    assert.equal(await f.store.markUnknown("chat", { model: "gateway/model", emittedAtMs: 100 }), true);
    const kept = await f.threads();
    assert.ok(kept.chat && kept[markerKey("chat")] && kept["chat-0"]);
  } finally { await f.close(); }
});
