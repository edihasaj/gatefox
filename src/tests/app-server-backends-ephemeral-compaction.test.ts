import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { CompactionStateStore } from "../compaction-state.js";
import { BoundedIdSet } from "../bounded-id-set.js";
import type { Message } from "../app-server-connection.js";
import { compactionSdkFixture, largeModel, until } from "./compaction-sdk-fixture.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";
import { GatewayChatRegistry } from "../gateway-chat-registry.js";
import { identityTest } from "./identity-cases.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.

// Throwaway chats stay out of every gateway file, the chat registry included, whichever provider id their parent was saved with.
let gateway = "subscription_gateway";
const bothIdentities = identityTest(identity => { gateway = identity.provider; });

type Fixture = Awaited<ReturnType<typeof compactionSdkFixture>>;
const input = [{ type: "text", text: "go" }];
const finished = (f: Fixture, threadId: string) => f.events.some(event => event.method === "turn/completed" && (event.params as Message)?.threadId === threadId);
// The gateway forwards a notification only after its compaction metadata is written, so a seen event means the row is settled.
async function turn(f: Fixture, threadId: string): Promise<void> {
  await f.backends.request("turn/start", { threadId, model: largeModel, input });
  await until(() => finished(f, threadId));
}
const row = (f: Fixture, threadId: string) => new CompactionStateStore(f.config.stateDirectory, resolve(f.nativeHome)).read(threadId);
const fork = (f: Fixture, id: string, params: Message) => f.backends.request("thread/fork", { threadId: "parent", fixtureId: id, ...params });

bothIdentities("a throwaway chat's turns write no compaction row and no registry entry, however the gateway learns it is throwaway", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture(false, true, gateway);
  try {
    await f.start("parent"); await turn(f, "parent");
    assert.ok(await row(f, "parent"), "an ordinary chat's finished turn is saved, so this test can see a row");
    // The desktop's composer suggestion: a prediction fork that carries no ephemeral flag of its own.
    await fork(f, "by-mode", { experimentalPredictionMode: true, ephemeral: true, excludeTurns: true });
    await fork(f, "by-param", { experimentalPredictionMode: true });
    // The executor alone reports the chat as ephemeral: in its answer, or only in its thread/started notification.
    await fork(f, "by-result", { fixtureEphemeral: true, fixtureNoStarted: true });
    await fork(f, "by-notice", { fixtureEphemeral: true, fixtureHideResult: true });
    // Only the request says so: the executor reports nothing.
    await fork(f, "by-flag", { ephemeral: true, fixtureNoStarted: true, fixtureHideResult: true });
    // A chat the desktop started as ephemeral.
    await f.backends.request("thread/start", { fixtureId: "started", model: largeModel, modelProvider: gateway, ephemeral: true }, { engine: "gateway" });
    for (const id of ["by-mode", "by-param", "by-result", "by-notice", "by-flag", "started"]) { await turn(f, id); assert.equal(await row(f, id), undefined, id); }
    // A fork that is not throwaway is saved like its parent.
    await fork(f, "ordinary", {}); await turn(f, "ordinary");
    assert.ok(await row(f, "ordinary"));
    const registry = new GatewayChatRegistry(f.config.stateDirectory, f.nativeHome);
    assert.deepEqual([...await registry.snapshot()].sort(), ["ordinary", "parent"], "only durable gateway chats are recorded");
  } finally { await f.clean(); }
});

test("a rollback writes a reset row for an ordinary chat but none for a throwaway chat", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture();
  try {
    await f.start("parent"); await turn(f, "parent");
    await fork(f, "throwaway", { experimentalPredictionMode: true, ephemeral: true, excludeTurns: true });
    await fork(f, "plain", {});
    for (const id of ["throwaway", "plain"]) await f.backends.request("thread/rollback", { threadId: id, numTurns: 1 });
    assert.equal(await row(f, "throwaway"), undefined, "a throwaway chat is memory-only, rollback included");
    assert.ok(await row(f, "plain"), "an ordinary chat records the reset");
  } finally { await f.clean(); }
});

test("a durable chat resumed with ephemeral: true is not throwaway, so its turns are still saved", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture();
  try {
    await f.start("durable"); await turn(f, "durable");
    const first = (await row(f, "durable"))!.emittedAtMs;
    // The executor answers a resume with the chat's own flags, which are durable; the request flag does not make it throwaway.
    await f.backends.request("thread/resume", { threadId: "durable", ephemeral: true });
    const done = () => f.events.filter(event => event.method === "turn/completed" && (event.params as Message)?.threadId === "durable").length;
    const before = done();
    await f.backends.request("turn/start", { threadId: "durable", model: largeModel, input });
    await until(() => done() > before);
    assert.ok((await row(f, "durable"))!.emittedAtMs > first, "the turn after the resume was saved");
  } finally { await f.clean(); }
});

test("a throwaway chat is forgotten when it is closed, unsubscribed or deleted, and a new chat never inherits it", { timeout: 15000 }, async () => {
  const f = await compactionSdkFixture();
  try {
    await f.start("parent");
    // Unsubscribe without the executor's closed notice, the notice alone, and the two other ways a chat ends.
    const ends: Array<[string, Message]> = [["thread/unsubscribe", { fixtureNoClosed: true }], ["fixture/closed", {}], ["thread/delete", {}], ["thread/archive", {}]];
    for (const [index, [end, extra]] of ends.entries()) {
      const id = `reused-${index}`;
      await fork(f, id, { experimentalPredictionMode: true });
      await f.backends.request(end, { threadId: id, ...extra });
      // The same id returns as an ordinary chat: it must be saved again.
      await f.backends.request("thread/start", { fixtureId: id, model: largeModel, modelProvider: "subscription_gateway" }, { engine: "gateway" });
      await turn(f, id);
      assert.ok(await row(f, id), end);
    }
  } finally { await f.clean(); }
});

test("the set of throwaway chat ids stays bounded and forgets the oldest first", () => {
  const ids = new BoundedIdSet(3);
  for (const id of ["a", "b", "c"]) ids.add(id);
  ids.add("a"); ids.add("d");
  assert.deepEqual(["a", "b", "c", "d"].map(id => ids.has(id)), [true, false, true, true]);
  assert.equal(ids.size, 3);
  ids.delete("a"); assert.equal(ids.has("a"), false);
  for (let index = 0; index < 10000; index++) ids.add(`x${index}`);
  assert.equal(ids.size, 3);
});
