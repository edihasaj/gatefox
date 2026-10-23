import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, utimes, writeFile, readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayToken, writePrivateJson, type GatewayConfig, type ProviderConfig } from "../config.js";
import { codexUsage, codexUsageFromEvent, codexUsageFromHeaders, credentialRevision, observeCodexUsage, type CodexUsage, type CodexUsageObserver } from "../providers/codex-usage.js";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ProviderError } from "../providers/provider.js";
import { ProviderUsageStore, gatewayUsage, isCodexUsage, mergeGatewayUsage, type CodexProviderUsage } from "../provider-usage.js";
import { AppServerRouter } from "../app-server-router.js";
import { startGateway } from "../server.js";

const now = Math.floor(Date.now() / 1000);
const primary = { usedPercent: 42.5, windowMinutes: 300, resetsAt: now + 3600 };
const secondary = { usedPercent: 7, windowMinutes: 10080, resetsAt: now + 86400 };
const wire = (extra: Record<string, string> = {}) => ({
  "x-codex-primary-used-percent": "42.5", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": String(primary.resetsAt),
  "x-codex-secondary-used-percent": "7", "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-reset-at": String(secondary.resetsAt), ...extra,
});
const eventWindow = (window: typeof primary) => ({ used_percent: window.usedPercent, window_minutes: window.windowMinutes, reset_at: window.resetsAt });
const rateEvent = (extra: Record<string, unknown> = {}) => ({ type: "codex.rate_limits", rate_limits: { primary: eventWindow(primary), secondary: eventWindow(secondary) }, ...extra });

test("default numeric headers parse to exact counters and nothing else is inferred", () => {
  assert.deepEqual(codexUsageFromHeaders(new Headers(wire())), { kind: "codex", primary, secondary });
  const only = (name: string) => Object.fromEntries(Object.entries(wire()).filter(([key]) => key.includes(name)));
  assert.deepEqual(codexUsageFromHeaders(new Headers(only("secondary"))), { kind: "codex", secondary });
  assert.equal(codexUsageFromHeaders(new Headers()), undefined, "a backend that sends no quota headers yields no observation");
  // A window with a missing or malformed field is dropped whole: no minutes, reset time or percentage is guessed.
  for (const name of ["primary-used-percent", "primary-window-minutes", "primary-reset-at"]) {
    const headers = wire(); delete (headers as Record<string, string>)[`x-codex-${name}`];
    assert.deepEqual(codexUsageFromHeaders(new Headers(headers)), { kind: "codex", secondary }, name);
  }
  const bad: Array<[string, string]> = [["used-percent", "+5"], ["used-percent", "-1"], ["used-percent", "1e1"], ["used-percent", "100.5"], ["used-percent", "101"],
    ["used-percent", "NaN"], ["used-percent", "Infinity"], ["used-percent", "0x10"], ["used-percent", ""], ["used-percent", "true"], ["used-percent", "5, 6"],
    ["window-minutes", "0"], ["window-minutes", "-5"], ["window-minutes", "1.5"], ["window-minutes", "1e3"], ["window-minutes", "99999999"],
    ["reset-at", "0"], ["reset-at", "999999999"], ["reset-at", "4102444801"], ["reset-at", "17.5"], ["reset-at", String(now) + "0"]];
  for (const [field, value] of bad) assert.deepEqual(codexUsageFromHeaders(new Headers(wire({ [`x-codex-primary-${field}`]: value }))), { kind: "codex", secondary }, `${field}=${JSON.stringify(value)}`);
  assert.equal(codexUsageFromHeaders(new Headers(wire({ "x-codex-primary-used-percent": "0", "x-codex-secondary-used-percent": "100" })))?.primary?.usedPercent, 0);
  // Fetch's Headers trims surrounding whitespace before any parser sees it, so " 5 " arrives as "5" and is valid.
  assert.equal(codexUsageFromHeaders(new Headers(wire({ "x-codex-primary-used-percent": " 5 " })))?.primary?.usedPercent, 5);
  // Other metered families are not the default family.
  assert.equal(codexUsageFromHeaders(new Headers({ "x-codex-other-primary-used-percent": "5", "x-codex-other-primary-window-minutes": "300", "x-codex-other-primary-reset-at": String(now + 60) })), undefined);
});

test("the parser itself accepts only plain decimal text when it is handed raw strings", () => {
  const raw = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null }) as unknown as Headers;
  const base = wire() as Record<string, string>;
  assert.deepEqual(codexUsageFromHeaders(raw(base)), { kind: "codex", primary, secondary });
  for (const [name, value] of [["used-percent", " 5"], ["used-percent", "5 "], ["window-minutes", " 300"], ["reset-at", " " + primary.resetsAt], ["reset-at", primary.resetsAt + " "], ["used-percent", "5\n"]])
    assert.deepEqual(codexUsageFromHeaders(raw({ ...base, [`x-codex-primary-${name}`]: value })), { kind: "codex", secondary }, `${name}=${JSON.stringify(value)}`);
});

test("rate-limit events parse only for the default family and only with valid numbers", () => {
  assert.deepEqual(codexUsageFromEvent(rateEvent()), { kind: "codex", primary, secondary });
  assert.deepEqual(codexUsageFromEvent(rateEvent({ metered_limit_name: "codex", limit_name: null })), { kind: "codex", primary, secondary });
  assert.deepEqual(codexUsageFromEvent({ ...rateEvent(), credits: { has_credits: true, unlimited: false, balance: "9" }, plan_type: "plus" }), { kind: "codex", primary, secondary });
  for (const named of [{ metered_limit_name: "codex_other" }, { limit_name: "codex_other" }, { metered_limit_name: "codex", limit_name: "other" }, { metered_limit_name: 5 }, { limit_name: true }, { metered_limit_name: "" }])
    assert.equal(codexUsageFromEvent(rateEvent(named)), undefined, JSON.stringify(named));
  assert.equal(codexUsageFromEvent({ ...rateEvent(), type: "response.completed" }), undefined);
  for (const bad of [null, [], "text", 3, {}, { type: "codex.rate_limits" }, { type: "codex.rate_limits", rate_limits: null }, { type: "codex.rate_limits", rate_limits: [] }, { type: "codex.rate_limits", rate_limits: {} }])
    assert.equal(codexUsageFromEvent(bad), undefined);
  const mutate = (change: Record<string, unknown>) => ({ type: "codex.rate_limits", rate_limits: { primary: { ...eventWindow(primary), ...change }, secondary: eventWindow(secondary) } });
  const dropped = (change: Record<string, unknown>) => assert.deepEqual(codexUsageFromEvent(mutate(change)), { kind: "codex", secondary }, JSON.stringify(change));
  for (const value of [null, true, false, "42", " 42 ", "", -0.5, 100.01, Infinity, NaN, undefined, [42], {}]) dropped({ used_percent: value });
  for (const value of [null, true, "300", 0, -1, 1.5, 1051201, Infinity, undefined]) dropped({ window_minutes: value });
  for (const value of [null, false, String(now + 5), 0, 17.5, now + 0.5, 999999999, 4102444801, undefined]) dropped({ reset_at: value });
  assert.equal(codexUsageFromEvent(mutate({ used_percent: 0 }))?.primary?.usedPercent, 0);
  assert.equal(Object.is(codexUsageFromEvent(mutate({ used_percent: -0 }))?.primary?.usedPercent, 0), true);
  assert.equal(codexUsage({ kind: "codex", primary: { ...primary, usedPercent: "5" } }), undefined, "a stored window is revalidated, not coerced");
  assert.equal(codexUsage({ kind: "codex" }), undefined);
});

const sse = (...frames: unknown[]) => frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("");
const completed = (...before: unknown[]) => sse(...before, { type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });

// Each fixture mocks fetch, so a test that needs several runs each in a context of its own and the mocks restore in order.
async function fixture(t: TestContext, reply: () => Response, type: ProviderConfig["type"] = "codex-subscription") {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-usage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return reply(); });
  const config: ProviderConfig = type === "codex-subscription" ? { id: "codex", type, credentialFile, models: { alias: "upstream" } }
    : { id: "api", type, baseUrl: "https://example.test/v1", credentialFile, models: { alias: "upstream" } };
  const seen: CodexUsage[] = []; const revisions: Array<string | undefined> = [];
  const run = async (observer: CodexUsageObserver = (usage, revision) => { seen.push(usage); revisions.push(revision); }) => {
    const events: string[] = [];
    for await (const event of new ResponsesAPI(config, observer).infer({ model: "upstream", input: "fixture" }, new AbortController().signal)) events.push(event.type);
    return events;
  };
  return { run, seen, revisions, calls: () => calls, config, credentialFile, directory };
}
const stream = (headers: Record<string, string> = {}, body = completed()) => new Response(body, { headers: { "Content-Type": "text/event-stream", ...headers } });

test("a Codex response reports its quota headers and rate events without changing the turn", async t => {
  let baseline: string[] = [];
  await t.test("a backend that sends no quota data", async st => {
    const plain = await fixture(st, () => stream({}, completed()));
    baseline = await plain.run(); assert.deepEqual(plain.seen, []);
  });
  await t.test("a backend that sends headers and a rate event", async st => {
    const f = await fixture(st, () => stream(wire(), completed(rateEvent({ rate_limits: { primary: eventWindow({ ...primary, usedPercent: 50 }) } }))));
    assert.deepEqual(await f.run(), baseline);
    assert.deepEqual(f.seen, [{ kind: "codex", primary, secondary }, { kind: "codex", primary: { ...primary, usedPercent: 50 } }]);
    assert.deepEqual(f.revisions, [credentialRevision(f.credentialFile), credentialRevision(f.credentialFile)]);
    assert.equal(typeof f.revisions[0], "string");
  });
});

test("a failed response still reports the quota headers that explain it", async t => {
  const f = await fixture(t, () => new Response(JSON.stringify({ error: { type: "usage_limit_reached", message: "private" } }), { status: 429, headers: { "Content-Type": "application/json", ...wire() } }));
  await assert.rejects(f.run(), (error: unknown) => error instanceof ProviderError && error.status === 429);
  assert.equal(f.calls(), 1); assert.deepEqual(f.seen, [{ kind: "codex", primary, secondary }]);
});

test("other Responses APIs and named or partial data never produce an observation", async t => {
  await t.test("another Responses API", async st => {
    const other = await fixture(st, () => stream(wire(), completed(rateEvent())), "responses-api");
    await other.run(); assert.deepEqual(other.seen, []);
  });
  await t.test("a named limit and a partial window", async st => {
    const named = await fixture(st, () => stream({}, completed(rateEvent({ metered_limit_name: "codex_other" }), { type: "codex.rate_limits", rate_limits: { primary: { used_percent: 5 } } })));
    await named.run(); assert.deepEqual(named.seen, []);
  });
});

test("an observer that throws or rejects cannot fail, delay, or retry inference", async t => {
  let baseline: string[] = [];
  await t.test("baseline", async st => { baseline = await (await fixture(st, () => stream(wire(), completed(rateEvent())))).run(); });
  const observers: Record<string, CodexUsageObserver> = { throws: () => { throw new Error("sync"); }, rejects: () => Promise.reject(new Error("async")), never: () => new Promise<void>(() => {}) };
  for (const [name, observer] of Object.entries(observers)) await t.test(name, async st => {
    const f = await fixture(st, () => stream(wire(), completed(rateEvent())));
    assert.deepEqual(await f.run(observer), baseline); assert.equal(f.calls(), 1);
  });
  await t.test("a failed request", async st => {
    const failing = await fixture(st, () => new Response("{}", { status: 429, headers: wire() }));
    await assert.rejects(failing.run(() => { throw new Error("sync"); }), (error: unknown) => error instanceof ProviderError && error.status === 429);
  });
  observeCodexUsage(() => { throw new Error("x"); }, { kind: "codex", primary }, "r"); observeCodexUsage(undefined, { kind: "codex", primary }, "r"); observeCodexUsage(() => {}, undefined, "r");
});

const provider = (directory: string, extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: "codex", type: "codex-subscription", credentialFile: join(directory, "registration.json"), models: { alias: "upstream" }, ...extra });
const rec = (store: ProviderUsageStore, config: ProviderConfig, usage: CodexUsage) => store.recordCodex(config, usage, credentialRevision(config.credentialFile));
const credential = (directory: string, text = "{}") => writeFile(join(directory, "registration.json"), text, { mode: 0o600 });

test("Codex counters persist across restart and are discarded when their credentials change", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-store-")); t.after(() => rm(directory, { recursive: true, force: true }));
  await credential(directory); const config = provider(directory);
  const store = new ProviderUsageStore(directory);
  await rec(store, config, { kind: "codex", primary, secondary });
  const [row] = store.snapshot([config]) as CodexProviderUsage[];
  assert.ok(isCodexUsage(row)); assert.deepEqual({ primary: row.primary, secondary: row.secondary, providerId: row.providerId }, { primary, secondary, providerId: "codex" });
  assert.equal((await stat(join(directory, "provider-usage.json"))).mode & 0o777, 0o600);
  const saved = await readFile(join(directory, "provider-usage.json"), "utf8");
  assert.ok(!saved.includes("registration.json") && !saved.includes("fixture-only"), "no credential path or token is saved");
  const restarted = new ProviderUsageStore(directory); await restarted.restore([config]);
  assert.deepEqual(restarted.snapshot([config]), [row]);
  assert.deepEqual(restarted.snapshot([]), []);
  assert.deepEqual(restarted.snapshot([{ ...config, type: "responses-api" }]), [], "another provider type never inherits it");
  // A different credential path.
  await credential(directory, "{}"); await writeFile(join(directory, "other.json"), "{}", { mode: 0o600 });
  assert.deepEqual(store.snapshot([{ ...config, credentialFile: join(directory, "other.json") }]), []);
  const moved = new ProviderUsageStore(directory); await moved.restore([{ ...config, credentialFile: join(directory, "other.json") }]); assert.deepEqual(moved.snapshot([{ ...config, credentialFile: join(directory, "other.json") }]), []);
  // The same path replaced by a new file (new inode) or only touched (mtime), or rewritten with a different size.
  await rec(store, config, { kind: "codex", primary });
  assert.equal(store.snapshot([config]).length, 1);
  await utimes(join(directory, "registration.json"), new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(store.snapshot([config]), [], "touched credentials");
  await rec(store, config, { kind: "codex", primary }); assert.equal(store.snapshot([config]).length, 1);
  await credential(directory, '{"replaced":true}'); assert.deepEqual(store.snapshot([config]), [], "rewritten credentials");
  await rec(store, config, { kind: "codex", primary }); await writePrivateJson(join(directory, "registration.json"), {});
  assert.deepEqual(store.snapshot([config]), [], "replaced file at the same path");
  const afterReplace = new ProviderUsageStore(directory); await afterReplace.restore([config]); assert.deepEqual(afterReplace.snapshot([config]), [], "a restart does not revive replaced credentials");
  // Unreadable credentials: no old observation, and nothing new is recorded.
  await rec(store, config, { kind: "codex", primary }); assert.equal(store.snapshot([config]).length, 1);
  if (process.getuid?.() !== 0) {
    const file = join(directory, "registration.json"); await chmod(file, 0o000);
    assert.deepEqual(store.snapshot([config]), [], "a credential file the gateway cannot read has no counters");
    const unreadable = await readFile(join(directory, "provider-usage.json"), "utf8"); await rec(store, config, { kind: "codex", secondary });
    assert.equal(await readFile(join(directory, "provider-usage.json"), "utf8"), unreadable, "nothing is recorded for an unreadable file");
    await chmod(file, 0o600); assert.deepEqual(store.snapshot([config]), [], "changed permissions are a changed credential");
    await rec(store, config, { kind: "codex", primary });
  }
  await rm(join(directory, "registration.json")); assert.deepEqual(store.snapshot([config]), []);
  const before = await readFile(join(directory, "provider-usage.json"), "utf8"); await rec(store, config, { kind: "codex", secondary });
  assert.equal(await readFile(join(directory, "provider-usage.json"), "utf8"), before); assert.deepEqual(store.snapshot([config]), []);
});

test("the store accepts Codex counters only for a Codex provider, and Claude rows keep their format", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-store-")); t.after(() => rm(directory, { recursive: true, force: true }));
  await credential(directory); const store = new ProviderUsageStore(directory);
  const claude: ProviderConfig = { id: "claude", type: "claude-subscription", authDirectory: join(directory, "auth"), models: { a: "b" } };
  await rec(store, { ...provider(directory), type: "responses-api" }, { kind: "codex", primary });
  await rec(store, claude, { kind: "codex", primary });
  await rec(store, provider(directory), { kind: "codex", primary: { ...primary, usedPercent: 101 } });
  await rec(store, provider(directory), { kind: "codex" });
  await rec(store, provider(directory, { id: "Bad Id" }), { kind: "codex", primary });
  await store.record(provider(directory), { status: "rejected", window: "five_hour", resetsAt: now + 60 });
  assert.deepEqual(store.snapshot([provider(directory), claude, { ...provider(directory), type: "responses-api" }]), []);
  await store.record(claude, { status: "rejected", window: "five_hour", resetsAt: now + 3600 });
  await rec(store, provider(directory), { kind: "codex", primary });
  const rows = store.snapshot([provider(directory), claude]);
  assert.deepEqual(rows.map(row => isCodexUsage(row) ? "codex" : (row as { window: string }).window).sort(), ["codex", "five_hour"]);
  const file = JSON.parse(await readFile(join(directory, "provider-usage.json"), "utf8")) as { version: number; data: Array<Record<string, unknown>> };
  assert.equal(file.version, 1); assert.deepEqual(Object.keys(file.data.find(entry => entry.window)!).sort(), ["binding", "observedAt", "providerId", "resetsAt", "status", "window"]);
  const restarted = new ProviderUsageStore(directory); await restarted.restore([provider(directory), claude]);
  assert.deepEqual(restarted.snapshot([provider(directory), claude]), rows);
  const old = new ProviderUsageStore(directory); await old.restore([claude]); assert.equal(old.snapshot([claude]).length, 1);
});

test("the desktop merge adds a labelled Codex row with exact counters and keeps every native field", () => {
  const observedAt = now - 30; const row: CodexProviderUsage = { kind: "codex", providerId: "codex", observedAt, primary, secondary };
  const native = { accountId: "primary", ordinaryUsageAllowed: true, rateLimits: { limitId: "codex", primary: { usedPercent: 22 } }, rateLimitsByLimitId: { codex: { limitId: "codex", credits: { balance: "5" } } }, rateLimitUpsell: null };
  const serialized = JSON.stringify(native);
  const merged = mergeGatewayUsage(native, [row], now) as typeof native & { rateLimitsByLimitId: Record<string, unknown> };
  assert.deepEqual(merged.rateLimitsByLimitId["gateway:codex:codex"], { limitId: "gateway:codex:codex", limitName: "Codex · codex",
    primary: { usedPercent: 42.5, windowDurationMins: 300, resetsAt: primary.resetsAt }, secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: secondary.resetsAt },
    credits: null, planType: null, rateLimitReachedType: null });
  assert.equal(merged.rateLimits, native.rateLimits); assert.equal(merged.rateLimitsByLimitId.codex, native.rateLimitsByLimitId.codex);
  assert.equal(merged.accountId, "primary"); assert.equal(merged.rateLimitUpsell, null); assert.equal(JSON.stringify(native), serialized);
  assert.equal(mergeGatewayUsage(native, [{ ...row, providerId: "work" }], now).rateLimitsByLimitId && (mergeGatewayUsage(native, [{ ...row, providerId: "work" }], now).rateLimitsByLimitId as Record<string, { limitName: string }>)["gateway:work:codex"].limitName, "Codex · work");
  const only = mergeGatewayUsage(native, [{ ...row, primary: undefined }], now).rateLimitsByLimitId as Record<string, { primary: unknown; secondary: unknown }>;
  assert.equal(only["gateway:codex:codex"].primary, null); assert.notEqual(only["gateway:codex:codex"].secondary, null);
  // Stale, future, expired, and colliding observations never render.
  assert.equal(mergeGatewayUsage(native, [{ ...row, observedAt: now - 86401 }], now), native, "stale");
  assert.equal(mergeGatewayUsage(native, [{ ...row, observedAt: now + 301 }], now), native, "future");
  assert.equal((mergeGatewayUsage(native, [{ ...row, observedAt: now + 300 }], now).rateLimitsByLimitId as Record<string, unknown>)["gateway:codex:codex"] !== undefined, true);
  assert.equal(mergeGatewayUsage(native, [row], secondary.resetsAt), native, "every window expired");
  const half = mergeGatewayUsage(native, [row], primary.resetsAt).rateLimitsByLimitId as Record<string, { primary: unknown; secondary: { usedPercent: number } }>;
  assert.equal(half["gateway:codex:codex"].primary, null); assert.equal(half["gateway:codex:codex"].secondary.usedPercent, 7);
  const collision = { ...native, rateLimitsByLimitId: { "gateway:codex:codex": { original: true } } };
  assert.equal(mergeGatewayUsage(collision, [row], now), collision);
  assert.equal(mergeGatewayUsage(native, [], now), native);
});

test("a gateway-observed Codex quota reaches the desktop merge, and a backend without data adds nothing", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-e2e-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const registration = join(directory, "registration.json");
  await writeFile(registration, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  const config: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, providers: [{ id: "codex", type: "codex-subscription", credentialFile: registration, models: { alias: "upstream" } }] };
  const upstream = { headers: wire() as Record<string, string> };
  const original = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("http://127.0.0.1")) return original(input, init);
    return new Response(completed(), { headers: { "Content-Type": "text/event-stream", ...upstream.headers } });
  });
  const server = await startGateway(config);
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const client = { ...config, port: (server.address() as { port: number }).port, providers: [], clientOnly: true };
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  const ask = async () => { const response = await original(`http://127.0.0.1:${client.port}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "alias", input: "fixture" }) }); assert.equal(response.status, 200); await response.text(); };
  const native = { accountId: "primary", rateLimitsByLimitId: { codex: { limitId: "codex" } } };
  const router = new AppServerRouter(client, async () => native);

  upstream.headers = {}; await ask();
  assert.deepEqual(await gatewayUsage(client), []); assert.deepEqual(await router.request("account/rateLimits/read", {}), native, "no data from the backend, no row");

  upstream.headers = wire(); await ask();
  for (let attempt = 0; attempt < 50 && !(await gatewayUsage(client)).length; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  const observed = await gatewayUsage(client); assert.equal(observed.length, 1); assert.ok(isCodexUsage(observed[0]));
  const combined = await router.request("account/rateLimits/read", {}); const limits = combined.rateLimitsByLimitId as Record<string, { limitName: string; primary: { usedPercent: number }; secondary: { usedPercent: number } }>;
  assert.equal(limits["gateway:codex:codex"].limitName, "Codex · codex"); assert.equal(limits["gateway:codex:codex"].primary.usedPercent, 42.5); assert.equal(limits["gateway:codex:codex"].secondary.usedPercent, 7);
  assert.equal(limits.codex, native.rateLimitsByLimitId.codex); assert.equal(combined.accountId, "primary");
  await writePrivateJson(registration, { access_token: "other", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 });
  assert.deepEqual(await gatewayUsage(client), [], "replaced credentials hide the old counters");
});

test("a credential replaced after the request read its token never receives that request's counters", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-race-")); t.after(() => rm(directory, { recursive: true, force: true }));
  await credential(directory); const config = provider(directory); const file = join(directory, "registration.json");
  await t.test("replaced while the write waits in the queue", async () => {
    const store = new ProviderUsageStore(directory); const revision = credentialRevision(file);
    const write = store.recordCodex(config, { kind: "codex", primary }, revision);
    writeFileSync(file, '{"account":"b"}'); // after the revision was taken, before the queued write runs
    await write; assert.deepEqual(store.snapshot([config]), []);
    await store.recordCodex(config, { kind: "codex", primary }, credentialRevision(file)); assert.equal(store.snapshot([config]).length, 1);
    await store.recordCodex(config, { kind: "codex", secondary }, undefined);
    const kept = store.snapshot([config]);
    assert.equal(kept.length, 1, "an unknown revision records nothing, although the credential file is readable");
    assert.deepEqual((kept[0] as CodexProviderUsage).primary, primary); assert.equal((kept[0] as CodexProviderUsage).secondary, undefined);
  });
  await t.test("an unknown revision yields no row at all", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "gateway-codex-unknown-")); t.after(() => rm(fresh, { recursive: true, force: true }));
    await credential(fresh); const other = provider(fresh); const store = new ProviderUsageStore(fresh);
    assert.equal(typeof credentialRevision(other.credentialFile), "string");
    await store.recordCodex(other, { kind: "codex", primary }, undefined);
    assert.deepEqual(store.snapshot([other]), []);
  });
  await t.test("replaced while the request was in flight", async st => {
    let replace = () => {};
    const f = await fixture(st, () => { replace(); return stream(wire(), completed(rateEvent())); });
    const store = new ProviderUsageStore(f.directory); const writes: Array<Promise<void>> = [];
    const observer: CodexUsageObserver = (usage, revision) => { const write = store.recordCodex(f.config, usage, revision); writes.push(write); return write; };
    await f.run(observer); await Promise.all(writes);
    assert.equal(writes.length, 2); assert.equal(store.snapshot([f.config]).length, 1, "control: the unchanged credential keeps its counters");
    const replaced = new ProviderUsageStore(f.directory); writes.length = 0;
    replace = () => writeFileSync(f.credentialFile, '{"account":"b"}');
    await f.run((usage, revision) => { const write = replaced.recordCodex(f.config, usage, revision); writes.push(write); return write; }); await Promise.all(writes);
    assert.equal(writes.length, 2); assert.deepEqual(replaced.snapshot([f.config]), [], "account A's counters are not attributed to account B");
  });
});
