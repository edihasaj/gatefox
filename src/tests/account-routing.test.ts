import assert from "node:assert/strict";
import test from "node:test";
import { accountEngineArgs } from "../account-engines.js";
import { accountAlias, accountModelRows, accountProviderId, accountIdFromProvider, familyCheck, isAccountProvider, presentNotification, presentResult, resolveUpstream, routeNewChat, routeThread, splitAccountAlias, toAccountAlias, toUpstream, unavailableMessage, type AccountRoute, type RouteContext } from "../account-routing.js";

const routes = (entries: Array<[string, Partial<AccountRoute>]>): RouteContext => ({
  gatewayProvider: "harness_gateway",
  aliases: new Set(["codex/gpt-6.1-sol", "claude/sonnet-5.5", "base/m"]),
  accounts: new Map(entries.map(([id, extra]) => [id, { id, status: "ready", slugs: new Set(["gpt-6.1-sol"]), ...extra }] as [string, AccountRoute])),
});

test("provider ids and aliases round-trip for named accounts", () => {
  assert.equal(accountProviderId("codex"), "account_codex");
  assert.equal(accountProviderId("codex3"), "account_codex3");
  assert.equal(accountIdFromProvider("account_codex3"), "codex3");
  assert.equal(isAccountProvider("account_codex3"), true);
  assert.equal(isAccountProvider("harness_gateway"), false);
  assert.equal(splitAccountAlias("codex3/gpt-6.1-sol")!.upstream, "gpt-6.1-sol");
  assert.deepEqual(splitAccountAlias("base/m", ["codex3"]), undefined); // another provider's alias, not an account
  assert.equal(accountAlias("codex", "gpt-6.1-terra"), "codex/gpt-6.1-terra");
  assert.match(unavailableMessage("codex", "identity_mismatch"), /logout codex and gateway account login codex/);
  assert.match(unavailableMessage("codex3", "not_logged_in"), /gateway account login codex3 on this Mac/);
  assert.match(unavailableMessage("codex3", "busy_elsewhere"), /in use by another connection on this Mac/);
});

test("alias translation to upstream and back per account", () => {
  const context = routes([["codex3", {}]]);
  const account = context.accounts.get("codex3")!;
  assert.equal(resolveUpstream("codex3/gpt-6.1-sol", account, context), "gpt-6.1-sol");
  assert.equal(resolveUpstream("gpt-6.1-sol", account, context), "gpt-6.1-sol");
  assert.equal(resolveUpstream("codex/gpt-6.1-sol", account, context), "gpt-6.1-sol"); // a shared name also targets this account's slugs
  assert.equal(resolveUpstream("claude/sonnet-5.5", account, context), undefined);
  assert.equal(toAccountAlias("gpt-6.1-sol", account), "codex3/gpt-6.1-sol");
  assert.equal(toAccountAlias("unknown-model", account), undefined);
  const request = toUpstream({ model: "codex3/gpt-6.1-sol", collaborationMode: { settings: { model: "codex3/gpt-6.1-sol" } }, config: { model: "codex3/gpt-6.1-sol", model_catalog_json: "/x.json", keep: 1 } }, account, context);
  assert.equal(request.model, "gpt-6.1-sol");
  assert.equal((request.collaborationMode as any).settings.model, "gpt-6.1-sol");
  assert.equal((request.config as any).model, "gpt-6.1-sol");
  assert.equal((request.config as any).model_catalog_json, undefined);
  assert.equal((request.config as any).keep, 1);
  const args = accountEngineArgs(["app-server"], "codex3", undefined).join(" ");
  assert.ok(args.includes('model_provider="account_codex3"') && !args.includes("http_headers.version"));
});

test("presentResult and presentNotification map account threads back to aliases", () => {
  const context = routes([["codex", {}], ["codex3", { slugs: new Set(["gpt-6.1-sol", "gpt-6.1-terra"]) }]]);
  const started = presentResult("thread/start", { model: "gpt-6.1-terra", modelProvider: "account_codex3", thread: { id: "t", model: "gpt-6.1-terra", modelProvider: "account_codex3" } }, context.accounts);
  assert.equal(started.model, "codex3/gpt-6.1-terra");
  assert.equal((started.thread as any).model, "codex3/gpt-6.1-terra");
  const read = presentResult("thread/read", { thread: { id: "t", model: "gpt-6.1-sol", modelProvider: "account_codex" } }, context.accounts);
  assert.equal((read.thread as any).model, "codex/gpt-6.1-sol");
  const listed = presentResult("thread/list", { data: [{ id: "a", model: "gpt-6.1-sol", provider: "account_codex3" }, { id: "b", model: "gpt-6.1-sol", provider: null }] }, context.accounts);
  assert.equal((listed.data as any[])[0].model, "codex3/gpt-6.1-sol");
  assert.equal((listed.data as any[])[1].model, "gpt-6.1-sol"); // a native row is untouched
  assert.deepEqual(presentResult("model/list", { data: [{ model: "gpt-6.1-sol" }] }, context.accounts), { data: [{ model: "gpt-6.1-sol" }] });
  const notification = presentNotification({ method: "thread/started", params: { thread: { id: "t", model: "gpt-6.1-terra", modelProvider: "account_codex3" } } }, context.accounts);
  assert.equal(((notification.params as any).thread).model, "codex3/gpt-6.1-terra");
  const settings = presentNotification({ method: "thread/settings/updated", params: { threadId: "t", threadSettings: { model: "gpt-6.1-terra", modelProvider: "account_codex3" } } }, context.accounts);
  assert.equal(((settings.params as any).threadSettings).model, "codex3/gpt-6.1-terra");
  assert.equal(presentNotification({ method: "turn/started", params: { threadId: "t", model: "gpt-6.1-terra" } }, context.accounts).method, "turn/started");
});

test("picker rows keep capabilities and carry the account label", () => {
  const rows = accountModelRows([{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", supportedReasoningEfforts: [{ reasoningEffort: "ultra" }], serviceTiers: [{ id: "priority" }], defaultServiceTier: "priority", additionalSpeedTiers: ["fast"], multiAgentVersion: "v2", inputModalities: ["text", "image"], upgrade: { model: "x" }, isDefault: true, auth: "no" }], "codex3", "Work Mac");
  assert.equal(rows[0].id, "codex3/gpt-6.1-sol"); assert.equal(rows[0].model, "codex3/gpt-6.1-sol");
  assert.equal(rows[0].displayName, "Work Mac \u00b7 GPT-6.1 Sol");
  assert.equal(rows[0].isDefault, false); assert.equal(rows[0].upgrade, null);
  assert.deepEqual(rows[0].supportedReasoningEfforts, [{ reasoningEffort: "ultra" }]);
  assert.equal(rows[0].multiAgentVersion, "v2"); assert.deepEqual(rows[0].inputModalities, ["text", "image"]);
});

test("family rules: an account thread stays on its account; mixed gateway chats keep working", () => {
  const context = routes([["codex", {}], ["codex3", { slugs: new Set(["gpt-6.1-sol", "gpt-6.1-terra"]) }]]);
  familyCheck("account_codex3", "codex3/gpt-6.1-terra", context);
  familyCheck("account_codex3", "gpt-6.1-terra", context);
  familyCheck("account_codex3", undefined, context);
  assert.throws(() => familyCheck("account_codex3", "claude/sonnet-5.5", context), (error: any) => error.code === -32002);
  assert.throws(() => familyCheck("account_codex3", "codex/gpt-6.1-sol", context), (error: any) => error.code === -32002); // another account's name
  familyCheck("harness_gateway", "codex/gpt-6.1-sol", context); // today's mixed chats keep the HTTP route
  familyCheck("harness_gateway", "claude/sonnet-5.5", context);
  assert.throws(() => familyCheck("harness_gateway", "codex3/gpt-6.1-terra", context), (error: any) => error.code === -32002);
  assert.throws(() => familyCheck("native", "codex3/gpt-6.1-terra", context), (error: any) => error.code === -32002);
  assert.throws(() => familyCheck("native", "codex/gpt-6.1-sol", context), (error: any) => error.code === -32002);
  familyCheck(undefined, "native-model", context);
  assert.throws(() => familyCheck("account_codex", "gpt-6.1-terra", routes([["codex", {}], ["codex3", { slugs: new Set(["gpt-6.1-terra"]) }]])), (error: any) => error.code === -32002);
});

test("new chats use the engine when it can serve, fall back to HTTP on a shared name, and never fall back for account-only names", async () => {
  assert.deepEqual(routeNewChat("codex/gpt-6.1-sol", routes([["codex", { status: "ready" }]])), { route: "account", id: "codex", wait: false });
  assert.deepEqual(routeNewChat("codex/gpt-6.1-sol", routes([["codex", { status: "starting" }]])), { route: "account", id: "codex", wait: true });
  assert.deepEqual(routeNewChat("codex/gpt-6.1-sol", routes([["codex", { status: "idle" }]])), { route: "account", id: "codex", wait: true });
  assert.deepEqual(routeNewChat("codex/gpt-6.1-sol", routes([["codex", { status: "not_logged_in" }]])), { route: "http", reason: "not_logged_in" });
  assert.deepEqual(routeNewChat("codex/gpt-6.1-sol", routes([["codex", { status: "busy_elsewhere" }]])), { route: "http", reason: "busy_elsewhere" });
  assert.deepEqual(routeNewChat("codex/gpt-6.1-sol", routes([["codex", { status: "not_configured" }]])), { route: "http", reason: "not_configured" });
  const refused = routeNewChat("codex3/gpt-6.1-terra", routes([["codex3", { status: "not_logged_in" }]]))!;
  assert.equal(refused.route, "refuse");
  assert.match((refused as any).message, /gateway account login codex3 on this Mac/);
  assert.equal(routeNewChat("claude/sonnet-5.5", routes([["codex3", {}]])), undefined);
  assert.equal(routeNewChat("native-model", routes([["codex3", {}]])), undefined);
  assert.deepEqual(routeNewChat("gpt-6.1-terra", routes([["codex3", { slugs: new Set(["gpt-6.1-terra"]) }]])), { route: "account", id: "codex3", wait: false });
  assert.equal(routeNewChat("gpt-6.1-terra", routes([["codex3", { slugs: new Set(["gpt-6.1-terra"]) }], ["codex", { slugs: new Set(["gpt-6.1-terra"]) }]])), undefined); // ambiguous
  assert.equal(routeThread("account_codex3")!.id, "codex3");
  assert.equal(routeThread("harness_gateway"), undefined);
});
