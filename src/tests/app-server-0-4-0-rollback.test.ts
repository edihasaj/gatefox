import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import { modelCatalog } from "../catalog.js";
import type { GatewayConfig } from "../config.js";
import { Build040, OldRoutingError } from "./app-server-0-4-0-tier-check.js";
import { oldBuildAccepts } from "./thread-tier-0-4-0-parser.js";
import { ThreadServiceTiers } from "../thread-service-tiers.js";

type ObjectValue = Record<string, unknown>;
const gateway = "subscription_gateway";
const codex = "codex/model"; const claude = "claude/model";
let clock = Date.now();

/**
 * Rollback and mixed-version safety: 0.4.0 adapters keep running beside this build on the same state files, and a
 * rollback leaves them in charge. 0.4.0 refuses (-32002) a saved tier its row does not declare, so every row and saved
 * default this build writes is run through the 0.4.0 checks copied verbatim into app-server-0-4-0-tier-check.ts.
 * The backend models the SDK: a session start keeps a tier the model lacks only for Flex, and a running chat keeps any tier.
 */
async function fixture() {
  const state = await mkdtemp(join(tmpdir(), "gateway-rollback-"));
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory: state, providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { [claude]: "model" }, modelMetadata: { [claude]: { reasoningEfforts: ["low", "high"] } } },
    { id: "codex", type: "codex-subscription", label: "Codex", credentialFile: "unused", models: { [codex]: "model" },
      modelMetadata: { [codex]: { serviceTiers: [{ id: "priority", name: "Fast", description: "Priority routing" }] } } },
  ] };
  const sdk = { model: codex, tier: null as string | null, loaded: false };
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    if (method === "model/list") return { data: [], nextCursor: null };
    if (method === "config/read") return { config: { model: "native", model_provider: "openai" }, origins: {}, layers: null };
    if (method === "thread/read") return { thread: { id: "t", modelProvider: gateway, model: sdk.model } };
    if (["thread/start", "thread/resume", "thread/fork"].includes(method)) {
      // A loaded chat ignores a session-start override and answers with the tier it kept.
      if (!sdk.loaded) sdk.model = String(params.model ?? sdk.model);
      if (!sdk.loaded && Object.hasOwn(params, "serviceTier")) sdk.tier = params.serviceTier as string | null;
      return { thread: { id: "t" }, modelProvider: params.modelProvider ?? gateway, model: sdk.model, serviceTier: sdk.tier };
    }
    return { status: "applied" };
  };
  const nativeHome = join(state, "native-home");
  const router = new AppServerRouter(config, backend, undefined, undefined, nativeHome);
  await router.initialize();
  const announce = () => router.observeNotification({ emittedAtMs: clock = Math.max(clock + 1, Date.now()), method: "thread/settings/updated",
    params: { threadId: "t", threadSettings: { modelProvider: gateway, model: sdk.model, serviceTier: sdk.tier } } });
  const old = new Build040(modelCatalog(config).models);
  const rows = async () => oldBuildAccepts(JSON.parse(await readFile(join(state, (await readdir(state)).find(name => name.startsWith("desktop-thread-tiers-"))!), "utf8")));
  /** What a 0.4.0 adapter does with the saved chat: resume it, fork it, run a turn and ask for a settings change. */
  const old040Opens = async () => {
    const row = (await rows())["t"];
    assert.ok(row, "this build left a row for the chat");
    const route = { provider: gateway, model: row.model, serviceTier: row.serviceTier };
    for (const method of ["thread/resume", "thread/fork", "turn/start", "thread/settings/update", "turn/settings/update"]) {
      for (const params of [{ threadId: "t" }, { threadId: "t", model: row.model }]) {
        assert.doesNotThrow(() => old.routedTierCheck(method, params, route), `${method} on ${JSON.stringify(row)}`);
      }
    }
    return row;
  };
  /**
   * A fresh 0.4.0 process after a rollback: it reads the saved row, or finds none and has no tier for the chat (the route
   * carries serviceTier undefined). It then forks the chat, runs a turn on another model and asks for a settings change.
   */
  const old040Fresh = async () => {
    const row = (await rows())["t"];
    const route = { provider: gateway, model: row?.model ?? sdk.model, serviceTier: row?.serviceTier };
    const checks: Array<[string, ObjectValue]> = [["thread/fork", { threadId: "t" }], ["thread/resume", { threadId: "t" }],
      ["turn/start", { threadId: "t", model: claude }], ["thread/settings/update", { threadId: "t", model: claude }], ["turn/settings/update", { threadId: "t", model: claude }]];
    for (const [method, params] of checks) assert.doesNotThrow(() => old.routedTierCheck(method, params, route), `${method} ${JSON.stringify(params)} on ${JSON.stringify(row)}`);
    return row;
  };
  return { router, sdk, announce, old, rows, old040Opens, old040Fresh, state, tiers: new ThreadServiceTiers(state, nativeHome) };
}

test("the 0.4.0 check really refuses a saved tier its row does not declare", async () => {
  const f = await fixture();
  for (const [model, tier] of [[claude, "priority"], [codex, "flex"], [claude, "flex"]] as const) {
    for (const method of ["thread/resume", "thread/fork", "turn/start"]) {
      assert.throws(() => f.old.routedTierCheck(method, { threadId: "t" }, { provider: gateway, model, serviceTier: tier }),
        (error: unknown) => error instanceof OldRoutingError && error.code === -32002, `${method} ${model} ${tier}`);
    }
  }
  assert.doesNotThrow(() => f.old.routedTierCheck("thread/resume", { threadId: "t" }, { provider: gateway, model: codex, serviceTier: "priority" }));
});

test("a Flex chat leaves a row that 0.4.0 can resume and run turns on", async () => {
  for (const model of [codex, claude]) {
    // Flex requested at session start; the SDK keeps it on any row.
    const started = await fixture();
    await started.router.request("thread/start", { model, serviceTier: "flex" });
    assert.equal(started.sdk.tier, "flex");
    assert.equal((await started.old040Opens()).serviceTier, null, `${model} start`);
    // Flex chosen inside the chat and announced by the SDK.
    const chosen = await fixture();
    await chosen.router.request("thread/start", { model });
    await chosen.router.request("thread/settings/update", { threadId: "t", serviceTier: "flex" });
    chosen.sdk.tier = "flex"; await chosen.announce();
    assert.equal((await chosen.old040Opens()).serviceTier, null, `${model} settings`);
    // A fresh connection reads the same safe row and starts Standard.
    assert.equal((await chosen.rows())["t"].serviceTier, null);
  }
});

test("a Fast chat switched to a row without Fast leaves a row that 0.4.0 can resume and run turns on", async () => {
  const f = await fixture();
  await f.router.request("thread/start", { model: codex, serviceTier: "priority" });
  assert.equal((await f.old040Opens()).serviceTier, "priority", "a Fast row on a Fast chat is still recorded as Fast");
  // The picker moves the chat to Claude; the SDK keeps the chosen Fast tier and announces it with the new model.
  await f.router.request("thread/settings/update", { threadId: "t", model: claude });
  f.sdk.model = claude; await f.announce();
  const row = await f.old040Opens();
  assert.deepEqual({ model: row.model, serviceTier: row.serviceTier }, { model: claude, serviceTier: null });
  // Back on the Fast row, the SDK's Fast is recorded again.
  await f.router.request("thread/settings/update", { threadId: "t", model: codex });
  f.sdk.model = codex; await f.announce();
  assert.equal((await f.old040Opens()).serviceTier, "priority");
});

test("a loaded resume that answers a tier the row lacks records Standard for 0.4.0", async () => {
  const f = await fixture();
  await f.router.request("thread/start", { model: claude });
  f.sdk.tier = "priority"; f.sdk.loaded = true;
  await f.router.request("thread/resume", { threadId: "t" });
  assert.equal((await f.old040Opens()).serviceTier, null);
});

test("a saved new-chat default is saved only when 0.4.0 accepts it for the selected row", async () => {
  const f = await fixture();
  const save = (model: string, tier: string | null) => f.router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: model, mergeStrategy: "upsert" }, { keyPath: "service_tier", value: tier, mergeStrategy: "upsert" }] });
  const refused = (error: unknown) => (error as { code?: number }).code === -32002;
  await assert.rejects(save(codex, "flex"), refused);
  await assert.rejects(save(claude, "flex"), refused);
  await assert.rejects(save(claude, "priority"), refused);
  assert.throws(() => f.old.assertSavedDefault(claude, "flex"), (error: unknown) => refused(error));
  for (const [model, tier] of [[codex, "priority"], [codex, null], [claude, null]] as const) {
    await save(model, tier);
    const saved = JSON.parse(await readFile(join(f.state, "desktop-preferences.json"), "utf8")) as ObjectValue;
    assert.equal(saved.service_tier, tier);
    assert.doesNotThrow(() => f.old.assertSavedDefault(String(saved.model), saved.service_tier), `${model} ${String(tier)}`);
  }
  // The refused writes changed nothing: the last accepted default is still the file's.
  await assert.rejects(save(codex, "flex"), refused);
  assert.equal((JSON.parse(await readFile(join(f.state, "desktop-preferences.json"), "utf8")) as ObjectValue).service_tier, null);
});

test("a chat on a tier the store cannot hold rolls back to a Standard row that a fresh 0.4.0 process accepts", async () => {
  for (const tier of ["auto", "Fast"]) {
    const f = await fixture();
    await f.router.request("thread/start", { model: codex });
    f.sdk.tier = tier; await f.announce();
    // 0.4.1 still reads the chat as unknown, so it forwards no tier and never invents one.
    assert.equal(await f.tiers.read("t"), undefined, `${tier} stays unknown`);
    const row = await f.old040Fresh();
    assert.ok(row, `${tier}: a row stays under the chat id for 0.4.0`);
    assert.deepEqual({ model: row.model, serviceTier: row.serviceTier }, { model: codex, serviceTier: null }, tier);
    await f.old040Opens();
  }
});
