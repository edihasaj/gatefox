import test from "node:test";
import assert from "node:assert/strict";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { batch, defaultWrite, fixture, fork, id, modelWrite, object, omitsTier, pick, reconnect, refused, savedTier, settled, sharedTurn, start, type F, type ObjectValue } from "./speed-fixture.js";

// A gateway chat made Fast by a pick inside it, as the engine reports it.
async function fastChat(f: F, router = f.router) {
  const chat = id(await start(router, "codex/model", null, "high"));
  await pick(router, chat, "priority");
  await new Promise(done => setTimeout(done, 5));
  await router.observeNotification(settled(chat, "codex/model", "priority"));
  return chat;
}
const configTier = async (f: F) => object((await f.router.request("config/read", {})).config).service_tier;

test("a Fast gateway chat keeps Fast when the desktop resumes it with another speed", async () => {
  const f = await fixture();
  await modelWrite(f.router, "codex/model", "high"); await defaultWrite(f.router, "default");
  const chat = await fastChat(f);
  // Voice and heartbeat hydration resume with null; a reconnect names the shared default.
  for (const tier of [null, "default"]) {
    const fresh = await f.connect();
    await reconnect(fresh, chat, tier); assert.equal(f.last("thread/resume").serviceTier, "priority", String(tier));
  }
  const standard = id(await start(f.router, "codex/model", null));
  await new Promise(done => setTimeout(done, 5));
  await f.router.observeNotification(settled(standard, "codex/model", null));
  await reconnect(await f.connect(), standard, "priority"); assert.equal(f.last("thread/resume").serviceTier, null, "a Standard chat is not made Fast either");
});

test("turns that carry the desktop's default speed leave a gateway chat's own speed unchanged", async () => {
  const f = await fixture();
  await modelWrite(f.router, "codex/model", "high"); await defaultWrite(f.router, "default");
  const chat = await fastChat(f);
  for (const trigger of ["notification_reply", "composer_queue_run_now"]) {
    await sharedTurn(f.router, chat, null, trigger); assert.ok(omitsTier(f.last("turn/start")), trigger);
  }
  await f.router.request("thread/resume", { threadId: chat }); assert.equal(f.last("thread/resume").serviceTier, "priority", "the turns did not record Standard");
  const standard = id(await start(f.router, "codex/model", null));
  await sharedTurn(f.router, standard, "priority"); assert.ok(omitsTier(f.last("turn/start")));
  await f.router.request("thread/resume", { threadId: standard }); assert.equal(f.last("thread/resume").serviceTier, null, "the turn did not record Fast");
  // A turn on a gateway chat whose speed this adapter never recorded still leaves the engine's own speed.
  const unrecorded = id(await f.backend("thread/start", { model: "codex/model", modelProvider: "subscription_gateway" }));
  await sharedTurn(f.router, unrecorded, "priority"); assert.ok(omitsTier(f.last("turn/start")));
});

test("a fork keeps its parent's speed, not the default speed in the configuration the desktop sends", async () => {
  const f = await fixture();
  await modelWrite(f.router, "codex/model", "high"); await defaultWrite(f.router, "default");
  const chat = await fastChat(f);
  await fork(f.router, chat, "default");
  assert.equal(f.last("thread/fork").serviceTier, "priority"); assert.equal(Object.hasOwn(object(f.last("thread/fork").config), "service_tier"), false);
  const standard = id(await start(f.router, "codex/model", null));
  await fork(f.router, standard, "priority"); assert.equal(f.last("thread/fork").serviceTier, null);
  // A fork to another model is a new chat for its speed: the desktop's Fast default does not carry over.
  const g = await fixture();
  await modelWrite(g.router, "native", "high"); await defaultWrite(g.router, "priority");
  const claude = id(await start(g.router, "claude/model", null));
  await g.router.request("thread/fork", { threadId: claude, model: "codex/model", config: { service_tier: "priority" } });
  assert.equal(g.last("thread/fork").serviceTier, null); assert.equal(Object.hasOwn(object(g.last("thread/fork").config), "service_tier"), false);
});

test("the desktop's Fast default never starts a gateway chat in Fast", async () => {
  const configured = await fixture();
  configured.native.config = { model: "native", service_tier: "fast" };
  const chat = id(await start(configured.router, "codex/model", "fast", "high"));
  assert.equal(configured.last("thread/start").serviceTier, null, "Fast set in the native config.toml");
  await sharedTurn(configured.router, chat, "fast", "composer"); assert.ok(omitsTier(configured.last("turn/start")), "the draft's first turn");
  await configured.router.request("thread/resume", { threadId: chat }); assert.equal(configured.last("thread/resume").serviceTier, null);
  const saved = await fixture();
  await modelWrite(saved.router, "native", "high"); await defaultWrite(saved.router, "priority");
  await start(saved.router, "codex/model", "priority"); assert.equal(saved.last("thread/start").serviceTier, null, "Fast saved for a native model");
  await saved.router.request("thread/start", { model: "codex/model", config: { service_tier: "priority" } });
  assert.equal(saved.last("thread/start").serviceTier, null); assert.equal(Object.hasOwn(object(saved.last("thread/start").config), "service_tier"), false);
  await saved.router.request("thread/start", { model: "native" }); assert.equal(saved.last("thread/start").serviceTier, "priority", "native chats keep it");
});

test("a Fast default the desktop still holds after the default model changes keeps gateway drafts Standard until a Standard start", async () => {
  const f = await fixture();
  await modelWrite(f.router, "native", "high"); await defaultWrite(f.router, "priority");
  await start(f.router, "native", null); // a draft that keeps its own Standard while the configuration is Fast
  await start(await f.connect(), "native", null); // also on a connection that did not save the Fast
  assert.equal((await f.file()).desktop_fast_default, true);
  await modelWrite(f.router, "codex/model", "high");
  assert.equal(await configTier(f), undefined, "the saved Fast is gone, but the desktop keeps it in memory");
  await start(f.router, "codex/model", "priority"); assert.equal(f.last("thread/start").serviceTier, null);
  await start(f.router, "codex/model", null); // the connection that saved Fast knows the desktop still holds it
  assert.equal((await f.file()).desktop_fast_default, true);
  await start(f.router, "codex/model", "priority"); assert.equal(f.last("thread/start").serviceTier, null);
  const restarted = await f.connect(); // a gateway upgrade restarts the adapter, not the desktop
  await start(restarted, "codex/model", "priority"); assert.equal(f.last("thread/start").serviceTier, null);
  await start(restarted, "codex/model", null);
  assert.equal(Object.hasOwn(await f.file(), "desktop_fast_default"), false, "a draft that names Standard shows the desktop no longer holds Fast");
  await start(restarted, "codex/model", "priority"); assert.equal(f.last("thread/start").serviceTier, "priority", "a later pick for one draft applies");
});

test("another desktop's Standard start does not end the Fast this desktop's connection saved", async () => {
  const f = await fixture();
  await modelWrite(f.router, "native", "high"); await defaultWrite(f.router, "priority"); await modelWrite(f.router, "codex/model", "high");
  const other = await f.connect(); // a second desktop on the same gateway state
  await start(other, "codex/model", null);
  assert.equal(Object.hasOwn(await f.file(), "desktop_fast_default"), false);
  await start(f.router, "codex/model", "priority"); assert.equal(f.last("thread/start").serviceTier, null);
});

test("choosing Standard as the default ends the Fast the desktop held, and the marker never reaches the desktop", async () => {
  const f = await fixture();
  await modelWrite(f.router, "native", "high"); await defaultWrite(f.router, "priority");
  assert.equal((await f.file()).desktop_fast_default, true);
  assert.equal(Object.hasOwn(object((await f.router.request("config/read", {})).config), "desktop_fast_default"), false);
  await defaultWrite(f.router, "default"); await modelWrite(f.router, "codex/model", "high");
  assert.equal(Object.hasOwn(await f.file(), "desktop_fast_default"), false);
  await start(f.router, "codex/model", "priority"); assert.equal(f.last("thread/start").serviceTier, "priority");
});

test("re-selecting Fast in a gateway chat that is already Fast saves it only as a native default; gateway chats still start Standard", async () => {
  const f = await fixture();
  await modelWrite(f.router, "native", "high"); await defaultWrite(f.router, "default");
  const chat = await fastChat(f);
  await assert.rejects(defaultWrite(f.router, "priority"), refused, "the pick's own follow-up write");
  // Re-selecting the chat's current speed sends no settings update, only the default write.
  await defaultWrite(f.router, "priority");
  assert.deepEqual(await savedTier(f), { file: "priority", read: "priority" });
  await start(f.router, "codex/model", "priority"); assert.equal(f.last("thread/start").serviceTier, null);
  await f.router.request("thread/resume", { threadId: chat }); assert.equal(f.last("thread/resume").serviceTier, "priority");
});

test("Ultrafast and a tier a row names Fast are treated as Fast", async () => {
  const tiers = [{ id: "ultrafast", name: "Ultrafast", description: "" }, { id: "turbo", name: "Fast", description: "" }];
  const f = await fixture(undefined, tiers);
  const row = ((await f.router.request("model/list", {})).data as ObjectValue[]).find(entry => entry.model === "codex/model")!;
  assert.equal(row.defaultServiceTier, null); assert.deepEqual((row.serviceTiers as ObjectValue[]).map(tier => tier.id), ["ultrafast", "turbo"]);
  await modelWrite(f.router, "codex/model", "high"); await defaultWrite(f.router, "default");
  for (const tier of ["ultrafast", "turbo"]) await assert.rejects(defaultWrite(f.router, tier), refused, tier);
  assert.equal((await f.file()).service_tier, "default");
  const legacy = await fixture({ model: "codex/model", service_tier: "ultrafast" }, tiers);
  assert.equal(Object.hasOwn(object((await legacy.router.request("config/read", {})).config), "service_tier"), false);
  const native = await fixture(undefined, tiers);
  await modelWrite(native.router, "native", "high"); await defaultWrite(native.router, "default");
  const chat = id(await start(native.router, "codex/model", null)); await pick(native.router, chat, "ultrafast");
  await assert.rejects(defaultWrite(native.router, "ultrafast"), refused, "a chat pick of Ultrafast is not a default either");
  await defaultWrite(native.router, "ultrafast");
  await start(native.router, "codex/model", "turbo"); assert.equal(native.last("thread/start").serviceTier, null, "the saved Ultrafast is the desktop's default");
});

test("the adapter's own reset to Standard on a model switch is not taken as the user's speed pick", async () => {
  const f = await fixture();
  await modelWrite(f.router, "native", "high"); await defaultWrite(f.router, "default");
  const chat = await fastChat(f);
  await f.router.request("thread/settings/update", { threadId: chat, model: "claude/model" });
  assert.equal(f.last("thread/settings/update").serviceTier, null);
  await assert.rejects(defaultWrite(f.router, "priority"), refused);
  assert.equal((await f.file()).service_tier, "default");
});

test("a single write that names a gateway model and Fast is refused whole", async () => {
  const f = await fixture();
  await modelWrite(f.router, "native", "high"); await defaultWrite(f.router, "default");
  await assert.rejects(batch(f.router, ["model", "codex/model"], ["service_tier", "priority"]), refused);
  assert.deepEqual({ model: (await f.file()).model, ...(await savedTier(f)) }, { model: "native", file: "default", read: "default" });
});

test("speed telemetry names the kept and reset tiers and why", async () => {
  const f = await fixture(); const since = Date.now() - 1000;
  configureTelemetry(f.directory, "test");
  await modelWrite(f.router, "codex/model", "high"); await defaultWrite(f.router, "default");
  const chat = await fastChat(f);
  await assert.rejects(defaultWrite(f.router, "priority"), refused);
  await sharedTurn(f.router, chat, null); await reconnect(await f.connect(), chat, "default");
  await start(f.router, "claude/model", "priority");
  await modelWrite(f.router, "native", "high"); await defaultWrite(f.router, "priority");
  await start(f.router, "codex/model", "priority");
  await flushTelemetry();
  const events = (await readTelemetry(f.directory, since)).filter(event => String(event.event).startsWith("service_tier_"));
  assert.deepEqual(events.map(event => [event.event, event.requested ?? event.from, event.kept ?? event.reason, event.method]), [
    ["service_tier_kept", "default", "priority", "turn/start"], ["service_tier_kept", "default", "priority", "thread/resume"],
    ["service_tier_reset", "priority", "unoffered", "thread/start"], ["service_tier_reset", "priority", "shared_default", "thread/start"]]);
});
