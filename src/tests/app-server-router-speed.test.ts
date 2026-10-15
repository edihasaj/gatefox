import test from "node:test";
import assert from "node:assert/strict";
import { ChatTierPicks, fastDefaultDecision, isSpeedTier, tierPickWindowMs } from "../speed-defaults.js";
import { defaultWrite, fixture, id, modelWrite, object, omitsTier, pick, reconnect, refused, savedTier, settled, start, turn, type ObjectValue } from "./speed-fixture.js";

test("S1 gateway rows never advertise a Fast default but stay selectable; native rows keep theirs", async () => {
  const f = await fixture();
  const rows = (await f.router.request("model/list", {})).data as ObjectValue[];
  const row = rows.find(entry => entry.model === "codex/model")!;
  assert.equal(row.defaultServiceTier, null);
  assert.deepEqual((row.serviceTiers as ObjectValue[]).map(tier => tier.id), ["priority"]);
  assert.equal(rows.find(entry => entry.model === "native")!.defaultServiceTier, "priority");
});

test("S2 a Fast pick inside a gateway chat stays with that chat, survives the desktop's resumes, and never becomes a default", async () => {
  const f = await fixture();
  await modelWrite(f.router, "codex/model", "high"); await defaultWrite(f.router, "default");
  const chat = id(await start(f.router, "codex/model", null, "high"));
  assert.equal(f.last("thread/start").serviceTier, null);
  await pick(f.router, chat, "priority"); assert.equal(f.last("thread/settings/update").serviceTier, "priority");
  await assert.rejects(defaultWrite(f.router, "priority"), refused);
  assert.deepEqual(await savedTier(f), { file: "default", read: "default" });
  await start(f.router, "codex/model", null); assert.equal(f.last("thread/start").serviceTier, null);
  await new Promise(done => setTimeout(done, 5));
  await f.router.observeNotification(settled(chat, "codex/model", "priority"));
  // After a restart the desktop resumes the open chat with its shared default speed, which is Standard here.
  const fresh = await f.connect();
  await reconnect(fresh, chat, null); assert.equal(f.last("thread/resume").serviceTier, "priority", "the reconnect resume keeps the chat's Fast");
  await fresh.request("thread/resume", { threadId: chat }); assert.equal(f.last("thread/resume").serviceTier, "priority", "and so does a later resume");
  await pick(fresh, chat, null); await defaultWrite(fresh, "default");
});

test("S3 a native default model keeps native behaviour, including the saved tier for clients that omit one", async () => {
  const f = await fixture();
  await modelWrite(f.router, "native", "high");
  const chat = id(await start(f.router, "native", null, "high"));
  await pick(f.router, chat, "priority"); await defaultWrite(f.router, "priority");
  assert.deepEqual(await savedTier(f), { file: "priority", read: "priority" });
  await f.router.request("thread/start", { model: "native" }); assert.equal(f.last("thread/start").serviceTier, "priority");
  await start(f.router, "native", null); assert.equal(f.last("thread/start").serviceTier, null);
});

test("S4 a Fast pick in a native chat is not saved while the default model is a gateway model", async () => {
  const f = await fixture();
  await modelWrite(f.router, "codex/model", "high"); await defaultWrite(f.router, "default");
  const chat = id(await start(f.router, "native", null)); await pick(f.router, chat, "priority");
  await assert.rejects(defaultWrite(f.router, "priority"), refused);
  assert.equal((await f.file()).service_tier, "default");
});

test("S5 a draft Fast pick is refused while the default model is a gateway model, so no later draft starts Fast", async () => {
  const f = await fixture();
  await modelWrite(f.router, "codex/model", "high"); await defaultWrite(f.router, "default");
  await assert.rejects(defaultWrite(f.router, "priority"), refused, "the desktop keeps Standard as its default");
  assert.deepEqual(await savedTier(f), { file: "default", read: "default" });
  await start(f.router, "codex/model", null); assert.equal(f.last("thread/start").serviceTier, null);
  // A pick kept with one draft (Recent models) names Fast on that start only, while the desktop's default stays Standard.
  await start(f.router, "codex/model", "priority"); assert.equal(f.last("thread/start").serviceTier, "priority");
});

test("S6 a legacy saved Fast tier is hidden only when the saved model is a gateway model", async () => {
  const gatewayFile = await fixture({ model: "codex/model", service_tier: "priority" });
  assert.equal(Object.hasOwn(object((await gatewayFile.router.request("config/read", {})).config), "service_tier"), false);
  const nativeFile = await fixture({ model: "native", service_tier: "priority" });
  assert.equal(object((await nativeFile.router.request("config/read", {})).config).service_tier, "priority");
});

test("S7 a tier the row does not offer becomes Standard on start and resume, and a turn keeps the chat's Standard", async () => {
  const f = await fixture();
  const chat = id(await start(f.router, "claude/model", "priority", "high"));
  assert.equal(f.last("thread/start").serviceTier, null);
  await turn(f.router, chat, "priority", "high"); assert.ok(omitsTier(f.last("turn/start")), "the engine keeps the chat's own Standard");
  await f.router.request("turn/start", { threadId: chat, input: [] }); // fails if the turn recorded Fast on a row without it
  await f.router.request("thread/resume", { threadId: chat }); assert.equal(f.last("thread/resume").serviceTier, null, "the turn did not record Fast");
  const prewarmed = id(await start(f.router, "claude/model", null, "high"));
  await turn(f.router, prewarmed, "priority", "high"); assert.ok(omitsTier(f.last("turn/start")));
  await reconnect(f.router, chat, "priority"); assert.equal(f.last("thread/resume").serviceTier, null);
  await assert.rejects(pick(f.router, chat, "priority"), /does not support/, "an explicit settings update still fails");
});

test("S8 reasoning defaults follow the desktop's own effort, the saved pair, then the row", async () => {
  const f = await fixture();
  await start(f.router, "codex/model", null, "low");
  assert.equal(object(f.last("thread/start").config).model_reasoning_effort, "low");
  assert.equal(object(f.last("thread/start").config).model_reasoning_summary, "auto");
  await start(f.router, "codex/model", null); assert.equal(object(f.last("thread/start").config).model_reasoning_effort, "high");
  await modelWrite(f.router, "codex/model", "xhigh");
  await start(f.router, "codex/model", null); assert.equal(object(f.last("thread/start").config).model_reasoning_effort, "xhigh");
  await modelWrite(f.router, "claude/model", "low");
  await start(f.router, "codex/model", null); assert.equal(object(f.last("thread/start").config).model_reasoning_effort, "high", "another model's saved pair does not apply");
});

test("S9 a saved Standard survives a model change", async () => {
  const f = await fixture();
  await modelWrite(f.router, "native", "high"); await defaultWrite(f.router, "default"); await modelWrite(f.router, "codex/model", "high");
  assert.deepEqual(await savedTier(f), { file: "default", read: "default" });
});

test("a saved Fast tier is dropped when the default model changes to a gateway model", async () => {
  const f = await fixture();
  await modelWrite(f.router, "native", "high"); await defaultWrite(f.router, "priority"); await modelWrite(f.router, "codex/model", "high");
  assert.equal(Object.hasOwn(await f.file(), "service_tier"), false);
});

test("a pick for a chat no SDK knows clears the remembered pick instead of refusing a later native default", async () => {
  const f = await fixture();
  await modelWrite(f.router, "native", "high"); await defaultWrite(f.router, "default");
  const chat = id(await start(f.router, "codex/model", null)); await pick(f.router, chat, "priority");
  await pick(f.router, "unknown-chat", "priority");
  await defaultWrite(f.router, "priority");
  assert.equal((await f.file()).service_tier, "priority");
});

test("any default speed write consumes the remembered pick, so a later native draft pick is not mistaken for it", async () => {
  const f = await fixture();
  await modelWrite(f.router, "native", "high"); await defaultWrite(f.router, "default");
  const chat = id(await start(f.router, "codex/model", null)); await pick(f.router, chat, "priority");
  await defaultWrite(f.router, "default");
  await defaultWrite(f.router, "priority");
  assert.equal((await f.file()).service_tier, "priority");
});

test("ChatTierPicks expires, consumes and replaces picks", () => {
  const picks = new ChatTierPicks();
  picks.record("gateway-chat", true, 1000);
  assert.equal(picks.take(1000 + tierPickWindowMs + 1), undefined, "an old pick expires");
  picks.record("gateway-chat", true, 1000);
  assert.equal(picks.take(1000 + tierPickWindowMs)?.fast, true); assert.equal(picks.take(1000), undefined, "take consumes the pick");
  picks.record("gateway-chat", true, 1000); picks.record("native-chat", false, 2000);
  assert.deepEqual(picks.take(2000), { source: "native-chat", fast: false, atMs: 2000 }, "a later record replaces the earlier one");
  picks.record("native-chat", true, 3000); picks.clear(); assert.equal(picks.take(3000), undefined);
});

test("Fast and Ultrafast are recognised by id or by the name a row gives them, and refused as gateway defaults", () => {
  for (const tier of ["priority", "fast", "ultrafast"]) assert.equal(isSpeedTier(tier), true, tier);
  for (const tier of ["default", "flex", null, undefined, 3]) assert.equal(isSpeedTier(tier), false, String(tier));
  assert.equal(isSpeedTier("turbo", [{ id: "turbo", name: " Fast " }]), true);
  assert.equal(isSpeedTier("turbo", [{ id: "turbo", name: "Turbo" }]), false);
  assert.equal(fastDefaultDecision(undefined, true), "reject");
  assert.equal(fastDefaultDecision({ source: "gateway-chat", fast: true, atMs: 0 }, false), "reject");
  assert.equal(fastDefaultDecision({ source: "native-chat", fast: true, atMs: 0 }, false), "save");
  assert.equal(fastDefaultDecision(undefined, false), "save");
});
