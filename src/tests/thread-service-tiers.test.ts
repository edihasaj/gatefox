import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { storableServiceTier, ThreadServiceTiers, type ThreadServiceTier } from "../thread-service-tiers.js";

const execute = promisify(execFile); const maxBytes = 4 * 1024 * 1024;
const fast = { model: "gateway/model", serviceTier: "priority" };
const standard = { model: "gateway/model", serviceTier: null };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-thread-tiers-"));
  const state = join(root, "state"); const native = join(root, "native"); await mkdir(native, { mode: 0o700 });
  const store = new ThreadServiceTiers(state, native);
  const scope = createHash("sha256").update(resolve(native)).digest("hex").slice(0, 16);
  return { root, state, native, store, path: join(state, `desktop-thread-tiers-${scope}.json`), close: () => rm(root, { recursive: true, force: true }) };
}
const childImport = `const { ThreadServiceTiers } = await import(${JSON.stringify(new URL("../thread-service-tiers.js", import.meta.url).href)});`;

test("tier snapshots scope native homes, reread connections, and contain only public chat metadata", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.native, "config.toml"), "native settings", { mode: 0o600 });
    await writeFile(join(f.native, "auth.json"), "native credentials", { mode: 0o600 });
    assert.equal(await f.store.read("chat"), undefined);
    assert.equal(await f.store.write("chat", fast), true);
    const connection = new ThreadServiceTiers(f.state, join(f.native, "..", "native"));
    assert.deepEqual(await connection.read("chat"), { ...fast, revision: 1 });
    await connection.write("chat", standard);
    assert.deepEqual(await f.store.read("chat"), { ...standard, revision: 2 }, "a connection never serves its old tier");
    const returned = (await f.store.read("chat"))!; returned.serviceTier = "priority";
    assert.deepEqual(await f.store.read("chat"), { ...standard, revision: 2 });
    const otherHome = new ThreadServiceTiers(f.state, join(f.root, "other-native"));
    const otherState = new ThreadServiceTiers(join(f.root, "other-state"), f.native);
    assert.equal(await otherHome.read("chat"), undefined); assert.equal(await otherState.read("chat"), undefined);
    await otherHome.write("chat", fast); await otherState.write("chat", fast);
    assert.deepEqual(await f.store.read("chat"), { ...standard, revision: 2 });
    assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), { version: 1, threads: { chat: { ...standard, revision: 2 } } });
    assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
    assert.equal((await lstat(f.state)).mode & 0o777, 0o700);
    assert.equal(await readFile(join(f.native, "config.toml"), "utf8"), "native settings");
    assert.equal(await readFile(join(f.native, "auth.json"), "utf8"), "native credentials");
  } finally { await f.close(); }
});

test("independent connections and processes merge concurrent writes without losing unrelated chats", async () => {
  const f = await fixture();
  try {
    const stores = Array.from({ length: 6 }, () => new ThreadServiceTiers(f.state, f.native));
    await Promise.all(stores.map((store, i) => store.write(`connection-${i}`, i % 2 ? fast : standard)));
    const code = childImport + `const store = new ThreadServiceTiers(process.argv[1], process.argv[2]);
      for (let i = 0; i < 12; i++) await store.write(process.argv[3] + i, {model:"gateway/model", serviceTier:i % 2 ? "priority" : null});`;
    await Promise.all(Array.from({ length: 4 }, (_, i) => execute(process.execPath, ["--input-type=module", "-e", code, f.state, f.native, `process-${i}-`])));
    const saved = JSON.parse(await readFile(f.path, "utf8")); assert.equal(Object.keys(saved.threads).length, 54);
    for (let i = 0; i < 6; i++) assert.deepEqual(await stores[i].read(`connection-${i}`), { ...(i % 2 ? fast : standard), revision: 1 });
    for (let p = 0; p < 4; p++) for (let i = 0; i < 12; i++) assert.deepEqual(await f.store.read(`process-${p}-${i}`), { ...(i % 2 ? fast : standard), revision: 1 });
    assert.deepEqual(await readdir(f.state), [f.path.slice(f.state.length + 1)], "completed writers leave no locks or temporary files");
  } finally { await f.close(); }
});

test("conditional snapshots preserve newer explicit settings from another process", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.store.write("chat", fast, null), true);
    const previous = (await f.store.read("chat"))!;
    const code = childImport + `await new ThreadServiceTiers(process.argv[1], process.argv[2]).write("chat", {model:"gateway/model", serviceTier:null});`;
    await execute(process.execPath, ["--input-type=module", "-e", code, f.state, f.native]);
    const saved = await readFile(f.path, "utf8");
    assert.equal(await f.store.write("chat", fast, previous), false);
    assert.equal(await f.store.write("chat", fast, null), false);
    assert.equal(await f.store.write("chat", fast, { ...standard, model: "different-model" }), false);
    assert.equal(await readFile(f.path, "utf8"), saved, "a stale snapshot cannot replace Standard or rewrite the file");
    assert.equal(await f.store.write("chat", { model: "other-model", serviceTier: "flex" }, standard), true);
    assert.deepEqual(await f.store.read("chat"), { model: "other-model", serviceTier: "flex", revision: 3 });
    assert.equal(await f.store.write("chat", fast), true, "authoritative updates do not require an expectation");
  } finally { await f.close(); }
});

test("revision-aware expectations reject ABA and mismatched source stamps", async () => {
  const f = await fixture();
  try {
    await f.store.write("chat", fast); const expected = (await f.store.read("chat"))!;
    const code = childImport + `const store = new ThreadServiceTiers(process.argv[1], process.argv[2]);
      await store.write("chat", {model:"gateway/model", serviceTier:null});
      await store.write("chat", {model:"gateway/model", serviceTier:"priority"});`;
    await execute(process.execPath, ["--input-type=module", "-e", code, f.state, f.native]);
    const current = (await f.store.read("chat"))!; assert.deepEqual(current, { ...fast, revision: 3 });
    const bytes = await readFile(f.path, "utf8");
    assert.equal(await f.store.write("chat", standard, expected), false, "restoring Fast does not restore the old revision");
    assert.equal(await f.store.write("chat", standard, { ...current, revision: 2 }), false);
    assert.equal(await readFile(f.path, "utf8"), bytes);
    await f.store.write("chat", { ...fast, emittedAtMs: 12 });
    const stamped = (await f.store.read("chat"))!; const stampedBytes = await readFile(f.path, "utf8");
    assert.equal(await f.store.write("chat", standard, { ...stamped, emittedAtMs: 11 }), false);
    assert.equal(await readFile(f.path, "utf8"), stampedBytes);
  } finally { await f.close(); }
});

test("duplicate snapshots preserve source time and bytes while newer timestamps advance revisions", async () => {
  const f = await fixture();
  try {
    await f.store.write("chat", { ...fast, revision: 99, emittedAtMs: 0 });
    assert.deepEqual(await f.store.read("chat"), { ...fast, revision: 1, emittedAtMs: 0 }, "caller revisions are never authoritative");
    const bytes = await readFile(f.path, "utf8");
    assert.equal(await f.store.write("chat", { ...fast, revision: 500, emittedAtMs: 0 }), true);
    assert.equal(await f.store.write("chat", fast), true);
    assert.equal(await readFile(f.path, "utf8"), bytes, "duplicate metadata never rewrites or bumps revision");
    await f.store.write("chat", { ...fast, emittedAtMs: 1 });
    assert.deepEqual(await f.store.read("chat"), { ...fast, revision: 2, emittedAtMs: 1 });
    await f.store.write("chat", standard, (await f.store.read("chat"))!);
    assert.deepEqual(await f.store.read("chat"), { ...standard, revision: 3, emittedAtMs: 1 }, "SDK snapshots retain notification source time");
  } finally { await f.close(); }
});

test("timestamp ordering rejects stale updates and resolves ambiguous speed conflicts to Standard", async () => {
  const f = await fixture();
  try {
    await f.store.write("chat", { ...fast, emittedAtMs: 100 });
    assert.equal(await f.store.write("chat", { ...standard, emittedAtMs: 99 }), false);
    assert.equal(await f.store.write("chat", { ...standard, emittedAtMs: 100 }), true);
    const bytes = await readFile(f.path, "utf8");
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 100 }), false);
    assert.equal(await readFile(f.path, "utf8"), bytes, "an equal-time Fast envelope cannot displace Standard");
    await f.store.write("chat", { ...fast, emittedAtMs: 101 });
    await f.store.write("chat", { model: "other-model", serviceTier: "flex", emittedAtMs: 101 });
    assert.deepEqual(await f.store.read("chat"), { ...standard, emittedAtMs: 101, revision: 4 }, "conflicting nonnull tiers keep the known model and choose Standard");
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 101 }), false);
    await f.store.write("chat", { model: "other-model", serviceTier: null, emittedAtMs: 101 });
    assert.deepEqual(await f.store.read("chat"), { model: "other-model", serviceTier: null, emittedAtMs: 101, revision: 5 });
    await f.store.write("model-tie", { ...fast, emittedAtMs: 200 });
    await f.store.write("model-tie", { model: "other-model", serviceTier: "priority", emittedAtMs: 200 });
    assert.deepEqual(await f.store.read("model-tie"), { ...standard, emittedAtMs: 200, revision: 2 });
  } finally { await f.close(); }
});

test("notifications use source ordering despite stale connection expectations while SDK snapshots retain CAS", async () => {
  const f = await fixture();
  try {
    await f.store.write("chat", { ...fast, emittedAtMs: 100 }); const expected = (await f.store.read("chat"))!;
    await f.store.write("chat", { ...standard, emittedAtMs: 200 });
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 300 }, expected), true, "a genuine newer Fast notification outranks an old connection baseline");
    assert.deepEqual(await f.store.read("chat"), { ...fast, emittedAtMs: 300, revision: 3 });
    assert.equal(await f.store.write("chat", { ...standard, emittedAtMs: 300 }, expected), true, "equal-time Standard wins even with an old expected row");
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 300 }, expected), false);
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 299 }, expected), false);
    const bytes = await readFile(f.path, "utf8");
    assert.equal(await f.store.write("chat", fast, expected, 400), false, "an unstamped SDK snapshot still requires its captured revision");
    assert.equal(await readFile(f.path, "utf8"), bytes);
  } finally { await f.close(); }
});

test("SDK request-start fences queued older notifications without blocking later source events", async () => {
  const f = await fixture();
  try {
    await f.store.write("chat", { ...fast, emittedAtMs: 100 });
    assert.equal(await f.store.write("chat", standard, (await f.store.read("chat"))!, 300), true);
    assert.deepEqual(await f.store.read("chat"), { ...standard, emittedAtMs: 300, revision: 2 });
    const bytes = await readFile(f.path, "utf8");
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 200 }), false, "a queued event before the SDK read cannot restore Fast");
    assert.equal(await readFile(f.path, "utf8"), bytes);
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 400 }), true, "a source event after request-start remains authoritative");
    assert.deepEqual(await f.store.read("chat"), { ...fast, emittedAtMs: 400, revision: 3 });
    const expected = (await f.store.read("chat"))!;
    await f.store.write("chat", fast, expected, 500);
    assert.deepEqual(await f.store.read("chat"), { ...fast, emittedAtMs: 500, revision: 4 }, "an unchanged tier still advances the source fence");
    const fenced = await readFile(f.path, "utf8");
    assert.equal(await f.store.write("chat", fast, (await f.store.read("chat"))!, 500), true);
    assert.equal(await readFile(f.path, "utf8"), fenced, "the same request-start fence is a duplicate no-op");
    assert.equal(await f.store.write("chat", { ...standard, emittedAtMs: 501 }, expected, 10000), true, "a notification keeps its source stamp instead of using a snapshot fence");
    assert.deepEqual(await f.store.read("chat"), { ...standard, emittedAtMs: 501, revision: 5 });
  } finally { await f.close(); }
});

test("confirmed snapshots recover backwards clocks only after a matching expectation", async () => {
  const f = await fixture();
  try {
    await f.store.write("boundary", { ...standard, emittedAtMs: 5000 });
    const boundary = (await f.store.read("boundary"))!; const before = await readFile(f.path, "utf8");
    assert.equal(await f.store.write("boundary", standard, boundary, 4000), true);
    assert.equal(await readFile(f.path, "utf8"), before, "a source exactly 1000 ms ahead is retained");
    assert.equal(await f.store.write("boundary", standard, boundary, 3999), true);
    assert.deepEqual(await f.store.read("boundary"), { ...standard, emittedAtMs: 3999, uncertainBeforeMs: 5000, revision: 2 });
    const recovered = (await f.store.read("boundary"))!; const saved = await readFile(f.path, "utf8");
    assert.equal(await f.store.write("boundary", fast, boundary, 0), false, "stale CAS cannot reset the source clock");
    assert.equal(await readFile(f.path, "utf8"), saved);
    assert.equal(await f.store.write("boundary", { ...fast, emittedAtMs: 3998 }), false);
    assert.equal(await f.store.write("boundary", fast, recovered, 0), true);
    assert.deepEqual(await f.store.read("boundary"), { ...fast, emittedAtMs: 0, uncertainBeforeMs: 5000, revision: 3 });
    await f.store.write("boundary", { ...standard, emittedAtMs: 1 });
    assert.deepEqual(await f.store.read("boundary"), { ...standard, emittedAtMs: 1, uncertainBeforeMs: 5000, revision: 4 }, "new clock Standard notifications work after confirmed recovery");
  } finally { await f.close(); }
});

test("clock recovery retains an uncertainty watermark that delayed Fast envelopes cannot cross", async () => {
  const f = await fixture();
  try {
    await f.store.write("chat", { ...standard, emittedAtMs: 11000 });
    assert.equal(await f.store.write("chat", standard, (await f.store.read("chat"))!, 8000), true);
    assert.deepEqual(await f.store.read("chat"), { ...standard, emittedAtMs: 8000, uncertainBeforeMs: 11000, revision: 2 });
    const bytes = await readFile(f.path, "utf8");
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 9000 }), false, "the router's 1000 ms grace cannot revive old Fast");
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 11000 }), false, "the uncertainty boundary is inclusive");
    assert.equal(await readFile(f.path, "utf8"), bytes);
    assert.equal(await f.store.write("chat", { ...standard, emittedAtMs: 8500 }), true);
    assert.deepEqual(await f.store.read("chat"), { ...standard, emittedAtMs: 8500, uncertainBeforeMs: 11000, revision: 3 });
    assert.equal(await f.store.write("chat", fast, (await f.store.read("chat"))!, 8050), true, "a confirmed SDK snapshot can establish actual Fast inside uncertainty");
    assert.deepEqual(await f.store.read("chat"), { ...fast, emittedAtMs: 8500, uncertainBeforeMs: 11000, revision: 4 });
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 9000 }), false, "even matching Fast notifications remain uncertain");
    assert.equal(await f.store.write("chat", { ...standard, emittedAtMs: 11001 }), true);
    assert.equal(await f.store.write("chat", { ...fast, emittedAtMs: 11002 }), true);
    assert.deepEqual(await f.store.read("chat"), { ...fast, emittedAtMs: 11002, uncertainBeforeMs: 11000, revision: 6 });
  } finally { await f.close(); }
});

test("watermarks survive repeated snapshots, cannot decrease, and participate in CAS and no-op checks", async () => {
  const f = await fixture();
  try {
    await f.store.write("chat", { ...standard, emittedAtMs: 11000 });
    await f.store.write("chat", standard, (await f.store.read("chat"))!, 8000);
    await f.store.write("chat", { ...fast, uncertainBeforeMs: 0 }, (await f.store.read("chat"))!, 6000);
    const current = (await f.store.read("chat"))!;
    assert.deepEqual(current, { ...fast, emittedAtMs: 6000, uncertainBeforeMs: 11000, revision: 3 }, "a second backwards shift retains the higher watermark");
    const bytes = await readFile(f.path, "utf8");
    assert.equal(await f.store.write("chat", fast, { ...current, uncertainBeforeMs: 10999 }, 0), false);
    assert.equal(await f.store.write("chat", { ...fast, uncertainBeforeMs: 0 }, current, 6000), true);
    assert.equal(await readFile(f.path, "utf8"), bytes, "an identical snapshot cannot clear or rewrite the watermark");
    assert.equal(await f.store.write("chat", { ...standard, emittedAtMs: 6000 }), true, "equal-time Standard can replace current Fast despite uncertainty");
    assert.equal((await f.store.read("chat"))!.uncertainBeforeMs, 11000);
    await f.store.write("zero", { ...standard, emittedAtMs: 0, uncertainBeforeMs: 0 });
    assert.deepEqual(await f.store.read("zero"), { ...standard, emittedAtMs: 0, uncertainBeforeMs: 0, revision: 1 });
    assert.equal(await f.store.write("zero", { ...fast, emittedAtMs: 0 }), false);
    assert.equal(await f.store.write("zero", { ...fast, emittedAtMs: 1 }), true);
    assert.equal((await f.store.read("zero"))!.uncertainBeforeMs, 0);
    await f.store.write("raised", standard);
    await f.store.write("raised", { ...standard, uncertainBeforeMs: 0 });
    assert.deepEqual(await f.store.read("raised"), { ...standard, uncertainBeforeMs: 0, revision: 2 }, "a newly retained watermark is an actual metadata change");
  } finally { await f.close(); }
});

test("revision and source-time fields are strictly bounded and revision overflow preserves bytes", async () => {
  const f = await fixture();
  try {
    await f.store.write("chat", fast); const bytes = await readFile(f.path, "utf8");
    for (const key of ["revision", "emittedAtMs", "uncertainBeforeMs"] as const) for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "1", null, undefined]) {
      await assert.rejects(f.store.write("chat", { ...fast, [key]: value } as ThreadServiceTier), /invalid/);
    }
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(f.store.write("chat", fast, undefined, value), /invalid/);
    assert.equal(await readFile(f.path, "utf8"), bytes);
    const capped = JSON.stringify({ version: 1, threads: { chat: { ...fast, revision: Number.MAX_SAFE_INTEGER, emittedAtMs: Number.MAX_SAFE_INTEGER } } });
    await writeFile(f.path, capped, { mode: 0o600 });
    assert.equal(await f.store.write("chat", fast), true, "an unchanged row needs no new revision");
    await assert.rejects(f.store.write("chat", standard), /invalid/);
    await assert.rejects(f.store.write("chat", fast, undefined, 0), /invalid/);
    assert.equal(await readFile(f.path, "utf8"), capped);
    for (const key of ["revision", "emittedAtMs", "uncertainBeforeMs"]) {
      await writeFile(f.path, JSON.stringify({ version: 1, threads: { chat: { ...fast, [key]: -1 } } }), { mode: 0o600 });
      await assert.rejects(f.store.read("chat"), /invalid/);
    }
  } finally { await f.close(); }
});

test("tier and thread metadata normalize Standard and Fast while supporting literal object-property IDs", async () => {
  const f = await fixture();
  try {
    for (const [tier, expected, revision] of [[null, null, 1], ["standard", null, 1], ["default", null, 1], ["fast", "priority", 2], ["flex", "flex", 3]] as const) {
      await f.store.write("chat", { model: "gateway/model", serviceTier: tier });
      assert.deepEqual(await f.store.read("chat"), { model: "gateway/model", serviceTier: expected, revision });
    }
    for (const id of ["__proto__", "constructor", "toString", "x".repeat(1024)]) {
      assert.equal(await f.store.read(id), undefined);
      await f.store.write(id, { model: "m".repeat(1024), serviceTier: "t".repeat(128) });
      assert.deepEqual(await f.store.read(id), { model: "m".repeat(1024), serviceTier: "t".repeat(128), revision: 1 });
    }
    const saved = await readFile(f.path, "utf8");
    for (const id of ["", "x".repeat(1025), "chat\0other"]) {
      await assert.rejects(f.store.read(id), /invalid/); await assert.rejects(f.store.write(id, fast), /invalid/);
    }
    for (const model of ["", "m".repeat(1025), "model\0secret"]) await assert.rejects(f.store.write("chat", { model, serviceTier: null }), /invalid/);
    for (const tier of ["", "auto", "Priority", "priority\0", "x".repeat(129)]) await assert.rejects(f.store.write("chat", { ...fast, serviceTier: tier }), /invalid/);
    await assert.rejects(f.store.write("chat", { ...fast, credentials: "excluded" } as typeof fast), /invalid/);
    assert.equal(await readFile(f.path, "utf8"), saved);
  } finally { await f.close(); }
});

test("malformed or unexpected persisted metadata rejects reads and preserves bytes on writes", async t => {
  const malformed: unknown[] = [null, [], { version: 2, threads: {} }, { version: 1, threads: [] },
    { version: 1, threads: {}, credentials: "excluded" }, { version: 1, threads: { chat: { model: "m" } } },
    { version: 1, threads: { chat: { ...fast, history: "excluded" } } },
    { version: 1, threads: { unrelated: { model: "m", serviceTier: "auto" } } },
    { version: 1, threads: { "bad\0id": fast } }, { version: 1, threads: { chat: { model: 5, serviceTier: null } } }];
  for (const [i, value] of ["{", ...malformed.map(value => JSON.stringify(value))].entries()) await t.test(`invalid snapshot ${i}`, async () => {
    const f = await fixture();
    try {
      await mkdir(f.state, { mode: 0o700 }); await writeFile(f.path, value, { mode: 0o600 });
      await assert.rejects(f.store.read("chat"), /invalid/);
      await assert.rejects(f.store.write("chat", standard), /invalid/);
      assert.equal(await readFile(f.path, "utf8"), value);
    } finally { await f.close(); }
  });
});

test("unsafe files and state directories fail closed without following links or replacing targets", async t => {
  for (const kind of ["symlink", "dangling-link", "directory", "public", "read-only", "oversized", "fifo", "state-link", "state-public"] as const) await t.test(kind, async () => {
    const f = await fixture();
    try {
      const target = join(f.root, "target"); const bytes = JSON.stringify({ version: 1, threads: { chat: fast } });
      if (kind === "state-link") { await mkdir(target, { mode: 0o700 }); await symlink(target, f.state); }
      else { await mkdir(f.state, { mode: 0o700 }); await writeFile(target, bytes, { mode: 0o600 }); }
      if (kind === "symlink" || kind === "dangling-link") await symlink(kind === "symlink" ? target : join(f.root, "absent"), f.path);
      else if (kind === "directory") await mkdir(f.path);
      else if (kind === "fifo") await execute("mkfifo", [f.path]);
      else if (kind !== "state-link") {
        await writeFile(f.path, kind === "oversized" ? " ".repeat(maxBytes + 1) : bytes, { mode: 0o600 });
        if (kind === "public") await chmod(f.path, 0o644);
        if (kind === "read-only") await chmod(f.path, 0o400);
        if (kind === "state-public") await chmod(f.state, 0o777);
      }
      await assert.rejects(f.store.read("chat"), /invalid/);
      await assert.rejects(f.store.write("chat", standard), /invalid/);
      if (kind !== "state-link") assert.equal(await readFile(target, "utf8"), bytes);
      if (kind === "symlink" || kind === "dangling-link") assert.equal((await lstat(f.path)).isSymbolicLink(), true);
    } finally { await f.close(); }
  });
});

test("invalid UTF-8 cannot become substituted public model metadata", async () => {
  const f = await fixture();
  try {
    await mkdir(f.state, { mode: 0o700 });
    const bytes = Buffer.concat([Buffer.from('{"version":1,"threads":{"chat":{"model":"'), Buffer.from([0xff]), Buffer.from('","serviceTier":null}}}')]);
    await writeFile(f.path, bytes, { mode: 0o600 });
    await assert.rejects(f.store.read("chat"), /invalid/); await assert.rejects(f.store.write("chat", standard), /invalid/);
    assert.deepEqual(await readFile(f.path), bytes);
  } finally { await f.close(); }
});

test("row and serialized byte limits allow existing updates and reject overflow without partial writes", async () => {
  const f = await fixture();
  try {
    await mkdir(f.state, { mode: 0o700 });
    const capped = { version: 1, threads: Object.fromEntries(Array.from({ length: 16384 }, (_, i) => [`chat-${i}`, standard])) };
    await writeFile(f.path, JSON.stringify(capped), { mode: 0o600 });
    assert.deepEqual(await f.store.read("chat-16383"), { ...standard, revision: 0 });
    assert.equal(await f.store.write("chat-16383", fast), true);
    const before = await readFile(f.path, "utf8"); await assert.rejects(f.store.write("additional", standard), /invalid/);
    assert.equal(await readFile(f.path, "utf8"), before);
    capped.threads.additional = standard; await writeFile(f.path, JSON.stringify(capped), { mode: 0o600 });
    await assert.rejects(f.store.read("chat-0"), /invalid/);
    const valid = JSON.stringify({ version: 1, threads: { chat: fast } });
    await writeFile(f.path, valid.padEnd(maxBytes, " "), { mode: 0o600 });
    assert.deepEqual(await f.store.read("chat"), { ...fast, revision: 0 }, "exactly 4 MiB is accepted");
    const dense = JSON.stringify({ version: 1, threads: Object.fromEntries(Array.from({ length: 3900 }, (_, i) => [`chat-${i}`, { model: "m".repeat(1024), serviceTier: null }])) });
    assert.ok(Buffer.byteLength(dense) < maxBytes);
    assert.ok(Buffer.byteLength(JSON.stringify(JSON.parse(dense), null, 2) + "\n") > maxBytes);
    await writeFile(f.path, dense, { mode: 0o600 });
    await assert.rejects(f.store.write("chat-0", standard), /invalid/);
    assert.equal(await readFile(f.path, "utf8"), dense, "pretty serialization cannot exceed the byte limit");
  } finally { await f.close(); }
});

test("the exported validity check matches exactly what the store accepts", async () => {
  const f = await fixture();
  const cases: unknown[] = [null, "priority", "flex", "default", "standard", "a", "a_b-9", "x".repeat(128), "auto", "Fast", "PRIORITY", "", "1abc", "a b", "x".repeat(129), "x".repeat(200), 5, undefined, {}];
  for (const tier of cases) {
    const accepted = await f.store.write("chat", { model: "gateway/model", serviceTier: tier as string | null }).then(() => true, () => false);
    assert.equal(storableServiceTier(tier), accepted, JSON.stringify(tier)?.slice(0, 20));
  }
});
