import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ThreadReasoningStore } from "../thread-reasoning.js";

const now = () => Date.now(); async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-thread-reasoning-"));
  const state = join(root, "state"); const native = join(root, "native"); await mkdir(native, { mode: 0o700 });
  const store = new ThreadReasoningStore(state, native);
  const scope = createHash("sha256").update(resolve(native)).digest("hex").slice(0, 16);
  return { root, state, native, store, path: join(state, `desktop-thread-reasoning-${scope}.json`) };
}
const at = now();

test("selections persist per chat, newest wins, and nulls never erase a saved level", async () => {
  const f = await fixture();
  assert.equal(await f.store.read("chat"), undefined);
  assert.equal(await f.store.write("chat", { model: "m", effort: "high", summary: "concise", atMs: at }), true);
  assert.deepEqual(await f.store.read("chat"), { model: "m", effort: "high", summary: "concise", atMs: at });
  assert.equal(await f.store.write("chat", { model: "m", effort: "max", atMs: at - 1 }), false, "an older observation cannot replace the newest");
  assert.equal((await f.store.read("chat"))!.effort, "high");
  assert.equal(await f.store.write("chat", { model: "m", effort: null, summary: "detailed", atMs: at + 1 }), true);
  assert.deepEqual(await f.store.read("chat"), { model: "m", effort: "high", summary: "detailed", atMs: at + 1 }, "an unknown effort keeps the saved one");
  await f.store.write("chat", { model: "m", effort: null, summary: null, atMs: at + 2 });
  assert.deepEqual(await f.store.read("chat"), { model: "m", effort: "high", summary: "detailed", atMs: at + 1 }, "an observation carrying no reasoning leaves the record alone");
  assert.equal(await f.store.write("fresh", { model: "m", effort: null, atMs: at + 2 }), false, "a chat without any effort is never created");
  assert.equal(await f.store.write("chat", { model: "other", effort: "low", atMs: at + 3 }), true);
  assert.deepEqual(await f.store.read("chat"), { model: "other", effort: "low", summary: "detailed", atMs: at + 3 });
  assert.equal((await lstat(f.path)).mode & 0o777, 0o600); assert.equal((await lstat(f.state)).mode & 0o777, 0o700);
});

test("the store is scoped by native home and independent of other state files", async () => {
  const f = await fixture();
  await f.store.write("chat", { model: "m", effort: "max", atMs: at });
  const otherHome = new ThreadReasoningStore(f.state, join(f.root, "other-native"));
  const otherState = new ThreadReasoningStore(join(f.root, "other-state"), f.native);
  assert.equal(await otherHome.read("chat"), undefined); assert.equal(await otherState.read("chat"), undefined);
  await otherHome.write("chat", { model: "m", effort: "low", atMs: at }); await otherState.write("chat", { model: "m", effort: "low", atMs: at });
  assert.equal((await f.store.read("chat"))!.effort, "max");
  const files = [...await readdir(f.state), ...await readdir(join(f.root, "other-state"))];
  assert.equal(files.length, 3); assert.ok(files.every(name => /^desktop-thread-reasoning-[0-9a-f]{16}\.json$/.test(name)), "writers leave no locks or temporary files");
  assert.match(JSON.parse(await readFile(f.path, "utf8")).threads.chat.effort, /^max$/);
});

test("invalid identifiers and values are refused instead of stored or read back", async () => {
  const f = await fixture();
  for (const id of ["", "a".repeat(1025), "nul\0id", 7 as unknown as string]) {
    await assert.rejects(f.store.write(id, { model: "m", effort: "low", atMs: at }), /invalid or unsafe/);
    await assert.rejects(f.store.read(id), /invalid or unsafe/);
  }
  for (const value of [
    { model: "m", effort: "Not A Level", atMs: at }, { model: "m", effort: "a".repeat(65), atMs: at },
    { model: "m", atMs: 1.5 }, { model: 4, effort: "low", atMs: at }, { model: "m", effort: "low", summary: "chatty", atMs: at },
    { model: "m", effort: "low", atMs: -1 }, { model: "m", effort: "low", atMs: Number.MAX_SAFE_INTEGER + 1 },
  ]) await assert.rejects(f.store.write("chat", value as never), /invalid or unsafe/);
  assert.equal(await f.store.read("chat"), undefined);
});

test("a corrupted or loosened store file fails closed, and concurrent writers merge", async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 8 }, (_, i) => new ThreadReasoningStore(f.state, f.native).write(`chat-${i}`, { model: "m", effort: "low", atMs: at })));
  for (let i = 0; i < 8; i++) assert.deepEqual((await f.store.read(`chat-${i}`))!.effort, "low");
  await chmod(f.path, 0o644); await assert.rejects(f.store.read("chat-0"), /invalid or unsafe/);
  await chmod(f.path, 0o600); await writeFile(f.path, "{ not json"); await assert.rejects(f.store.read("chat-0"), /invalid or unsafe/);
});
