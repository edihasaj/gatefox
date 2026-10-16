import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GatewayChatRegistry, gatewayChatMaxEntries, type GatewayChatOrigin } from "../gateway-chat-registry.js";

interface Chat { id: string; atMs: number; origin: GatewayChatOrigin }
const execute = promisify(execFile);
const chat = (id: string, atMs: number, origin: GatewayChatOrigin = "start"): Chat => ({ id, atMs, origin });
const scope = (home: string) => createHash("sha256").update(resolve(home)).digest("hex").slice(0, 16);
/** A registry per native home under one state directory; `cap` is the entry limit, for an eviction test. */
async function fixture(cap?: number) {
  const root = await mkdtemp(join(tmpdir(), "gateway-chat-registry-"));
  const state = join(root, "state"); const native = join(root, "native"); await mkdir(native, { mode: 0o700 });
  const directory = join(state, "gateway-chats"); const path = join(directory, `${scope(native)}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const unreadable: string[] = []; const report = () => unreadable.push("gateway_registry_unreadable");
  const registry = (home = native, max = cap) => new GatewayChatRegistry(state, home, report, max);
  return { root, state, native, directory, path, registry, report, unreadable, store: registry(),
    saved: async (at = path) => (JSON.parse(await readFile(at, "utf8")) as { version: number; chats: Chat[] }),
    close: () => rm(root, { recursive: true, force: true }) };
}
const childImport = `const { GatewayChatRegistry } = await import(${JSON.stringify(new URL("../gateway-chat-registry.js", import.meta.url).href)});`;

test("a record is on disk when it resolves, holds ids and times only, and stays private", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.store.has("absent"), false, "a registry that was never written is empty, not broken");
    assert.deepEqual(await f.store.snapshot(), new Set(), "an absent file is read as nothing");
    assert.deepEqual(f.unreadable, [], "an absent file reports nothing");
    await f.store.record("chat-a", "start", 1000);
    assert.equal(await f.store.has("chat-a"), true, "the entry is durable the moment record resolves");
    assert.deepEqual(await f.saved(), { version: 1, chats: [chat("chat-a", 1000)] });
    assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
    assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);
    assert.equal(await f.store.has("chat-b"), false);
    assert.deepEqual(await readdir(f.directory), [f.path.slice(f.directory.length + 1)], "a completed record leaves no lock or temporary file");
    // Re-recording an id keeps the newest stamp; an out-of-order event moves nothing, and repeats are idempotent.
    await f.store.record("chat-a", "subagent", 2000);
    await f.store.record("chat-a", "fork", 1500);
    assert.deepEqual((await f.saved()).chats, [chat("chat-a", 2000, "subagent")]);
    await f.store.record("chat-a", "fork", 2000);
    assert.deepEqual((await f.saved()).chats, [chat("chat-a", 2000, "subagent")]);
    await f.store.record("chat-b", "started", 900);
    assert.deepEqual((await f.saved()).chats, [chat("chat-b", 900, "started"), chat("chat-a", 2000, "subagent")], "the file reads oldest first");
    assert.deepEqual(await f.store.snapshot(), new Set(["chat-b", "chat-a"]));
    assert.equal(/model|provider|prompt|content|gpt|claude|sol/i.test(JSON.stringify(await f.saved())), false, "no model name or content can be in the file");
    for (const id of ["", "a\0b", "x".repeat(1025)]) await assert.rejects(f.store.record(id, "start"), /invalid or unsafe/, "an unusable id is refused");
    await assert.rejects(f.store.record("ok", "nope" as GatewayChatOrigin), /invalid or unsafe/);
    await assert.rejects(f.store.record("ok", "start", 1.5), /invalid or unsafe/);
    assert.equal(await f.store.has(""), false); assert.equal(await f.store.has("x".repeat(1025)), false);
    assert.deepEqual((await f.saved()).chats.length, 2, "a refused record changed nothing");
  } finally { await f.close(); }
});

test("independent instances and separate processes record every chat under the lock", async () => {
  const f = await fixture();
  try {
    const stores = Array.from({ length: 6 }, () => f.registry());
    await Promise.all(stores.map((store, i) => Promise.all([0, 1, 2].map(j => store.record(`instance-${i}-${j}`, "start", 1000 + j)))));
    const code = childImport + `const registry = new GatewayChatRegistry(process.argv[1], process.argv[2]);
      for (let i = 0; i < 10; i++) await registry.record(process.argv[3] + i, "start", 2000);`;
    await Promise.all(Array.from({ length: 4 }, (_, p) => execute(process.execPath, ["--input-type=module", "-e", code, f.state, f.native, `process-${p}-`])));
    assert.equal((await f.saved()).chats.length, 6 * 3 + 4 * 10, "no concurrent writer lost an entry");
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) assert.equal(await f.store.has(`instance-${i}-${j}`), true);
    for (let p = 0; p < 4; p++) for (let i = 0; i < 10; i++) assert.equal(await f.store.has(`process-${p}-${i}`), true);
    assert.deepEqual(await readdir(f.directory), [f.path.slice(f.directory.length + 1)], "the writers leave nothing but the registry");
    assert.deepEqual(f.unreadable, [], "healthy concurrent records report nothing");
  } finally { await f.close(); }
});

test("a full registry drops the oldest chats and never the one it just wrote", async () => {
  const f = await fixture(4);
  try {
    for (let i = 0; i < 4; i++) await f.store.record(`old-${i}`, "start", 1000 + i);
    await f.store.record("newest", "started", 5000);
    assert.deepEqual((await f.saved()).chats, [chat("old-1", 1001), chat("old-2", 1002), chat("old-3", 1003), chat("newest", 5000, "started")]);
    assert.equal(await f.store.has("old-0"), false, "the oldest stamp leaves first");
    // Rewriting the oldest chat that still fits keeps it in place: the entry just written is never the one dropped.
    await f.store.record("old-1", "fork", 1001);
    assert.equal(await f.store.has("old-1"), true);
    assert.deepEqual((await f.saved()).chats.map(chat => chat.id), ["old-1", "old-2", "old-3", "newest"]);
    // A file already past the cap comes back inside it with the fewest drops.
    await writeFile(f.path, JSON.stringify({ version: 1, chats: Array.from({ length: 300 }, (_, i) => chat(`over-${i}`, i)) }), { mode: 0o600 });
    await f.store.record("kept", "start", 10_000);
    assert.deepEqual((await f.saved()).chats, [chat("over-297", 297), chat("over-298", 298), chat("over-299", 299), chat("kept", 10_000)], "the cap is met with the fewest drops");
  } finally { await f.close(); }
  // The published cap holds at the boundary, where the oldest chat goes and the new one stays.
  const big = await fixture();
  try {
    await writeFile(big.path, JSON.stringify({ version: 1, chats: Array.from({ length: gatewayChatMaxEntries }, (_, i) => chat(`full-${i}`, i)) }), { mode: 0o600 });
    assert.equal(await big.store.has("full-0"), true, "a registry at the cap is a valid file, not a corrupt one");
    await big.store.record("written", "start", gatewayChatMaxEntries + 1);
    const chats = (await big.saved()).chats;
    assert.equal(chats.length, gatewayChatMaxEntries);
    assert.equal(chats.at(-1)?.id, "written");
    assert.equal(await big.store.has("full-0"), false); assert.equal(await big.store.has("written"), true);
    assert.deepEqual(big.unreadable, [], "a file at the cap is not unreadable");
  } finally { await big.close(); }
});

test("an unreadable file reads as empty, is reported once, and a record repairs it", async () => {
  for (const kind of ["bad-json", "wrong-version", "wrong-shape", "extra-field", "bad-id", "public-file", "symlink"] as const) {
    await test(kind, async () => {
      const f = await fixture();
      try {
        await mkdir(f.directory, { recursive: true, mode: 0o700 });
        const good = JSON.stringify({ version: 1, chats: [chat("a", 1)] });
        if (kind === "bad-json") await writeFile(f.path, "{ not json\n", { mode: 0o600 });
        if (kind === "wrong-version") await writeFile(f.path, JSON.stringify({ version: 2, chats: [] }), { mode: 0o600 });
        if (kind === "wrong-shape") await writeFile(f.path, JSON.stringify({ version: 1, chats: { a: 1 } }), { mode: 0o600 });
        if (kind === "extra-field") await writeFile(f.path, JSON.stringify({ version: 1, chats: [chat("a", 1), { ...chat("b", 2), model: "gpt-6.1-sol" }] }), { mode: 0o600 });
        if (kind === "bad-id") await writeFile(f.path, JSON.stringify({ version: 1, chats: [{ id: "", atMs: 1, origin: "start" }] }), { mode: 0o600 });
        if (kind === "public-file") { await writeFile(f.path, good, { mode: 0o600 }); await chmod(f.path, 0o644); }
        if (kind === "symlink") { await writeFile(join(f.root, "elsewhere.json"), good, { mode: 0o600 }); await symlink(join(f.root, "elsewhere.json"), f.path); }
        assert.equal(await f.store.has("a"), false, "an unreadable file reads as empty");
        assert.deepEqual(await f.store.snapshot(), new Set());
        assert.deepEqual(f.unreadable, ["gateway_registry_unreadable"], "one broken read is reported once");
        await f.store.has("b"); await f.store.snapshot();
        assert.deepEqual(f.unreadable, ["gateway_registry_unreadable"], "the rest of the reads say nothing new");
        await f.store.record("fresh", "start", 4000);
        assert.deepEqual((await f.saved()).chats, [chat("fresh", 4000)], "record starts over from empty instead of merging the broken file");
        assert.equal(await f.store.has("fresh"), true);
        assert.deepEqual(f.unreadable, ["gateway_registry_unreadable"], "the repair is not a second failure");
        assert.equal((await lstat(f.path)).mode & 0o777, 0o600, "the repaired file is private again");
      } finally { await f.close(); }
    });
  }
  for (const kind of ["linked directory", "directory in the file's place"] as const) {
    await test(`an unsafe ${kind} is read as empty and refused rather than written into`, async () => {
      const f = await fixture();
      try {
        const elsewhere = join(f.root, "elsewhere"); await mkdir(elsewhere, { mode: 0o700 });
        if (kind === "linked directory") { await rm(f.state, { recursive: true, force: true }); await mkdir(f.state, { mode: 0o700 }); await symlink(elsewhere, f.directory); }
        else { await mkdir(f.directory, { recursive: true, mode: 0o700 }); await mkdir(f.path, { mode: 0o700 }); }
        assert.equal(await f.store.has("a"), false, "the unsafe place holds nothing to read");
        assert.deepEqual(f.unreadable, ["gateway_registry_unreadable"]);
        await assert.rejects(f.store.record("fresh", "start", 4000), /invalid or unsafe/, "nothing is written where a file does not belong");
        assert.equal(await f.store.has("fresh"), false, "a refused record leaves the registry empty");
        assert.deepEqual(await readdir(elsewhere), [], "the other directory holds nothing of ours");
      } finally { await f.close(); }
    });
  }
});

test("each native home keeps its own registry file", async () => {
  const f = await fixture();
  try {
    await f.store.record("mine", "start", 1000);
    const other = f.registry(join(f.root, "other-native"));
    assert.equal(await other.has("mine"), false, "a second installation starts empty");
    await other.record("theirs", "fork", 1001);
    assert.deepEqual((await f.saved()).chats, [chat("mine", 1000)], "the other home wrote only its own file");
    assert.deepEqual((await f.saved(join(f.directory, `${scope(join(f.root, "other-native"))}.json`))).chats, [chat("theirs", 1001, "fork")]);
    assert.deepEqual(await f.registry(join(f.native, "..", "native")).snapshot(), new Set(["mine"]), "a path that resolves to the same home shares the file");
    assert.equal((await readdir(f.directory)).length, 2, "two homes, two files");
  } finally { await f.close(); }
});
