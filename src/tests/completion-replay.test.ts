import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompletionReplay, completionReplayStorage, type CompletionReplayEntry, type CompletionReplayStorage } from "../completion-replay.js";
import type { Message } from "../app-server-connection.js";
import { writePrivateJson } from "../config.js";

const now = 2_000_000_000_000;
const ledgerKey = (device = "local", threadId = "thread") => `${device}\0${threadId}`;
const saved = async (storage: CompletionReplayStorage, device = "local", threadId = "thread") => (await storage.read())[ledgerKey(device, threadId)]!;
const turn = (id = "turn", status = "completed", completedAt = now / 1000): Message => ({ id, status, completedAt });
function memory(initial: Record<string, CompletionReplayEntry> = {}): CompletionReplayStorage {
  let entries = structuredClone(initial);
  return { read: async () => structuredClone(entries), update: async change => change(entries) };
}
function fixture(storage = memory(), request = async (): Promise<Message> => ({ data: [turn()] }), clock = () => now, device = "local", awaitClient = false) {
  const sent: Message[] = [], events: Array<{ event: string; fields: Message }> = [];
  const replay = new CompletionReplay({ storage, request, emit: async message => { sent.push(message); }, clock,
    record: (event, fields) => events.push({ event, fields }), device, awaitClient });
  return { replay, sent, events, storage };
}
const follow = (replay: CompletionReplay, threadId = "thread", turnId = "turn") => replay.forward({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
const complete = (replay: CompletionReplay, threadId = "thread", turnId = "turn") => replay.forward({ method: "turn/completed", params: { threadId, turn: turn(turnId) } });
async function live(replay: CompletionReplay, threadId = "thread", turnId = "turn"): Promise<boolean> {
  const message = { method: "turn/completed", params: { threadId, turn: turn(turnId) } }; const forwarded = replay.forward(message);
  if (forwarded) await replay.written(message); return forwarded;
}

test("a delivered live terminal is never replayed", async () => {
  const f = fixture(); follow(f.replay); await live(f.replay); await f.replay.settled(); await f.replay.resume("thread");
  assert.equal(f.sent.length, 0); assert.equal((await saved(f.storage)).delivered, true);
});

test("an undelivered terminal replays once, unchanged, then becomes delivered", async () => {
  const sdkTurn = turn("turn", "completed"); const f = fixture(memory(), async () => ({ data: [sdkTurn] }));
  follow(f.replay); await f.replay.settled(); await f.replay.resume("thread"); await f.replay.settled();
  assert.deepEqual(f.sent, [{ method: "turn/completed", params: { threadId: "thread", turn: sdkTurn } }]);
  assert.equal((await saved(f.storage)).delivered, true);
  await f.replay.resume("thread"); assert.equal(f.sent.length, 1, "a second resume does not replay");
  const later = fixture(f.storage); await later.replay.resume("thread"); assert.equal(later.sent.length, 0, "a new session does not replay");
  assert.deepEqual(f.events, [{ event: "completion_replayed", fields: { outcome: "delivered" } }]);
});

for (const [name, response, outcome] of [
  ["a newer turn", async () => ({ data: [turn("newer")] }), "turn_changed"],
  ["a running turn", async () => ({ data: [turn("turn", "inProgress")] }), "not_terminal"],
  ["an old terminal", async () => ({ data: [turn("turn", "completed", (now - 24 * 60 * 60 * 1000 - 1) / 1000)] }), "stale"],
  ["a failed lookup", async () => { throw Error("unavailable"); }, "lookup_failed"],
] as const) test(`an undelivered entry skips ${name}`, async () => {
  const f = fixture(memory(), response); follow(f.replay); await f.replay.settled(); await f.replay.resume("thread");
  assert.equal(f.sent.length, 0); assert.deepEqual(f.events, [{ event: "completion_replayed", fields: { outcome } }]);
});

test("live and replay paths share synchronous session deduplication", async () => {
  const f = fixture(); follow(f.replay); await f.replay.settled(); await f.replay.resume("thread");
  assert.equal(complete(f.replay), false, "a live terminal after replay is suppressed");
  const second = fixture(memory()); follow(second.replay); await second.replay.settled(); complete(second.replay); await second.replay.resume("thread");
  assert.equal(second.sent.length, 0, "a replay after the live path is suppressed in this session");
  assert.deepEqual(second.events, [{ event: "completion_replayed", fields: { outcome: "already_delivered_in_session" } }]);
});

test("an atomic claim lets only one concurrent resume replay", async () => {
  const storage = memory(); const first = fixture(storage), second = fixture(storage); follow(first.replay); await first.replay.settled();
  await Promise.all([first.replay.resume("thread"), second.replay.resume("thread")]);
  assert.equal(first.sent.length + second.sent.length, 1); assert.equal((await saved(storage)).delivered, true);
});

test("each device replays its own missed terminal, but a live device does not", async () => {
  const storage = memory(); const first = fixture(storage, undefined, undefined, "first"), second = fixture(storage, undefined, undefined, "second");
  follow(first.replay); follow(second.replay); await Promise.all([first.replay.settled(), second.replay.settled()]);
  await Promise.all([first.replay.resume("thread"), second.replay.resume("thread")]);
  assert.equal(first.sent.length, 1); assert.equal(second.sent.length, 1);
  await first.replay.resume("thread"); await second.replay.resume("thread"); assert.equal(first.sent.length + second.sent.length, 2);
  const liveStorage = memory(); const missed = fixture(liveStorage, undefined, undefined, "missed"), liveDevice = fixture(liveStorage, undefined, undefined, "live");
  follow(missed.replay); follow(liveDevice.replay); await Promise.all([missed.replay.settled(), liveDevice.replay.settled()]); await live(liveDevice.replay);
  await Promise.all([missed.replay.resume("thread"), liveDevice.replay.resume("thread")]);
  assert.equal(missed.sent.length, 1); assert.equal(liveDevice.sent.length, 0);
});

test("two sessions for one device atomically claim one replay", async () => {
  const storage = memory(); const first = fixture(storage, undefined, undefined, "same"), second = fixture(storage, undefined, undefined, "same");
  follow(first.replay); await first.replay.settled(); await Promise.all([first.replay.resume("thread"), second.replay.resume("thread")]);
  assert.equal(first.sent.length + second.sent.length, 1);
});

test("a client hello settles buffered follows after an early unscoped notification", async () => {
  const key = "a".repeat(32), f = fixture(memory(), undefined, undefined, undefined, true);
  f.replay.forward({ method: "account/updated", params: {} });
  follow(f.replay); f.replay.setDevice(key); await f.replay.settled();
  assert.equal((await saved(f.storage, key)).turnId, "turn"); assert.equal((await f.storage.read())[ledgerKey()], undefined);
});

test("a failed early terminal write stays eligible after the client hello", async () => {
  const key = "b".repeat(32), f = fixture(memory(), async () => ({ data: [turn()] }), undefined, undefined, true);
  follow(f.replay); const message = { method: "turn/completed", params: { threadId: "thread", turn: turn() } };
  assert.equal(f.replay.forward(message), true); await f.replay.written(message); f.replay.failed(message);
  f.replay.setDevice(key); await f.replay.settled(); await f.replay.resume("thread");
  assert.equal(f.sent.length, 1); assert.equal((await saved(f.storage, key)).delivered, true);
});

test("a successful early terminal follows its buffered newer turn before delivery", async () => {
  const key = "c".repeat(32), entries: Record<string, CompletionReplayEntry> = {
    [ledgerKey(key)]: { device: key, threadId: "thread", turnId: "old", followedAt: now - 1, delivered: false },
  };
  const storage = (): CompletionReplayStorage => ({ read: async () => structuredClone(entries), update: async change => change(entries) });
  const f = fixture(storage(), async () => ({ data: [turn("new")] }), undefined, "local", true);
  follow(f.replay, "thread", "new"); const message = { method: "turn/completed", params: { threadId: "thread", turn: turn("new") } };
  assert.equal(f.replay.forward(message), true); await f.replay.written(message); f.replay.setDevice(key); await f.replay.settled();
  assert.equal(entries[ledgerKey(key)].turnId, "new"); assert.equal(entries[ledgerKey(key)].delivered, true);
  const other = fixture(storage(), async () => ({ data: [turn("new")] }), undefined, key); await other.replay.resume("thread");
  assert.equal(other.sent.length, 0);
});

test("a live terminal during replay lookup wins the ledger claim", async () => {
  const storage = memory(); let release!: (value: Message) => void; const lookup = new Promise<Message>(resolve => { release = resolve; });
  const replaying = fixture(storage, async () => lookup), liveSession = fixture(storage); follow(replaying.replay); await replaying.replay.settled();
  const pending = replaying.replay.resume("thread"); await live(liveSession.replay); release({ data: [turn()] }); await pending;
  assert.equal(replaying.sent.length, 0); assert.equal((await saved(storage)).delivered, true);
});

test("a successful live write blocks a replay while its ledger write is pending", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const entries: Record<string, CompletionReplayEntry> = {};
  const storage: CompletionReplayStorage = { read: async () => structuredClone(entries), update: async change => { await gate; return change(entries); } };
  const liveSession = fixture(storage), replaying = fixture(storage); follow(liveSession.replay); release(); await liveSession.replay.settled();
  const message = { method: "turn/completed", params: { threadId: "thread", turn: turn() } }; assert.equal(liveSession.replay.forward(message), true);
  void liveSession.replay.written(message); await replaying.replay.resume("thread"); assert.equal(replaying.sent.length, 0);
});

test("a stale replay claim is reclaimed, while a live claim blocks a second claimant", async () => {
  const stale = memory({ [ledgerKey()]: { device: "local", threadId: "thread", turnId: "turn", followedAt: now, delivered: false, claim: { id: "gone", at: now - 60_001 } } });
  const recovered = fixture(stale); await recovered.replay.resume("thread"); assert.equal(recovered.sent.length, 1, "an abandoned claim is replayed");
  const storage = memory(); let release!: () => void; const output = new Promise<void>(resolve => { release = resolve; });
  const first = fixture(storage); follow(first.replay); await first.replay.settled();
  const claimant = new CompletionReplay({ storage, request: async () => ({ data: [turn()] }), emit: async () => output, clock: () => now });
  const pending = claimant.resume("thread"); await new Promise(resolve => setImmediate(resolve));
  const second = fixture(storage); await second.replay.resume("thread"); assert.equal(second.sent.length, 0, "a live claim blocks another replay");
  release(); await pending;
});

test("a slow ledger never holds the next forwarded frame", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const entries: Record<string, CompletionReplayEntry> = {};
  const storage: CompletionReplayStorage = { read: async () => structuredClone(entries), update: async change => { await gate; return change(entries); } };
  const f = fixture(storage); follow(f.replay); const terminal = { method: "turn/completed", params: { threadId: "thread", turn: turn() } };
  assert.equal(f.replay.forward(terminal), true); void f.replay.written(terminal);
  assert.equal(f.replay.forward({ method: "item/agentMessage/delta", params: { threadId: "other", turnId: "other" } }), true);
  release(); await f.replay.settled();
});

test("a rejected ledger settlement skips replay without rejecting the session", async () => {
  const storage = memory(); storage.settled = async () => { throw Error("disk unavailable"); };
  const f = fixture(storage); follow(f.replay); await f.replay.settled(); await assert.doesNotReject(f.replay.resume("thread"));
  assert.equal(f.sent.length, 0); assert.deepEqual(f.events, [{ event: "completion_replayed", fields: { outcome: "lookup_failed" } }]);
  assert.equal(f.replay.forward({ method: "item/agentMessage/delta", params: { threadId: "next", turnId: "next" } }), true, "the session still forwards");
});

test("a failed live write remains eligible for replay", async () => {
  const storage = memory(); const f = fixture(storage); follow(f.replay); await f.replay.settled(); const message = { method: "turn/completed", params: { threadId: "thread", turn: turn() } };
  assert.equal(f.replay.forward(message), true); f.replay.failed(message); await f.replay.resume("thread");
  assert.equal(f.sent.length, 1); assert.equal((await saved(storage)).delivered, true);
});

test("a delayed old terminal cannot replace a newer followed turn", async () => {
  let clock = now; const f = fixture(memory(), undefined, () => clock); follow(f.replay, "thread", "old"); await f.replay.settled(); clock++;
  follow(f.replay, "thread", "new"); await f.replay.settled(); await live(f.replay, "thread", "old");
  const current = await saved(f.storage); assert.equal(current.turnId, "new"); assert.equal(current.delivered, false);
});

test("two instances share the private ledger, bound it, and replace corrupt data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hg-replay-")); const path = join(directory, "completion-replay.json");
  try {
    let clock = now; const storage = completionReplayStorage(directory, () => clock); const first = fixture(storage, undefined, () => clock), second = fixture(storage, undefined, () => clock);
    follow(first.replay); await first.replay.settled(); await second.replay.resume("thread"); await second.replay.settled();
    assert.equal((await saved(storage)).delivered, true, "the second process sees the first process's record");
    await writePrivateJson(path, Object.fromEntries(Array.from({ length: 513 }, (_value, index) => [`thread-${index}`, { turnId: `turn-${index}`, followedAt: clock - 1, delivered: false }])));
    follow(first.replay, "fresh", "fresh-turn"); await first.replay.settled();
    const bounded = await storage.read(); assert.equal(Object.keys(bounded).length, 512); assert.equal(bounded[ledgerKey("local", "fresh")].turnId, "fresh-turn");
    clock += 7 * 24 * 60 * 60 * 1000 + 1; follow(first.replay, "newest", "newest-turn"); await first.replay.settled();
    assert.deepEqual(Object.keys(await storage.read()), [ledgerKey("local", "newest")]);
    await writeFile(path, "not json", { mode: 0o600 }); const corrupt = fixture(completionReplayStorage(directory, () => clock), undefined, () => clock);
    follow(corrupt.replay, "replacement", "turn"); await corrupt.replay.settled();
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path, "utf8"))), [ledgerKey("local", "replacement")]);
  } finally { await (await import("node:fs/promises")).rm(directory, { recursive: true, force: true }); }
});

test("old bare thread keys migrate to the unknown device", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hg-replay-")); const path = join(directory, "completion-replay.json");
  try {
    await writePrivateJson(path, { thread: { turnId: "turn", followedAt: now, delivered: false } });
    const entries = await completionReplayStorage(directory, () => now).read();
    assert.deepEqual(entries[ledgerKey("unknown")], { device: "unknown", threadId: "thread", turnId: "turn", followedAt: now, delivered: false });
  } finally { await (await import("node:fs/promises")).rm(directory, { recursive: true, force: true }); }
});
