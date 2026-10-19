import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GatewayChatRegistry, gatewayChatMaxEntries, gatewayChatMaxIdLength, type GatewayChatOrigin } from "../gateway-chat-registry.js";

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
    for (const id of ["", "a\0b", "x".repeat(129)]) await assert.rejects(f.store.record(id, "start"), /invalid or unsafe/, "an unusable id is refused");
    await assert.rejects(f.store.record("ok", "nope" as GatewayChatOrigin), /invalid or unsafe/);
    await assert.rejects(f.store.record("ok", "start", 1.5), /invalid or unsafe/);
    assert.equal(await f.store.has(""), false); assert.equal(await f.store.has("x".repeat(129)), false);
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
  for (const kind of ["bad-json", "wrong-version", "wrong-shape", "extra-field", "bad-id", "symlink"] as const) {
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
        const aside = await lstat(`${f.path}.unreadable`);
        assert.equal(kind === "symlink" ? aside.isSymbolicLink() : aside.isFile(), true, "the bad file is set aside, not deleted");
        if (kind === "bad-json") assert.equal(await readFile(`${f.path}.unreadable`, "utf8"), "{ not json\n", "the copy is the file as it was found");
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

test("a file whose mode alone drifted keeps every entry: a record restores 0600 instead of setting the file aside", async () => {
  if (process.getuid?.() === 0) return;
  for (const mode of [0o644, 0o664, 0o666, 0o400, 0o640]) {
    await test(`mode ${mode.toString(8)}`, async () => {
      const f = await fixture();
      try {
        for (let i = 0; i < 5; i++) await f.store.record(`gw-${i}`, "start", 1000 + i);
        const before = await readFile(f.path, "utf8");
        await chmod(f.path, mode);
        const reader = f.registry();
        assert.equal(await reader.has("gw-0"), false, "a reader does not trust the drifted file");
        assert.deepEqual(f.unreadable, ["gateway_registry_unreadable"], "and reports it once");
        assert.equal(await readFile(f.path, "utf8"), before, "reading changed nothing");
        assert.equal((await lstat(f.path)).mode & 0o7777, mode, "a reader does not repair");
        for (const writer of [reader, f.registry(), f.store]) {
          await writer.record("gw-new", "start", 2000);
          assert.equal((await lstat(f.path)).mode & 0o7777, 0o600, "the record put the mode back");
          assert.deepEqual((await f.saved()).chats.map(item => item.id), ["gw-0", "gw-1", "gw-2", "gw-3", "gw-4", "gw-new"], "every entry survives");
          assert.deepEqual(await readdir(f.directory), [f.path.slice(f.directory.length + 1)], "nothing was set aside and nothing was left behind");
          await chmod(f.path, mode);
        }
        await chmod(f.path, 0o600);
        assert.deepEqual(await f.registry().snapshot(), new Set(["gw-0", "gw-1", "gw-2", "gw-3", "gw-4", "gw-new"]));
        assert.deepEqual(f.unreadable, ["gateway_registry_unreadable"], "the repair is not a second failure");
      } finally { await chmod(f.path, 0o600).catch(() => undefined); await f.close(); }
    });
  }
  await test("a drifted mode on a file with bad content still sets the content aside", async () => {
    const f = await fixture();
    try {
      await writeFile(f.path, "{ not json\n", { mode: 0o600 }); await chmod(f.path, 0o644);
      await f.store.record("fresh", "start", 4000);
      assert.deepEqual((await f.saved()).chats, [chat("fresh", 4000)]);
      assert.equal(await readFile(`${f.path}.unreadable`, "utf8"), "{ not json\n");
      assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
    } finally { await f.close(); }
  });
  await test("a mode that keeps drifting is refused, not guessed at", async () => {
    const f = await fixture();
    try {
      await f.store.record("a", "start", 1000);
      await chmod(f.path, 0o644);
      // The opener hands out a file whose chmod does nothing, as if something else kept changing the mode.
      const stubborn = (async (...args: Parameters<typeof open>) => {
        const file = await open(...args);
        file.chmod = async () => undefined;
        return file;
      }) as typeof open;
      const store = new GatewayChatRegistry(f.state, f.native, f.report, undefined, stubborn);
      await assert.rejects(store.record("b", "start", 2000), /invalid or unsafe/);
      assert.deepEqual(await readdir(f.directory), [f.path.slice(f.directory.length + 1)], "nothing was set aside");
      await chmod(f.path, 0o600);
      assert.deepEqual((await f.saved()).chats, [chat("a", 1000)], "the list is untouched");
    } finally { await f.close(); }
  });
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

/** A registry on `state`/`home` whose opener counts the file reads it makes, and can be told to fail them. */
function counted(f: Awaited<ReturnType<typeof fixture>>, fail?: () => NodeJS.ErrnoException | undefined) {
  const counter = { opens: 0 };
  const opener = (async (...args: Parameters<typeof open>) => {
    const error = fail?.(); if (error) throw error;
    counter.opens++;
    return open(...args);
  }) as typeof open;
  return { counter, store: new GatewayChatRegistry(f.state, f.native, f.report, undefined, opener) };
}

test("a file that cannot be read for a reason outside its content is never overwritten", async () => {
  if (process.getuid?.() === 0) return;
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++) await f.store.record(`gw-${i}`, "start", 1000 + i);
    const before = await readFile(f.path, "utf8");
    await chmod(f.path, 0o000);
    const reader = f.registry();
    assert.equal(await reader.has("gw-0"), false, "a reader sees an unreadable file as empty");
    assert.deepEqual(f.unreadable, ["gateway_registry_unreadable"], "and reports it once");
    assert.deepEqual(await reader.snapshot(), new Set());
    await assert.rejects(reader.record("gw-new", "start", 2000), (error: NodeJS.ErrnoException) => error.code === "EACCES", "a record fails instead of starting over");
    await assert.rejects(f.store.record("gw-new", "start", 2000), (error: NodeJS.ErrnoException) => error.code === "EACCES", "even for the instance that wrote the file");
    await chmod(f.path, 0o600);
    assert.equal(await readFile(f.path, "utf8"), before, "the file is exactly as it was");
    assert.deepEqual(await readdir(f.directory), [f.path.slice(f.directory.length + 1)], "nothing was set aside and nothing was left behind");
    assert.deepEqual(await f.registry().snapshot(), new Set(["gw-0", "gw-1", "gw-2", "gw-3", "gw-4"]), "every entry survives");
    await reader.record("gw-new", "start", 2000);
    assert.equal((await f.saved()).chats.length, 6, "once the fault clears a record merges as usual");
  } finally { await chmod(f.path, 0o600).catch(() => undefined); await f.close(); }
});

test("descriptor limits and I/O errors read as empty and block a record, while bad content does not", async () => {
  for (const errno of ["EMFILE", "ENFILE", "EIO", "EAGAIN", "EACCES"]) {
    const f = await fixture();
    try {
      await f.store.record("kept", "start", 1000);
      const before = await readFile(f.path, "utf8");
      let failing = true;
      const { store } = counted(f, () => failing ? Object.assign(new Error(errno), { code: errno }) : undefined);
      assert.equal(await store.has("kept"), false, errno);
      assert.deepEqual(f.unreadable, ["gateway_registry_unreadable"], `${errno} is reported once`);
      await store.has("kept"); await store.snapshot();
      assert.deepEqual(f.unreadable, ["gateway_registry_unreadable"]);
      await assert.rejects(store.record("other", "start", 2000), (error: NodeJS.ErrnoException) => error.code === errno);
      assert.equal(await readFile(f.path, "utf8"), before, `${errno} wrote nothing`);
      assert.deepEqual(await readdir(f.directory), [f.path.slice(f.directory.length + 1)], `${errno} set nothing aside`);
      failing = false;
      assert.equal(await store.has("kept"), true, "the entries are there once the fault clears");
    } finally { await f.close(); }
  }
});

test("a second bad file replaces the first copy set aside", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, "first\n", { mode: 0o600 });
    await f.store.record("a", "start", 1000);
    await writeFile(f.path, "second\n", { mode: 0o600 });
    await f.registry().record("b", "start", 2000);
    assert.equal(await readFile(`${f.path}.unreadable`, "utf8"), "second\n", "one copy is kept");
    assert.deepEqual((await f.saved()).chats, [chat("b", 2000)]);
    assert.deepEqual((await readdir(f.directory)).sort(), [f.path.slice(f.directory.length + 1) + ".unreadable", f.path.slice(f.directory.length + 1)].sort());
  } finally { await f.close(); }
});

test("ids stop at 128 characters and the file is written compact", async () => {
  const f = await fixture();
  try {
    assert.equal(gatewayChatMaxIdLength, 128);
    const longest = "x".repeat(128);
    await f.store.record(longest, "start", 1000);
    assert.equal(await f.store.has(longest), true);
    await assert.rejects(f.store.record("x".repeat(129), "start", 1001), /invalid or unsafe/);
    assert.equal(await f.store.has("x".repeat(129)), false);
    await f.store.record("b", "fork", 1002);
    const raw = await readFile(f.path, "utf8");
    assert.equal(raw.trimEnd().includes("\n"), false, "one line, no indentation");
    assert.equal(raw, JSON.stringify({ version: 1, chats: [chat(longest, 1000), chat("b", 1002, "fork")] }) + "\n");
    // A registry at the entry cap with the longest ids still sits well inside the read limit.
    const full = Array.from({ length: gatewayChatMaxEntries }, (_, i) => chat(String(i).padStart(128, "x"), 1_792_000_000_000 + i, "subagent"));
    await writeFile(f.path, JSON.stringify({ version: 1, chats: full }) + "\n", { mode: 0o600 });
    assert.ok((await lstat(f.path)).size < 16 * 1024 * 1024, "a full registry of the longest ids is under half the read limit");
    assert.equal(await f.registry().has(full[7].id), true);
    assert.deepEqual(f.unreadable, []);
    // An older file with a longer id is not one this build wrote.
    await writeFile(f.path, JSON.stringify({ version: 1, chats: [chat("y".repeat(200), 1)] }), { mode: 0o600 });
    assert.equal(await f.registry().has("z"), false, "the file is read as empty");
    assert.deepEqual(f.unreadable, ["gateway_registry_unreadable"]);
  } finally { await f.close(); }
});

test("reads come from memory until the file changes, whoever changes it", async () => {
  const f = await fixture();
  try {
    const mine = counted(f);
    assert.equal(mine.store.hasCached("a"), false, "nothing is cached before the first read");
    assert.equal(await mine.store.has("a"), false);
    assert.equal(mine.counter.opens, 0, "a registry that does not exist yet is never opened");
    await mine.store.record("a", "start", 1000);
    const afterRecord = mine.counter.opens;
    for (let i = 0; i < 5; i++) { assert.equal(await mine.store.has("a"), true); await mine.store.snapshot(); }
    assert.equal(mine.counter.opens, afterRecord, "after its own record, reads cost no file read");
    assert.equal(mine.store.hasCached("a"), true, "a record updates the cache itself");
    assert.equal(await mine.store.snapshot(), await mine.store.snapshot(), "the same set is handed back while nothing changes");
    // Another instance writes: the next read sees the new key, reads once, and is cached again.
    const other = counted(f);
    await other.store.record("b", "fork", 1001);
    assert.equal(mine.store.hasCached("b"), false, "the sync lookup answers from what it last saw");
    await mine.store.refresh();
    assert.equal(mine.counter.opens, afterRecord + 1, "a refresh after another writer reads the file once");
    assert.equal(mine.store.hasCached("b"), true); assert.equal(mine.store.hasCached("a"), true);
    await mine.store.refresh(); await mine.store.has("b"); await mine.store.snapshot();
    assert.equal(mine.counter.opens, afterRecord + 1, "and then answers from memory");
    // Another process writes.
    const code = childImport + `await new GatewayChatRegistry(process.argv[1], process.argv[2]).record("from-process", "subagent", 3000);`;
    await execute(process.execPath, ["--input-type=module", "-e", code, f.state, f.native]);
    assert.equal(mine.store.hasCached("from-process"), false);
    assert.equal(await mine.store.has("from-process"), true, "an async read notices the change");
    assert.equal(mine.counter.opens, afterRecord + 2);
    // A record on a warm cache merges with what is stored and does not read the file again to do it.
    const reads = mine.counter.opens;
    await mine.store.record("c", "start", 4000);
    assert.equal(mine.counter.opens, reads, "a record under an unchanged key reuses the cached list");
    assert.deepEqual((await f.saved()).chats.map(item => item.id), ["a", "b", "from-process", "c"]);
    // A cold instance reads once and keeps it.
    const cold = counted(f);
    assert.equal(await cold.store.has("c"), true); await cold.store.has("a"); await cold.store.snapshot();
    assert.equal(cold.counter.opens, 1);
    // The file is replaced by something bad: the key changes, the cache goes with it, and the reader reports once.
    await writeFile(f.path, "{ not json", { mode: 0o600 });
    assert.equal(await cold.store.has("c"), false);
    assert.equal(cold.store.hasCached("c"), false);
    assert.deepEqual(f.unreadable, ["gateway_registry_unreadable"]);
    // The file is removed: an empty registry, with no read.
    await rm(f.path);
    const opens = cold.counter.opens;
    await cold.store.refresh();
    assert.equal(cold.store.hasCached("c"), false); assert.equal(cold.counter.opens, opens);
  } finally { await f.close(); }
});

test("a cached list still checks the file's mode, which the content key alone would miss", async () => {
  const f = await fixture();
  try {
    await f.store.record("a", "start", 1000);
    assert.equal(await f.store.has("a"), true);
    await chmod(f.path, 0o644);
    assert.equal(await f.store.has("a"), false, "a file that went public is no longer trusted");
    assert.deepEqual(f.unreadable, ["gateway_registry_unreadable"]);
    await chmod(f.path, 0o600);
    assert.equal(await f.store.has("a"), true, "and is trusted again once it is private");
  } finally { await f.close(); }
});

test("the registry folder is created private and an existing one is tightened", async () => {
  const f = await fixture();
  try {
    const fresh = join(f.root, "fresh-state");
    await new GatewayChatRegistry(fresh, f.native).record("a", "start", 1000);
    assert.equal((await lstat(join(fresh, "gateway-chats"))).mode & 0o777, 0o700, "created from nothing");
    await chmod(f.directory, 0o755);
    await f.store.record("b", "start", 1001);
    assert.equal((await lstat(f.directory)).mode & 0o777, 0o700, "an open folder of ours is closed");
    await chmod(f.directory, 0o777);
    await f.store.record("c", "start", 1002);
    assert.equal((await lstat(f.directory)).mode & 0o777, 0o700, "even one other users could write to");
    assert.deepEqual((await f.saved()).chats.map(item => item.id), ["b", "c"], "tightening the folder lost nothing");
  } finally { await f.close(); }
});
