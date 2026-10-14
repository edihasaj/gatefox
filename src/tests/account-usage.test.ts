import assert from "node:assert/strict";
import test from "node:test";
import { accountRequestReply, isAccountNotification, mergeAccountUsage, parseUsageSnapshot, relabelAccountLimits, sanitizeRateLimits, usageFileContent } from "../account-usage.js";
import { AccountEngines } from "../account-engines.js";

const native = {
  rateLimits: { usedPercent: 5, primary: { windowMinMins: 300 } }, accountId: "acct-native", planType: "pro",
  rateLimitsByLimitId: { codex: { limitId: "codex", limitName: "Codex", primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1 }, secondary: null, credits: null, planType: "pro", rateLimitReachedType: null } },
  credits: { hasCredits: false }, upsell: { type: "upgrade" }, permission: "allow",
};

test("rate limits relabel to account:<name>:<limitId> with the account label", () => {
  const rows = relabelAccountLimits("codex3", "Work Mac", sanitizeRateLimits({
    rateLimitsByLimitId: {
      codex: { limitId: "codex", limitName: "codex", primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1790000000 }, secondary: { usedPercent: 8, windowDurationMins: 10080 }, credits: { hasCredits: true, balance: "9.5" }, planType: "pro", rateLimitReachedType: "limit_reached", email: "hidden@secret.test" },
      pool: { limitId: "pool", limitName: "Shared pool", primary: { usedPercent: 90 } },
    },
  }));
  assert.deepEqual(Object.keys(rows).sort(), ["account:codex3:codex", "account:codex3:pool"]);
  const codex = rows["account:codex3:codex"];
  assert.equal(codex.limitName, "Work Mac"); // the plain codex meter shows only the account's label
  assert.deepEqual(codex.primary, { usedPercent: 42, windowDurationMins: 300, resetsAt: 1790000000 });
  assert.deepEqual(codex.secondary, { usedPercent: 8, windowDurationMins: 10080 });
  assert.equal(codex.credits, null); assert.equal(codex.planType, null); assert.equal(codex.rateLimitReachedType, null);
  assert.equal(rows["account:codex3:pool"].limitName, "Work Mac \u00b7 Shared pool");
  assert.ok(!JSON.stringify(rows).match(/secret|hasCredits|9\.5|pro|limit_reached/));
  assert.equal(sanitizeRateLimits({ rateLimitsByLimitId: { "bad id": { limitId: "bad id" }, ["x".repeat(80)]: { limitId: "x".repeat(80) } } }).length, 0);
});

test("merge adds account meters and never touches native fields, existing keys, or stale rows", () => {
  const now = 1_790_000_000;
  const merged = mergeAccountUsage(native, [
    { id: "codex", label: "Codex 2", observedAt: now - 60, limits: [{ limitId: "codex", limitName: "codex", primary: { usedPercent: 12 } }] },
    { id: "codex3", label: "Work Mac", observedAt: now - 120, limits: [{ limitId: "codex", limitName: "codex", primary: { usedPercent: 30, resetsAt: now } }, { limitId: "pool", limitName: "pool", primary: { usedPercent: 1 } }] },
    { id: "old", label: "Old", observedAt: now - 86401, limits: [{ limitId: "codex", limitName: "codex" }] },
    { id: "codex", label: "Codex 2", observedAt: now + 400, limits: [{ limitId: "future", limitName: "future" }] },
  ], now);
  const map = merged.rateLimitsByLimitId as Record<string, any>;
  assert.deepEqual(map.codex, native.rateLimitsByLimitId.codex); // native entry unchanged
  assert.equal(map["account:codex:codex"].primary.usedPercent, 12);
  assert.equal(map["account:codex3:codex"].limitName, "Work Mac");
  assert.ok(map["account:codex3:pool"]);
  assert.equal(Object.hasOwn(map, "account:old:codex"), false);
  assert.equal(Object.hasOwn(map, "account:codex:future"), false);
  assert.equal(merged.accountId, "acct-native"); assert.deepEqual(merged.rateLimits, native.rateLimits); assert.deepEqual(merged.upsell, native.upsell);
  assert.equal(mergeAccountUsage(native, [], now), native);
  const replaced = mergeAccountUsage({ ...native, rateLimitsByLimitId: { ...native.rateLimitsByLimitId, "account:codex:codex": { limitId: "codex", mine: true } } },
    [{ id: "codex", label: "Codex 2", observedAt: now, limits: [{ limitId: "codex", limitName: "codex", primary: { usedPercent: 99 } }] }], now);
  assert.equal((replaced.rateLimitsByLimitId as any)["account:codex:codex"].mine, true); // an existing key is never overwritten
});

test("account server requests get a local error; account notifications are flagged for the drop", () => {
  const request = { id: 17, method: "account/chatgptAuthTokens/refresh", params: { reason: "expired" } };
  const reply = accountRequestReply(request)!;
  assert.equal(reply.id, 17);
  assert.equal((reply.error as any).code, -32601);
  assert.match((reply.error as any).message, /handled by this account's own login/);
  assert.equal(accountRequestReply({ id: 18, method: "tool/approval/request", params: {} }), undefined);
  assert.equal(accountRequestReply({ method: "account/loggedOut" }), undefined); // a notification, not a request
  assert.equal(isAccountNotification({ method: "account/updated", params: {} }), true);
  assert.equal(isAccountNotification({ method: "account/login/completed", params: {} }), true);
  assert.equal(isAccountNotification({ method: "account/rateLimits/updated", params: {} }), true);
  assert.equal(isAccountNotification({ method: "thread/started", params: {} }), false);
});

test("persisted snapshots round-trip numbers only and reject malformed files", () => {
  const content = usageFileContent(sanitizeRateLimits({ rateLimitsByLimitId: { codex: { limitId: "codex", limitName: "codex", primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 5 }, planType: "pro", email: "a@b.test" } } }), 123);
  assert.deepEqual(content, { version: 1, observedAt: 123, limits: [{ limitId: "codex", primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 5 } }] });
  assert.deepEqual(parseUsageSnapshot(content)!.limits[0].limitId, "codex");
  assert.equal(parseUsageSnapshot({ version: 2, observedAt: 1, limits: [] }), undefined);
  assert.equal(parseUsageSnapshot({ version: 1, observedAt: "now", limits: [] }), undefined);
  assert.equal(parseUsageSnapshot({ version: 1, observedAt: 1, limits: [{ limitId: "bad id" }] }), undefined);
  assert.equal(parseUsageSnapshot("text"), undefined);
});

test("an engines merge shows both accounts next to account 1's untouched meter", async () => {
  const engines = new AccountEngines({ version: 1, port: 1, stateDirectory: "/tmp/unused-accounts", providers: [], maxConcurrent: 4, timeoutMs: 60000 },
    { codex: "/nonexistent", nativeHome: "/tmp/unused-native", baseArgs: [], nativeRequest: async () => ({}) });
  const snapshots = [
    { id: "codex", label: "Codex 2", observedAt: Math.floor(Date.now() / 1000), limits: sanitizeRateLimits({ rateLimitsByLimitId: { codex: { limitId: "codex", limitName: "codex", primary: { usedPercent: 10 } } } }) },
    { id: "codex3", label: "codex3", observedAt: Math.floor(Date.now() / 1000), limits: sanitizeRateLimits({ rateLimitsByLimitId: { codex: { limitId: "codex", limitName: "codex", primary: { usedPercent: 20 } } } }) },
  ];
  const merged = mergeAccountUsage(native, snapshots);
  assert.equal((merged.rateLimitsByLimitId as any)["account:codex:codex"].limitName, "Codex 2");
  assert.equal((merged.rateLimitsByLimitId as any)["account:codex3:codex"].limitName, "codex3");
  assert.equal((merged.rateLimitsByLimitId as any).codex.primary.usedPercent, 5); // account 1's own meter
  assert.equal(await engines.usage("absent"), undefined);
  await engines.stop();
});
