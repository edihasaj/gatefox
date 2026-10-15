import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { batch, defaultWrite, fixture, id, modelWrite, object, pick, refused, savedTier, start, turn } from "./speed-fixture.js";

const configTier = async (router: AppServerRouter) => object((await router.request("config/read", {})).config).service_tier;

test("a native-to-native model change keeps the saved speed, Fast or Standard", async () => {
  for (const tier of ["priority", "default"]) {
    const f = await fixture();
    await modelWrite(f.router, "native", "high"); await defaultWrite(f.router, tier);
    await batch(f.router, ["model", "native-two"]);
    assert.deepEqual(await savedTier(f), { file: tier, read: tier });
    await f.router.request("thread/start", { model: "native-two" });
    assert.equal(f.last("thread/start").serviceTier, tier, "the saved speed still reaches a client that sends none");
  }
});

test("a saved Fast hidden behind a gateway model does not come back when the default moves to a native model", async () => {
  const f = await fixture({ model: "codex/model", service_tier: "priority" });
  assert.equal(await configTier(f.router), undefined);
  await modelWrite(f.router, "native", "high");
  assert.equal(Object.hasOwn(await f.file(), "service_tier"), false);
  assert.equal(await configTier(f.router), undefined);
});

test("a Fast pick in a gateway chat is refused as a default even when the default model is native", async () => {
  const f = await fixture();
  await modelWrite(f.router, "native", "high"); await defaultWrite(f.router, "default");
  const chat = id(await start(f.router, "codex/model", null)); await pick(f.router, chat, "priority");
  await assert.rejects(defaultWrite(f.router, "priority"), refused);
  assert.deepEqual(await savedTier(f), { file: "default", read: "default" });
});

test("a Fast default accepted for a gateway model keeps a previous Standard, even when the same write changes the model", async () => {
  const f = await fixture();
  await modelWrite(f.router, "native", "high"); await defaultWrite(f.router, "default");
  await batch(f.router, ["model", "codex/model"], ["service_tier", "priority"]);
  assert.deepEqual(await savedTier(f), { file: "default", read: "default" });
  assert.equal((await f.file()).model, "codex/model");
});

test("a Fast default accepted for a gateway model never keeps a previous Fast or invents a saved tier", async () => {
  const legacy = await fixture({ model: "codex/model", service_tier: "priority" });
  await defaultWrite(legacy.router, "priority");
  assert.equal(Object.hasOwn(await legacy.file(), "service_tier"), false);
  const fresh = await fixture();
  await modelWrite(fresh.router, "codex/model", "high"); await defaultWrite(fresh.router, "priority");
  assert.equal(Object.hasOwn(await fresh.file(), "service_tier"), false);
});

test("config/read hides a Fast tier from the native config while the default model is a gateway model", async () => {
  const f = await fixture();
  f.native.config = { model: "native", service_tier: "fast" };
  assert.equal(await configTier(f.router), "fast", "a native default keeps native behaviour");
  await modelWrite(f.router, "codex/model", "high");
  assert.equal(await configTier(f.router), undefined, "the saved gateway default hides the native Fast");
  const other = await fixture(); other.native.config = { model: "codex/model", service_tier: "priority" };
  assert.equal(await configTier(other.router), undefined, "so does a gateway default that comes from the native file");
  await defaultWrite(f.router, "default");
  assert.equal(await configTier(f.router), "default", "a saved Standard is shown");
});

test("config/read treats a model the desktop catalog does not call native as a gateway model", async () => {
  const f = await fixture({ model: "codex/gone", service_tier: "priority" });
  assert.equal(await configTier(f.router), "priority", "without a catalog an unknown model is not a gateway alias");
  const source = new DesktopCatalog(f.config, [{ slug: "native" }] as never, join(f.directory, "catalog.json"));
  const router = new AppServerRouter(f.config, f.backend, undefined, source, join(f.directory, "native-home")); await router.initialize();
  assert.equal(await configTier(router), undefined);
});

test("one write cannot carry two values for the same setting", async () => {
  const f = await fixture();
  await modelWrite(f.router, "native", "high"); await defaultWrite(f.router, "default");
  await assert.rejects(batch(f.router, ["model", "codex/model"], ["service_tier", "default"], ["service_tier", "priority"]), /one value/);
  await assert.rejects(batch(f.router, ["model", "native"], ["model", "codex/model"]), /one value/);
  assert.deepEqual(await savedTier(f), { file: "default", read: "default" });
  assert.equal((await f.file()).model, "native");
});

test("an unoffered tier named by a fork or in start config becomes Standard", async () => {
  const f = await fixture();
  const chat = id(await start(f.router, "claude/model", null, "high"));
  await f.router.request("thread/fork", { threadId: chat, serviceTier: "priority" });
  assert.equal(f.last("thread/fork").serviceTier, null);
  await f.router.request("thread/start", { model: "claude/model", config: { service_tier: "priority", trusted: true } });
  const forwarded = f.last("thread/start");
  assert.equal(forwarded.serviceTier, null);
  assert.equal(Object.hasOwn(object(forwarded.config), "service_tier"), false);
  assert.equal(object(forwarded.config).trusted, true);
});

test("a turn keeps its one-turn Fast while its unoffered chat tier becomes Standard, and records Standard", async () => {
  const f = await fixture();
  const chat = id(await start(f.router, "codex/model", null, "high"));
  await f.router.request("turn/start", { threadId: chat, serviceTier: "flex", serviceTierForTurn: "fast", input: [] });
  assert.equal(f.last("turn/start").serviceTier, null);
  assert.equal(f.last("turn/start").serviceTierForTurn, "priority");
  await f.router.request("turn/start", { threadId: chat, input: [] }); // fails if the turn recorded the unoffered tier
});

test("a chat whose row stopped offering its tier still resumes and forks, as Standard", async () => {
  const f = await fixture();
  const chat = id(await start(f.router, "codex/model", "priority", "high"));
  await f.router.observeNotification({ method: "thread/settings/updated", emittedAtMs: Date.now(), params: { threadId: chat, threadSettings: { model: "codex/model", modelProvider: "subscription_gateway", serviceTier: "priority" } } });
  const metadata = f.config.providers[1].modelMetadata!["codex/model"]; delete metadata.serviceTiers; delete metadata.defaultServiceTier;
  const fresh = await f.connect();
  await assert.rejects(fresh.request("thread/resume", { threadId: chat, model: "claude/model" }), /does not support/, "a model switch from a stale peer still fails");
  await fresh.request("thread/resume", { threadId: chat }); assert.equal(f.last("thread/resume").serviceTier, null);
  await fresh.request("thread/fork", { threadId: chat }); assert.equal(f.last("thread/fork").serviceTier, null);
});

test("a saved native Fast default is not detected for gateway starts; an explicit Fast reaches the chat as sent", async () => {
  const f = await fixture({ model: "native", service_tier: "priority" });
  assert.equal(await configTier(f.router), "priority");
  await start(f.router, "codex/model", "priority"); assert.equal(f.last("thread/start").serviceTier, "priority");
  await start(f.router, "codex/model", null); assert.equal(f.last("thread/start").serviceTier, null);
});

test("service_tier_reset names only known tiers", async () => {
  const f = await fixture(); const since = Date.now() - 1000;
  configureTelemetry(f.directory, "test");
  await start(f.router, "claude/model", "priority"); await start(f.router, "claude/model", "caller-supplied-id");
  const chat = id(await start(f.router, "claude/model", null));
  await turn(f.router, chat, "priority", "high");
  await flushTelemetry();
  const events = (await readTelemetry(f.directory, since)).filter(event => event.event === "service_tier_reset");
  assert.deepEqual(events.map(event => [event.from, event.model, event.method]), [
    ["priority", "claude/model", "thread/start"], ["other", "claude/model", "thread/start"], ["priority", "claude/model", "turn/start"]]);
});
