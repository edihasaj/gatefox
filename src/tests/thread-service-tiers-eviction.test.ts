import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ThreadServiceTiers, type ThreadServiceTier } from "../thread-service-tiers.js";

const maxBytes = 4 * 1024 * 1024; const maxThreads = 16384;
const standard = { model: "gateway/model", serviceTier: null };
const longModel = (letter: string) => letter.repeat(1024);
const pretty = (threads: Record<string, ThreadServiceTier>) => JSON.stringify({ version: 1, threads }, null, 2) + "\n";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-tier-eviction-"));
  const state = join(root, "state"); const native = join(root, "native"); await mkdir(native, { mode: 0o700 }); await mkdir(state, { mode: 0o700 });
  const scope = createHash("sha256").update(resolve(native)).digest("hex").slice(0, 16);
  const path = join(state, `desktop-thread-tiers-${scope}.json`);
  return { path, store: new ThreadServiceTiers(state, native), close: () => rm(root, { recursive: true, force: true }),
    async threads(): Promise<Record<string, ThreadServiceTier>> { return JSON.parse(await readFile(path, "utf8")).threads; } };
}
// The extra rows first, then rows with 1 KiB model names (what the 1024 character limit allows) up to the largest count that still fits the byte limit.
function fullRows(extra: Record<string, ThreadServiceTier> = {}): Record<string, ThreadServiceTier> {
  const build = (count: number) => ({ ...extra, ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`chat-${i}`, { model: longModel("m"), serviceTier: null, emittedAtMs: 1000 + i }])) });
  let low = 0; let high = maxThreads;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (Buffer.byteLength(pretty(build(middle))) <= maxBytes) low = middle; else high = middle - 1; }
  return build(low);
}

test("a store full by size accepts a new chat by evicting only the oldest rows, never the new chat", async () => {
  const f = await fixture();
  try {
    const rows = fullRows(); const count = Object.keys(rows).length;
    assert.ok(count > 3000 && count < maxThreads, "long model names reach the byte limit before the row limit");
    await writeFile(f.path, pretty(rows), { mode: 0o600 });
    // A new chat has no record time of its own: it would be the first candidate if it were not protected.
    assert.equal(await f.store.write("new-chat", { model: longModel("n"), serviceTier: null }), true);
    const saved = await f.threads();
    assert.ok((await stat(f.path)).size <= maxBytes, "the file stays within the byte limit");
    assert.deepEqual(saved["new-chat"], { model: longModel("n"), serviceTier: null, revision: 1 }, "the chat being written is kept");
    const evicted = Object.keys(rows).filter(id => !(id in saved));
    assert.ok(evicted.length >= 1 && evicted.length <= 2, `only the rows needed were dropped, got ${evicted.length}`);
    assert.deepEqual(evicted, Object.keys(rows).slice(0, evicted.length), "the oldest-stamped rows were the ones dropped");
    assert.equal(Object.keys(saved).length, count - evicted.length + 1);
    assert.equal(await f.store.write("another", { model: longModel("a"), serviceTier: null }), true, "a store that was already trimmed keeps accepting chats");
    assert.ok((await stat(f.path)).size <= maxBytes); assert.ok("another" in await f.threads());
  } finally { await f.close(); }
});

test("an existing chat that grows past the byte limit evicts other chats instead of failing", async () => {
  const f = await fixture();
  try {
    const rows = fullRows({ short: { model: "s", serviceTier: null, emittedAtMs: 5000 } });
    await writeFile(f.path, pretty(rows), { mode: 0o600 });
    assert.equal(await f.store.write("short", { model: longModel("g"), serviceTier: null }), true);
    const saved = await f.threads();
    assert.equal(saved.short.model, longModel("g")); assert.equal(saved["chat-0"], undefined);
    assert.ok((await stat(f.path)).size <= maxBytes);
  } finally { await f.close(); }
});

test("rows that were never stamped are evicted before older stamped rows when the size limit is hit", async () => {
  const f = await fixture();
  try {
    // The stamped row is the oldest stamped and sorts before the unstamped one by insertion order.
    const ordered = fullRows({ "ancient-stamped": { model: longModel("a"), serviceTier: null, emittedAtMs: 0 }, "never-stamped": { model: longModel("u"), serviceTier: null } });
    await writeFile(f.path, pretty(ordered), { mode: 0o600 });
    assert.equal(await f.store.write("new-chat", { model: longModel("n"), serviceTier: null }), true);
    const saved = await f.threads();
    assert.equal(saved["never-stamped"], undefined, "the unstamped row went first");
    assert.ok(saved["ancient-stamped"], "an older stamped row survived it");
    assert.ok(saved["new-chat"]);
  } finally { await f.close(); }
});

test("rows that were never stamped are evicted first when the row limit is hit", async () => {
  const f = await fixture();
  try {
    const threads: Record<string, ThreadServiceTier> = { "ancient-stamped": { ...standard, emittedAtMs: 0 }, "never-stamped": { ...standard } };
    for (let i = 0; i < maxThreads - 2; i++) threads[`chat-${i}`] = { ...standard, emittedAtMs: 1000 + i };
    await writeFile(f.path, pretty(threads), { mode: 0o600 });
    assert.equal(await f.store.write("new-chat", standard), true);
    const saved = await f.threads();
    assert.equal(Object.keys(saved).length, maxThreads);
    assert.equal(saved["never-stamped"], undefined); assert.ok(saved["ancient-stamped"] && saved["chat-0"] && saved["new-chat"]);
  } finally { await f.close(); }
});
