import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { holdsChatStore, holdsThisChatStore, migrateChats } from "../chat-migrate.js";

const idle = async () => [];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "chat-migrate-")), sessions = join(home, "sessions");
  await mkdir(sessions);
  const { DatabaseSync } = await import("node:sqlite") as unknown as { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }; close(): void } };
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL)");
  const rollout = async (id: string, provider: string, rest = "") => {
    const path = join(sessions, `rollout-${id}.jsonl`);
    await writeFile(path, `{"timestamp":"t","type":"session_meta","payload":{"id":"${id}","model_provider":"${provider}","n":1.0}}\n${rest}`, { mode: 0o600 });
    db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(id, path, provider); return path;
  };
  const big = '{"type":"event","text":"' + "x".repeat(200_000) + '"}\n';
  const paths = { a: await rollout("a", "subscription_gateway", big + '{"type":"turn","model_provider":"subscription_gateway"}\n'), b: await rollout("b", "subscription_gateway"), c: await rollout("c", "openai") };
  db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run("gone", join(sessions, "missing.jsonl"), "subscription_gateway");
  db.close();
  await writeFile(join(home, "config.toml"), "[model_providers.subscription_gateway]\nname = \"GateFox\"\n[model_providers.gatefox]\nname = \"GateFox\"\n");
  const providers = async () => {
    const d = new DatabaseSync(join(home, "state_5.sqlite"));
    try { return Object.fromEntries((d.prepare("SELECT id, model_provider FROM threads").all() as Array<{ id: string; model_provider: string }>).map(r => [r.id, r.model_provider])); } finally { d.close(); }
  };
  return { home, paths, providers, cleanup: () => rm(home, { recursive: true, force: true }) };
}

test("a dry run reports the chats to move and changes nothing", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.paths.a);
    const result = await migrateChats({ codexHome: f.home, busy: idle });
    assert.deepEqual([result.applied, result.chats, result.rolloutsToRewrite, result.rolloutsMissing], [false, 3, 2, 1]);
    assert.deepEqual(await readFile(f.paths.a), before);
    assert.equal((await f.providers()).a, "subscription_gateway");
  } finally { await f.cleanup(); }
});

test("apply moves every saved gateway chat to gatefox, changing only the session_meta provider, and a rerun is a no-op", async () => {
  const f = await fixture();
  try {
    const before = (await readFile(f.paths.a, "utf8")).split("\n");
    const result = await migrateChats({ codexHome: f.home, apply: true, busy: idle });
    assert.equal(result.applied, true); assert.equal(result.rolloutsRewritten, 2); assert.deepEqual(result.skipped, []);
    assert.deepEqual(await f.providers(), { a: "gatefox", b: "gatefox", c: "openai", gone: "gatefox" });
    const after = (await readFile(f.paths.a, "utf8")).split("\n");
    assert.equal(after[0], before[0]!.replace('"model_provider":"subscription_gateway"', '"model_provider":"gatefox"'));
    assert.deepEqual(after.slice(1), before.slice(1), "every later line is byte-identical, including a later mention of the old id");
    assert.match(await readFile(f.paths.c, "utf8"), /"openai"/);
    assert.ok((await readdir(f.home)).some(name => name.startsWith("state_5.sqlite.before-gatefox-chats-")), "the database is copied first");
    assert.ok(!(await readdir(join(f.home, "sessions"))).some(name => name.endsWith(".gatefox")), "no temporary files remain");
    const again = await migrateChats({ codexHome: f.home, apply: true, busy: idle });
    assert.deepEqual([again.chats, again.rolloutsRewritten], [0, 0]);
  } finally { await f.cleanup(); }
});

test("a run interrupted after the rollouts finishes the database on the next run", async () => {
  const f = await fixture();
  try {
    await writeFile(f.paths.b, (await readFile(f.paths.b, "utf8")).replace('"subscription_gateway"', '"gatefox"'));
    const result = await migrateChats({ codexHome: f.home, apply: true, busy: idle });
    assert.equal(result.rolloutsAlreadyMoved, 1);
    assert.equal((await f.providers()).b, "gatefox");
  } finally { await f.cleanup(); }
});

test("revert moves them back", async () => {
  const f = await fixture();
  try {
    await migrateChats({ codexHome: f.home, apply: true, busy: idle });
    await migrateChats({ codexHome: f.home, apply: true, revert: true, busy: idle });
    assert.deepEqual(await f.providers(), { a: "subscription_gateway", b: "subscription_gateway", c: "openai", gone: "subscription_gateway" });
    assert.match((await readFile(f.paths.a, "utf8")).split("\n")[0]!, /"model_provider":"subscription_gateway"/);
  } finally { await f.cleanup(); }
});

test("apply refuses while ChatGPT or the service runs, or without the gatefox provider row", async () => {
  const f = await fixture();
  try {
    await assert.rejects(migrateChats({ codexHome: f.home, apply: true, busy: async () => ["123 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT"] }), /Quit ChatGPT/);
    await writeFile(join(f.home, "config.toml"), "[model_providers.subscription_gateway]\n");
    await assert.rejects(migrateChats({ codexHome: f.home, apply: true, busy: idle }), /model_providers\.gatefox/);
    assert.equal((await f.providers()).a, "subscription_gateway");
  } finally { await f.cleanup(); }
});

test("an engine-compressed rollout (.jsonl.zst beside the recorded path) is rewritten through zstd", async () => {
  const f = await fixture();
  try {
    const plain = await readFile(f.paths.a), zst = `${f.paths.a}.zst`;
    await writeFile(zst, zstdCompressSync(plain)); await rm(f.paths.a);
    const dry = await migrateChats({ codexHome: f.home, busy: idle });
    assert.equal(dry.rolloutsToRewrite, 2);
    await migrateChats({ codexHome: f.home, apply: true, busy: idle });
    const lines = zstdDecompressSync(await readFile(zst)).toString("utf8").split("\n"), before = plain.toString("utf8").split("\n");
    assert.match(lines[0]!, /"model_provider":"gatefox"/);
    assert.deepEqual(lines.slice(1), before.slice(1));
    assert.equal((await f.providers()).a, "gatefox");
  } finally { await f.cleanup(); }
});

test("only processes that open the chat store block the migration", () => {
  for (const command of ["1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT", "2 /x/codex -c a=b app-server --listen stdio://",
    "3 /x/node /x/dist/cli.js codex-shim --ssh --config c", "4 /x/node /x/dist/cli.js daemon --config c", "5 /x/native/gateway-native-relay --native-home /h"]) assert.equal(holdsChatStore(command), true, command);
  for (const command of ["6 /x/node /x/dist/cli.js serve --config /tmp/gw-fast/server.json", "7 /bin/zsh gatefox chats migrate --apply"]) assert.equal(holdsChatStore(command), false, command);
});

test("only processes on the same Codex home block the migration", () => {
  const engine = "8283 /opt/homebrew/bin/codex app-server --listen stdio://";
  assert.equal(holdsThisChatStore(engine, "PATH=/bin CODEX_HOME=/Users/dev/.codex", "/Users/dev/.codex", "/Users/dev"), true);
  assert.equal(holdsThisChatStore(engine, "CODEX_HOME=/Users/dev/.codex-primary", "/Users/dev/.codex", "/Users/dev"), false, "another Mission Runtime home");
  assert.equal(holdsThisChatStore(engine, "PATH=/bin", "/Users/dev/.codex", "/Users/dev"), true, "no CODEX_HOME means ~/.codex");
  assert.equal(holdsThisChatStore("9 /x/node --import p.mjs --test --test-concurrency=4 dist/tests/app-server.test.js", "", "/Users/dev/.codex", "/Users/dev"), false, "a test runner");
  assert.equal(holdsThisChatStore("10 /x/node /x/dist/cli.js codex-shim --config /tmp/t/gateway.json", "CODEX_HOME=/tmp/t/home", "/Users/dev/.codex", "/Users/dev"), false, "an isolated test home");
});
