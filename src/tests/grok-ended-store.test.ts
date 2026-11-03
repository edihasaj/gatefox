import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GrokEndedStore, grokEndedFile, grokEndedLimits } from "../providers/grok-ended-store.js";

const module = new URL("../providers/grok-ended-store.js", import.meta.url).href;
const key = (index: number) => index.toString(16).padStart(64, "0");
const day = 24 * 3600 * 1000;
const dead = 2147483646;
type File = { version: number; seq: number; entries: Record<string, { at: number; reason: string; seq: number; owner?: string }> };
const defaults = { ...grokEndedLimits };

async function folder() { return mkdtemp(join("/tmp", "gateway-test-grok-ended-")); }
const read = async (home: string) => JSON.parse(await readFile(join(home, grokEndedFile), "utf8")) as File;
/** A store with an injected clock and identity; `running` lists the pids that count as running processes. */
const clocked = (home: string, at: { now: number }, extra: { owner?: string; running?: number[] } = {}) =>
  GrokEndedStore.forHome(home, { now: () => at.now, owner: extra.owner ?? "1:1", alive: async ({ pid }) => extra.running?.includes(pid) ?? false });

/**
 * Starts one child process that loads the store (a lookup), says `ready`, waits for `go` on stdin, then runs `script`'s
 * operation and prints its JSON result. The caller releases every child at once, so each has loaded before any writes.
 */
function child(home: string, operation: string) {
  const code = `const { GrokEndedStore } = await import(${JSON.stringify(module)}); const store = GrokEndedStore.forHome(process.argv[1]);
    await store.lookup(${JSON.stringify(key(0))}); process.stdout.write("ready\\n");
    await new Promise(resolve => process.stdin.once("data", resolve));
    const result = await (async () => { ${operation} })(); process.stdout.write(JSON.stringify(result ?? null) + "\\n"); process.exit(0);`;
  const process_ = spawn(process.execPath, ["--input-type=module", "-e", code, home], { stdio: ["pipe", "pipe", "inherit"] });
  let out = ""; let ready!: () => void; const loaded = new Promise<void>(resolve => { ready = resolve; });
  process_.stdout.on("data", piece => { out += piece; if (out.includes("ready\n")) ready(); });
  const done = new Promise<unknown>((resolve, reject) => { process_.on("exit", code_ => code_ === 0 ? resolve(JSON.parse(out.split("\n").filter(Boolean).at(-1)!)) : reject(new Error(`child exited ${code_}`))); });
  return { loaded, go: () => process_.stdin.write("go\n"), done };
}

test("two processes that loaded the store and then write different keys both keep their records", { timeout: 60000 }, async () => {
  const home = await folder();
  try {
    const a = child(home, `await store.finish(${JSON.stringify(key(1))}, "parked");`);
    const b = child(home, `await store.finish(${JSON.stringify(key(2))}, "interrupted");`);
    await Promise.all([a.loaded, b.loaded]); a.go(); b.go(); await Promise.all([a.done, b.done]);
    const saved = await read(home);
    assert.equal(saved.entries[key(1)]?.reason, "parked"); assert.equal(saved.entries[key(2)]?.reason, "interrupted");
    assert.equal(new Set(Object.values(saved.entries).map(entry => entry.seq)).size, 2, "each write has its own sequence number");
    assert.equal(saved.seq, 2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("two processes reserving the same key: exactly one wins, the other gets the existing record", { timeout: 60000 }, async () => {
  const home = await folder();
  try {
    const children = [0, 1, 2, 3].map(() => child(home, `return await store.reserve(${JSON.stringify(key(7))});`));
    await Promise.all(children.map(item => item.loaded)); for (const item of children) item.go();
    const results = await Promise.all(children.map(item => item.done));
    assert.equal(results.filter(result => result === null).length, 1, `one winner, got ${JSON.stringify(results)}`);
    assert.deepEqual(results.filter(result => result !== null), ["session_lost", "session_lost", "session_lost"]);
    assert.equal(Object.keys((await read(home)).entries).length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a store instance reads the file again for every operation: another writer's record is seen and kept", async () => {
  const home = await folder(); const at = { now: 1_000_000 };
  try {
    const first = clocked(home, at, { running: [2] }); const second = clocked(home, at, { owner: "2:2", running: [1] });
    assert.equal(await first.reserve(key(1)), undefined);
    assert.equal(await second.reserve(key(1)), "session_lost", "an existing record is returned, not overwritten");
    await second.finish(key(2), "parked");
    assert.equal(await first.lookup(key(2)), "parked");
    await first.finish(key(1), "closed");
    const saved = await read(home);
    assert.deepEqual(Object.keys(saved.entries).sort(), [key(1), key(2)]); assert.equal(saved.entries[key(1)].reason, "closed");
    assert.equal(await second.reserve(key(1)), "closed");
    // Only a reservation of the same process is released.
    assert.equal(await first.reserve(key(3)), undefined); await second.release(key(3));
    assert.equal(await first.lookup(key(3)), "session_lost");
    await first.release(key(3)); assert.equal(await first.lookup(key(3)), undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a live entry of a process that is gone becomes session_lost with a fresh time, which then ages normally; a live entry never expires by age", async () => {
  const home = await folder(); const at = { now: 50 * day };
  try {
    const orphan = key(1);
    await writeFile(join(home, grokEndedFile), JSON.stringify({ version: 1, entries: { [orphan]: { at: 1, reason: "live", owner: `${dead}:5` } } }), { mode: 0o600 });
    const store = clocked(home, at, { running: [3] });
    assert.equal(await store.lookup(orphan), "session_lost", "not expired on its original timestamp");
    const converted = (await read(home)).entries[orphan];
    assert.equal(converted.reason, "session_lost"); assert.equal(converted.at, at.now); assert.equal(converted.owner, undefined);
    at.now += 7 * day - 1000; assert.equal(await store.lookup(orphan), "session_lost");
    at.now += 2000; assert.equal(await store.lookup(orphan), undefined, "expired a full retention after it was found");
    // A live entry of this process (or of any live one) is never aged out.
    assert.equal(await store.reserve(key(2)), undefined);
    at.now += 200 * day; assert.equal(await store.lookup(key(2)), "session_lost"); assert.equal((await read(home)).entries[key(2)].reason, "live");
    // A live entry of a running other process stays live.
    const other = clocked(home, at, { owner: "3:3", running: [1] });
    assert.equal(await other.reserve(key(4)), undefined);
    assert.equal(await store.lookup(key(4)), "session_lost"); assert.equal((await read(home)).entries[key(4)].reason, "live");
    // A live entry without an owner (an older file) or of this pid with another start is an orphan.
    const entries = (await read(home)).entries;
    await writeFile(join(home, grokEndedFile), JSON.stringify({ version: 1, entries: { ...entries, [key(5)]: { at: 1, reason: "live" }, [key(6)]: { at: 1, reason: "live", owner: `${process.pid}:99` } } }), { mode: 0o600 });
    await store.lookup(key(5)); const after = (await read(home)).entries;
    assert.equal(after[key(5)].reason, "session_lost"); assert.equal(after[key(6)].reason, "session_lost"); assert.equal(after[key(2)].reason, "live");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("clock discontinuities: a time in the future counts as now, and a record far older than the expiry is suspect and kept", async () => {
  const home = await folder(); const at = { now: 100 * day };
  try {
    const store = clocked(home, at); const ttl = grokEndedLimits.expiryMs;
    const future = key(1); const old = key(2); const normal = key(3); const recent = key(4);
    await writeFile(join(home, grokEndedFile), JSON.stringify({ version: 1, seq: 4, entries: {
      [future]: { at: at.now + 5 * ttl, reason: "parked", seq: 1 }, [old]: { at: at.now - 11 * ttl, reason: "parked", seq: 2 },
      [normal]: { at: at.now - ttl - 1, reason: "parked", seq: 3 }, [recent]: { at: at.now - 1000, reason: "closed", seq: 4 } } }), { mode: 0o600 });
    assert.equal(await store.lookup(future), "parked"); assert.equal(await store.lookup(old), "parked", "suspect: kept"); assert.equal(await store.lookup(normal), undefined, "a normal expiry still happens");
    const saved = await read(home);
    assert.equal(saved.entries[future].at, at.now, "the future time is now"); assert.equal(saved.entries[old].at, at.now, "its age starts again");
    assert.ok(saved.entries[old].seq > 4, "rewritten with a new sequence number"); assert.equal(saved.entries[recent].reason, "closed");
    // Having been aged again, a normal sweep a whole retention later removes them.
    at.now += ttl + 1; assert.equal(await store.lookup(old), undefined); assert.equal(await store.lookup(future), undefined);
    // A record written moments ago survives a jump that is smaller than the suspect bound only until its retention is over.
    await store.finish(key(8), "parked"); at.now += 11 * ttl; assert.equal(await store.lookup(key(8)), "parked", "a huge forward jump drops nothing");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an interrupted write's temporary files are reclaimed under the lock; a fresh one, a live writer's and foreign files are kept", { timeout: 30000 }, async () => {
  const home = await folder(); const file = join(home, grokEndedFile); const old = new Date(Date.now() - 10 * 60000);
  try {
    const stale = [`${file}.${dead}.aaaaaaaaaaaa.tmp`, `${file}.${dead - 1}.bbbbbbbbbbbb.tmp`, GrokEndedStore.tempName(file)];
    const fresh = `${file}.${dead}.cccccccccccc.tmp`;
    const held = `${file}.${process.ppid}.dddddddddddd.tmp`; // an older temporary whose writer is a running process
    const foreign = [join(home, "other.json.1.eeeeeeeeeeee.tmp"), `${file}.notapid.ffffffffffff.tmp`, `${file}.${dead}.short.tmp`];
    for (const path of [...stale, fresh, held, ...foreign]) await writeFile(path, "{}");
    for (const path of [...stale, held, ...foreign]) await utimes(path, old, old);
    await new GrokEndedStore(file).finish(key(1), "parked");
    const names = new Set(await readdir(home));
    for (const path of stale) assert.ok(!names.has(path.slice(home.length + 1)), `${path} reclaimed`);
    for (const path of [fresh, held, ...foreign]) assert.ok(names.has(path.slice(home.length + 1)), `${path} kept`);
    assert.equal((await read(home)).entries[key(1)].reason, "parked");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(![...names].some(name => name.endsWith(".lock")), "the lock is released");
  } finally { Object.assign(grokEndedLimits, defaults); await rm(home, { recursive: true, force: true }); }
});
