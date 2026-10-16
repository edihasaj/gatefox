import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyThread, type ClassifyContext, type ClassifyThread } from "../gateway-chat-classifier.js";
import { GatewayChatRegistry } from "../gateway-chat-registry.js";

const alias = "gateway/sol"; const native = "gpt-6.1-sol"; const shared = "gpt-6.1";
const gateway = "subscription_gateway";
/** One context per case: `chats` is what readParent can see, `recorded` is what the registry holds. */
function context(chats: Record<string, ClassifyThread> = {}, opts: { recorded?: Iterable<string>; aliases?: readonly string[] } = {}): ClassifyContext {
  const known = new Set(opts.recorded ?? []);
  return { aliases: opts.aliases ?? [alias], nativeSlugs: [native, shared], registry: { has: id => known.has(id) }, readParent: id => chats[id] };
}
const chat = (id: string, extra: ClassifyThread = {}): ClassifyThread => ({ id, ...extra });

test("the fixed rule order answers gateway for a legacy provider, a registry hit, and an alias", () => {
  assert.deepEqual(classifyThread({ modelProvider: gateway, model: native }, context()), { kind: "gateway", rule: "legacy_provider" });
  assert.deepEqual(classifyThread({ modelProvider: "openai", model: alias }, context()), { kind: "gateway", rule: "alias" });
  assert.deepEqual(classifyThread({ modelProvider: "openai", model: native }, context()), { kind: "native", rule: "native" });
  // The registry outranks both catalogs: a native slug the gateway started is still a gateway chat.
  assert.deepEqual(classifyThread(chat("c1", { modelProvider: "openai", model: native }), context({}, { recorded: ["c1"] })), { kind: "gateway", rule: "registry" });
  // A retired alias that has left the catalog is a gateway chat by its registry entry alone.
  assert.deepEqual(classifyThread(chat("c2", { modelProvider: "openai", model: "gateway/retired" }), context({}, { recorded: ["c2"] })), { kind: "gateway", rule: "registry" });
  // An alias that names a native slug is native: the native catalog wins the tie.
  assert.deepEqual(classifyThread({ modelProvider: "openai", model: shared }, context({}, { aliases: [shared] })), { kind: "native", rule: "native" });
  assert.deepEqual(classifyThread({}, context()), { kind: "native", rule: "native" }, "a thread with nothing to read is native");
  assert.deepEqual(classifyThread(chat("c3", { modelProvider: gateway }), context({}, { recorded: ["c3"] })), { kind: "gateway", rule: "legacy_provider" }, "the provider wins a tie with the registry");
});

test("a sub-agent follows its parent, from either field or the source shapes", () => {
  const parent = chat("root", { model: native });
  assert.deepEqual(classifyThread(chat("child", { modelProvider: "openai", model: native, parentThreadId: "root" }),
    { ...context({ root: parent, child: chat("child") }), registry: { has: id => id === "root" } }), { kind: "gateway", rule: "parent" });
  // The e7 shape: a native provider and a native model, but the chat it came from is the gateway's.
  assert.deepEqual(classifyThread(chat("e7", { modelProvider: "openai", model: native, source: { subAgent: { thread_spawn: { parent_thread_id: "root" } } } }),
    { ...context({ root: parent, e7: chat("e7") }), registry: { has: id => id === "root" } }), { kind: "gateway", rule: "parent" });
  for (const source of [{ subagent: { threadSpawn: { parentThreadId: "root" } } }, { sub_agent: { thread_spawn: { parentThreadId: "root" } } }, { parentThreadId: "root" }, { subAgent: { thread_spawn: { parentThreadId: "root" } } }]) {
    const chats = { root: parent, s: chat("s", { source }) };
    assert.deepEqual(classifyThread(chats.s, { ...context(chats), registry: { has: (id: string) => id === "root" } }), { kind: "gateway", rule: "parent" }, JSON.stringify(source));
  }
  // A native parent carries no gateway claim: the chat falls through to the rules below it.
  assert.deepEqual(classifyThread(chat("kid", { modelProvider: "openai", model: native, parentThreadId: "nat" }), context({ nat: chat("nat", { modelProvider: "openai" }), kid: chat("kid") })), { kind: "native", rule: "native" });
  // A sub-agent with a gateway alias under a native parent is still gateway, by that alias.
  assert.deepEqual(classifyThread(chat("kid", { modelProvider: "openai", model: alias, parentThreadId: "nat" }), context({ nat: chat("nat"), kid: chat("kid") })), { kind: "gateway", rule: "alias" });
  // A legacy provider two hops up is a gateway ancestor, read through its own record.
  assert.deepEqual(classifyThread(chat("g", { parentThreadId: "mid" }), context({ mid: chat("mid", { parentThreadId: "old" }), old: { modelProvider: gateway }, g: chat("g") })), { kind: "gateway", rule: "parent" });
});

test("a parent walk stops at a cycle or at eight hops", () => {
  const loop = { a: chat("a", { parentThreadId: "b" }), b: chat("b", { parentThreadId: "a" }) };
  assert.deepEqual(classifyThread(loop.a, context(loop)), { kind: "native", rule: "native" }, "a cycle yields no match instead of hanging");
  const self = chat("s", { parentThreadId: "s" });
  assert.deepEqual(classifyThread(self, context({ s: self })), { kind: "native", rule: "native" });
  // A chain one hop deeper than the limit hides its gateway root; within the limit it is found.
  for (const hops of [1, 8, 9]) {
    const chats: Record<string, ClassifyThread> = { root: chat("root"), t: chat("t", { parentThreadId: hops === 1 ? "root" : "p0" }) };
    for (let i = 0; i + 1 < hops; i++) chats[`p${i}`] = chat(`p${i}`, { parentThreadId: i + 2 === hops ? "root" : `p${i + 1}` });
    assert.deepEqual(classifyThread(chats.t, context(chats, { recorded: ["root"] })),
      hops <= 8 ? { kind: "gateway", rule: "parent" } : { kind: "native", rule: "native" }, `gateway root at ${hops} hops`);
  }
  // A record that cannot be read ends the chain, but its id is still known to the registry.
  assert.deepEqual(classifyThread(chat("t", { parentThreadId: "gone" }), context({ t: chat("t", { parentThreadId: "gone" }) }, { recorded: ["gone"] })), { kind: "gateway", rule: "parent" });
});

test("a registry snapshot answers the classifier in one pass, with no read per chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-chat-classifier-"));
  try {
    const state = join(root, "state"); const home = join(root, "native"); await mkdir(home, { mode: 0o700 });
    const registry = new GatewayChatRegistry(state, home);
    await registry.record("gateway-row", "start", 1000);
    const known = await registry.snapshot();
    const ctx: ClassifyContext = { aliases: [alias], nativeSlugs: [native], registry: { has: id => known.has(id) }, readParent: () => undefined };
    // Both rows are native by every catalog they can see; only the registry tells them apart.
    assert.deepEqual(classifyThread(chat("gateway-row", { modelProvider: "openai", model: native }), ctx), { kind: "gateway", rule: "registry" });
    assert.deepEqual(classifyThread(chat("native-row", { modelProvider: "openai", model: native }), ctx), { kind: "native", rule: "native" });
    await registry.record("child-row", "subagent", 1001);
    const parented: ClassifyContext = { ...ctx, readParent: id => id === "child-row" ? chat("child-row", { parentThreadId: "gateway-row" }) : undefined };
    assert.deepEqual(classifyThread(chat("child-row", { parentThreadId: "gateway-row" }), parented), { kind: "gateway", rule: "parent" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a parent started on an alias is a gateway parent even when the registry has lost it", () => {
  const parent = chat("P", { modelProvider: "openai", model: alias });
  // The e7 shape under an empty registry: openai and a native slug, whose parent was started on an alias.
  const child = chat("e7", { modelProvider: "openai", model: native, parentThreadId: "P" });
  assert.deepEqual(classifyThread(child, context({ P: parent, e7: child })), { kind: "gateway", rule: "parent" });
  // Two hops up, the alias still reaches a chat whose nearer parent says nothing.
  const mid = chat("M", { modelProvider: "openai", model: native, parentThreadId: "P" });
  assert.deepEqual(classifyThread(chat("e8", { parentThreadId: "M" }), context({ P: parent, M: mid })), { kind: "gateway", rule: "parent" });
  // An alias that is also a native slug makes no claim: the native catalog wins the tie, for a parent as for a chat.
  const tied = chat("T", { modelProvider: "openai", model: shared });
  assert.deepEqual(classifyThread(chat("kid", { modelProvider: "openai", model: native, parentThreadId: "T" }), context({ T: tied }, { aliases: [shared, alias] })), { kind: "native", rule: "native" });
  // A parent on a model the gateway no longer serves says nothing either.
  assert.deepEqual(classifyThread(chat("kid", { modelProvider: "openai", model: native, parentThreadId: "R" }), context({ R: chat("R", { model: "gateway/retired" }) })), { kind: "native", rule: "native" });
  // The aliases may be a set, as a loaded catalog gives them.
  assert.deepEqual(classifyThread(child, { ...context({ P: parent }), aliases: new Set([alias]), nativeSlugs: new Set([native]) }), { kind: "gateway", rule: "parent" });
});

test("explicit nulls and empty strings are no claim, anywhere in the chain", () => {
  const empty = { id: null, modelProvider: null, model: null, source: null, parentThreadId: null } as unknown as ClassifyThread;
  assert.deepEqual(classifyThread(empty, context()), { kind: "native", rule: "native" });
  const nulls = { modelProvider: null, model: null, parentThreadId: null, source: null } as unknown as ClassifyThread;
  assert.deepEqual(classifyThread(chat("k", { parentThreadId: "n" }), context({ n: nulls })), { kind: "native", rule: "native" });
  assert.deepEqual(classifyThread(chat("k", { parentThreadId: "n" }), context({ n: { modelProvider: "", model: "" } })), { kind: "native", rule: "native" });
  assert.deepEqual(classifyThread(chat("k", { parentThreadId: "n" }), context({ n: { model: 7 as unknown as string } })), { kind: "native", rule: "native" });
});

test("a registry that cannot be read leaves the alias and parent rules in charge", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-chat-classifier-"));
  try {
    const state = join(root, "state"); const home = join(root, "native"); await mkdir(home, { mode: 0o700 });
    let reports = 0;
    const registry = new GatewayChatRegistry(state, home, () => reports++);
    await registry.record("remembered", "start", 1000);
    const file = join(state, "gateway-chats", (await readdir(join(state, "gateway-chats"))).find(name => name.endsWith(".json"))!);
    await writeFile(file, "{ not json\n", { mode: 0o600 });
    const lost = new GatewayChatRegistry(state, home, () => reports++);
    const ctx: ClassifyContext = { aliases: [alias], nativeSlugs: [native], registry: { has: id => lost.hasCached(id) }, readParent: id => ({ P: chat("P", { modelProvider: "openai", model: alias }), G: chat("G", { modelProvider: gateway }) })[id] };
    await lost.refresh();
    assert.equal(reports, 1, "the unreadable file is reported once");
    assert.deepEqual(classifyThread(chat("remembered", { modelProvider: "openai", model: native }), ctx), { kind: "native", rule: "native" }, "the registry is the only rule that is lost");
    assert.deepEqual(classifyThread(chat("c", { modelProvider: "openai", model: alias }), ctx), { kind: "gateway", rule: "alias" });
    assert.deepEqual(classifyThread(chat("c", { modelProvider: "openai", model: native, parentThreadId: "P" }), ctx), { kind: "gateway", rule: "parent" }, "an alias parent");
    assert.deepEqual(classifyThread(chat("c", { modelProvider: "openai", model: native, parentThreadId: "G" }), ctx), { kind: "gateway", rule: "parent" }, "a legacy provider parent");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("each ancestor is read once", () => {
  const chats: Record<string, ClassifyThread> = {
    a: chat("a", { modelProvider: "openai", model: native, parentThreadId: "b" }),
    b: chat("b", { modelProvider: "openai", model: native, parentThreadId: "c" }),
    c: chat("c", { modelProvider: "openai", model: native }),
  };
  const reads: string[] = [];
  const ctx: ClassifyContext = { aliases: [alias], nativeSlugs: [native], registry: { has: () => false }, readParent: id => (reads.push(id), chats[id]) };
  assert.deepEqual(classifyThread(chat("t", { parentThreadId: "a" }), ctx), { kind: "native", rule: "native" });
  assert.deepEqual(reads, ["a", "b", "c"], "one read per hop, however many questions the record answers");
  reads.length = 0; chats.c = chat("c", { modelProvider: gateway });
  assert.deepEqual(classifyThread(chat("t", { parentThreadId: "a" }), ctx), { kind: "gateway", rule: "parent" });
  assert.deepEqual(reads, ["a", "b", "c"], "a gateway answer stops the walk at the hop that gave it");
});
