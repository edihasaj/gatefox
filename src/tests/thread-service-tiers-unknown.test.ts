import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ThreadServiceTiers } from "../thread-service-tiers.js";
import { oldBuildAccepts } from "./thread-tier-0-4-0-parser.js";

const fast = { model: "gateway/model", serviceTier: "priority" };
const standard = { model: "gateway/model", serviceTier: null };
const unknown = { model: "gateway/model" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-thread-tiers-unknown-"));
  const state = join(root, "state"); const native = join(root, "native"); await mkdir(native, { mode: 0o700 });
  const scope = createHash("sha256").update(resolve(native)).digest("hex").slice(0, 16);
  const path = join(state, `desktop-thread-tiers-${scope}.json`);
  return { root, state, path, store: new ThreadServiceTiers(state, native), file: async () => JSON.parse(await readFile(path, "utf8")) as { version: number; threads: Record<string, Record<string, unknown>> },
    close: () => rm(root, { recursive: true, force: true }) };
}

test("an unknown tier removes the chat's row, keeps a 0.4.0-readable marker, and reads as no record", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 100 }), true);
    assert.equal(await f.store.write("other", fast), true);
    assert.equal(await f.store.markUnknown("chat", { ...unknown, emittedAtMs: 200 }), true);
    assert.equal(await f.store.read("chat"), undefined);
    assert.equal((await f.store.read("other"))?.serviceTier, "priority", "unrelated chats are untouched");
    const saved = await f.file();
    assert.equal(Object.hasOwn(saved.threads, "chat"), false);
    const markers = Object.entries(saved.threads).filter(([id]) => id !== "other");
    assert.equal(markers.length, 1);
    assert.deepEqual(markers[0][1], { model: "gateway/model", serviceTier: null, revision: 2, emittedAtMs: 200 });
    // The old build loads the whole file and finds no record for the chat.
    const old = oldBuildAccepts(saved);
    assert.equal(Object.hasOwn(old, "chat"), false);
    assert.equal(old.other.serviceTier, "priority");
    assert.ok(!JSON.stringify(saved).includes("chat"), "the marker key does not carry the chat id");
  } finally { await f.close(); }
});

test("an older notification cannot bring a tier back after an unknown one, and a newer one replaces the marker", async () => {
  const f = await fixture();
  try {
    await f.store.write("chat", { ...fast, emittedAtMs: 100 });
    await f.store.markUnknown("chat", { ...unknown, emittedAtMs: 200 });
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 150 }), false);
    assert.equal(await f.store.write("chat", { ...standard, emittedAtMs: 199 }), false);
    assert.equal(await f.store.markUnknown("chat", { model: "other/model", emittedAtMs: 120 }), false);
    assert.equal(await f.store.read("chat"), undefined);
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 300 }), true);
    assert.deepEqual(await f.store.read("chat"), { ...fast, revision: 3, emittedAtMs: 300 });
    const saved = await f.file();
    assert.deepEqual(Object.keys(saved.threads), ["chat"], "the marker is gone once a tier is known again");
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 250 }), false, "its watermark moved to the chat's row");
    oldBuildAccepts(saved);
  } finally { await f.close(); }
});

test("an unknown tier with no earlier record still blocks older notifications", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.store.markUnknown("chat", { ...unknown, emittedAtMs: 500 }), true);
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 400 }), false);
    assert.equal(await f.store.read("chat"), undefined);
    assert.equal(await f.store.markUnknown("chat", { ...unknown, emittedAtMs: 500 }), true, "a duplicate is accepted without change");
    assert.equal((await f.file()).threads[Object.keys((await f.file()).threads)[0]].revision, 1);
  } finally { await f.close(); }
});

test("same-millisecond ties with an unknown tier resolve to Standard like other ambiguous ties", async () => {
  const f = await fixture();
  try {
    await f.store.write("fastchat", { ...fast, emittedAtMs: 100 });
    assert.equal(await f.store.markUnknown("fastchat", { ...unknown, emittedAtMs: 100 }), true);
    assert.deepEqual(await f.store.read("fastchat"), { ...standard, revision: 2, emittedAtMs: 100 });
    await f.store.write("stdchat", { ...standard, emittedAtMs: 100 });
    assert.equal(await f.store.markUnknown("stdchat", { ...unknown, emittedAtMs: 100 }), false, "Standard wins a tie");
    assert.equal((await f.store.read("stdchat"))?.serviceTier, null);
    await f.store.markUnknown("unkchat", { ...unknown, emittedAtMs: 100 });
    assert.equal(await f.store.write("unkchat", { ...fast, emittedAtMs: 100 }), true);
    assert.equal((await f.store.read("unkchat"))?.serviceTier, null, "a known tier tying an unknown one resolves to Standard");
  } finally { await f.close(); }
});

test("an unknown tier honors the clock-uncertainty watermark", async () => {
  const f = await fixture();
  try {
    await f.store.write("chat", { ...fast, emittedAtMs: 9000 });
    // A confirmed snapshot far older than the stored event marks everything up to 9000 uncertain.
    await f.store.write("chat", standard, undefined, 1000);
    assert.equal(await f.store.markUnknown("chat", { ...unknown, emittedAtMs: 5000 }), false);
  } finally { await f.close(); }
});

test("a snapshot answer records an unknown tier with revision CAS and keeps the watermark across it", async () => {
  const f = await fixture();
  try {
    await f.store.write("chat", fast, null, 1000);
    const current = (await f.store.read("chat"))!;
    assert.equal(await f.store.markUnknown("chat", unknown, { ...current, serviceTier: "turbo" }, 2000), false, "a stale expectation is rejected");
    assert.equal((await f.store.read("chat"))?.serviceTier, "priority");
    assert.equal(await f.store.markUnknown("chat", unknown, current, 2000), true);
    assert.equal(await f.store.read("chat"), undefined);
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 1500 }), false, "the snapshot time is the watermark");
    // A later snapshot expecting no record establishes a tier again and drops the marker.
    assert.equal(await f.store.write("chat", fast, null, 3000), true);
    assert.deepEqual(Object.keys((await f.file()).threads), ["chat"]);
  } finally { await f.close(); }
});

test("when 0.4.0 wrote a newer row after a marker the row wins, and a newer marker wins over an older row", async () => {
  const f = await fixture();
  try {
    await f.store.markUnknown("chat", { ...unknown, emittedAtMs: 200 });
    const saved = await f.file();
    await writeFile(f.path, JSON.stringify({ ...saved, threads: { ...saved.threads, chat: { ...fast, revision: 5, emittedAtMs: 300 } } }), { mode: 0o600 });
    assert.equal((await f.store.read("chat"))?.serviceTier, "priority");
    await writeFile(f.path, JSON.stringify({ ...saved, threads: { ...saved.threads, chat: { ...fast, revision: 5, emittedAtMs: 100 } } }), { mode: 0o600 });
    assert.equal(await f.store.read("chat"), undefined);
    // A tie is unknown, which forwards no tier.
    await writeFile(f.path, JSON.stringify({ ...saved, threads: { ...saved.threads, chat: { ...fast, revision: 5, emittedAtMs: 200 } } }), { mode: 0o600 });
    assert.equal(await f.store.read("chat"), undefined);
    // With the marker in force, a snapshot that expects no record succeeds, and the new revision passes both old ones.
    assert.equal(await f.store.write("chat", fast, null, 400), true);
    const after = await f.file();
    assert.deepEqual(Object.keys(after.threads), ["chat"]);
    assert.equal(after.threads.chat.revision, 6);
  } finally { await f.close(); }
});

test("an unknown tier rejects an invalid model or timestamp without writing", async () => {
  const f = await fixture();
  try {
    for (const bad of [{ model: "" }, { model: "m".repeat(1025) }, { model: "m\0" }, { model: "m", emittedAtMs: -1 }, { model: "m", emittedAtMs: 1.5 }])
      await assert.rejects(f.store.markUnknown("chat", bad), /invalid/);
    await assert.rejects(f.store.markUnknown("", unknown), /invalid/);
    await assert.rejects(f.store.markUnknown("chat", unknown, null, -1), /invalid/);
    await assert.rejects(readFile(f.path), /ENOENT/);
  } finally { await f.close(); }
});

test("a row 0.4.0 wrote inside the marker's uncertainty window does not outvote the marker", async () => {
  const f = await fixture();
  try {
    await mkdir(f.state, { mode: 0o700 });
    const key = `tier-unknown:${createHash("sha256").update("chat").digest("hex")}`;
    const marker = { ...standard, revision: 2, emittedAtMs: 1000, uncertainBeforeMs: 9000 };
    const put = (row: Record<string, unknown>) => writeFile(f.path, JSON.stringify({ version: 1, threads: { [key]: marker, chat: row } }), { mode: 0o600 });
    // 0.4.0 knew nothing of the watermark: its Fast row at 5000 is newer than the marker's 1000 but older than the window's end.
    await put({ ...fast, revision: 3, emittedAtMs: 5000 });
    assert.equal(await f.store.read("chat"), undefined, "the unknown tier still wins");
    await put({ ...fast, revision: 3 });
    assert.equal(await f.store.read("chat"), undefined, "an unstamped Fast row is inside the window");
    await put({ ...standard, revision: 3, emittedAtMs: 5000 });
    assert.equal((await f.store.read("chat"))?.serviceTier, null, "Standard is always safe to trust");
    await put({ ...fast, revision: 3, emittedAtMs: 9500 });
    assert.equal((await f.store.read("chat"))?.serviceTier, "priority", "a row past the window wins");
    await put({ ...fast, revision: 3, emittedAtMs: 5000 });
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 8000 }), false, "a write cannot bring the tier back inside the window");
    assert.equal(await f.store.read("chat"), undefined);
  } finally { await f.close(); }
});

// The file a 0.4.0 build leaves behind: it never looks the marker up, so it writes the chat's row from nothing (revision 1, no window).
const markerOf = (chat: string) => `tier-unknown:${createHash("sha256").update(chat).digest("hex")}`;

test("a Standard row 0.4.0 wrote beats the marker but keeps its uncertainty window against a stale Fast notification", async () => {
  const f = await fixture();
  try {
    await f.store.write("chat", { ...fast, emittedAtMs: 9000 });
    // A resume snapshot far older than the stored event marks everything up to 9000 uncertain, then reports an odd tier.
    const current = (await f.store.read("chat"))!;
    assert.equal(await f.store.markUnknown("chat", unknown, current, 1000), true);
    const saved = await f.file();
    assert.deepEqual(saved.threads[markerOf("chat")], { model: "gateway/model", serviceTier: null, revision: 2, emittedAtMs: 1000, uncertainBeforeMs: 9000 });
    // The downgraded build then records Standard at 5000. That row is newer than the marker and is trusted.
    await writeFile(f.path, JSON.stringify({ ...saved, threads: { ...saved.threads, chat: { ...standard, revision: 1, emittedAtMs: 5000 } } }), { mode: 0o600 });
    assert.equal((await f.store.read("chat"))?.serviceTier, null);
    assert.equal((await f.store.read("chat"))?.uncertainBeforeMs, 9000, "the marker's window survives");
    // A slow client now delivers an old Fast, stamped inside that window (6000) and exactly at its end (9000).
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 6000 }), false);
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 9000 }), false);
    assert.equal((await f.store.read("chat"))?.serviceTier, null, "Standard stands");
    // A later Standard carries the window into the row it writes, and the marker is gone.
    assert.equal(await f.store.write("chat", { ...standard, emittedAtMs: 7000 }), true);
    const after = await f.file();
    assert.deepEqual(Object.keys(after.threads), ["chat"]);
    assert.equal(after.threads.chat.uncertainBeforeMs, 9000);
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 8000 }), false);
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 9001 }), true, "a Fast past the window is honored");
    oldBuildAccepts(await f.file());
  } finally { await f.close(); }
});

test("a non-Standard row stamped exactly at the marker's uncertainty end is not trusted, and one a millisecond later is", async () => {
  const f = await fixture();
  try {
    await mkdir(f.state, { mode: 0o700 });
    const marker = { ...standard, revision: 2, emittedAtMs: 1000, uncertainBeforeMs: 9000 };
    const put = (row: Record<string, unknown>) => writeFile(f.path, JSON.stringify({ version: 1, threads: { [markerOf("chat")]: marker, chat: row } }), { mode: 0o600 });
    await put({ ...fast, revision: 3, emittedAtMs: 9000 });
    assert.equal(await f.store.read("chat"), undefined, "the window includes its last millisecond");
    await put({ ...fast, revision: 3, emittedAtMs: 9001 });
    assert.equal((await f.store.read("chat"))?.serviceTier, "priority");
    // The same boundary for a notification written while only the marker exists.
    await writeFile(f.path, JSON.stringify({ version: 1, threads: { [markerOf("chat")]: marker } }), { mode: 0o600 });
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 9000 }), false);
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 9001 }), true);
  } finally { await f.close(); }
});

test("when a trusted row and the marker both carry a window, the later end applies", async () => {
  const f = await fixture();
  try {
    await mkdir(f.state, { mode: 0o700 });
    const put = (row: Record<string, unknown>, window: number) => writeFile(f.path, JSON.stringify({ version: 1, threads: {
      [markerOf("chat")]: { ...standard, revision: 2, emittedAtMs: 1000, uncertainBeforeMs: window }, chat: row } }), { mode: 0o600 });
    await put({ ...standard, revision: 3, emittedAtMs: 5000, uncertainBeforeMs: 9000 }, 3000);
    assert.equal((await f.store.read("chat"))?.uncertainBeforeMs, 9000, "the row's own window is longer");
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 8000 }), false);
    await put({ ...standard, revision: 3, emittedAtMs: 5000, uncertainBeforeMs: 3000 }, 9000);
    assert.equal((await f.store.read("chat"))?.uncertainBeforeMs, 9000, "the marker's window is longer");
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 8000 }), false);
    await put({ ...standard, revision: 3, emittedAtMs: 5000 }, 3000);
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 4000 }), false, "older than the row");
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 6000 }), true, "past the marker's window and newer than the row");
  } finally { await f.close(); }
});
