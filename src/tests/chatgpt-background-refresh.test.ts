import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayToken, validateConfig, writePrivateJson, type GatewayConfig } from "../config.js";
import { accessToken, ChatGPTLoginRequired, ChatGPTRefreshDeferred, oauthErrorCode, type ChatGPTCredentials } from "../auth/chatgpt.js";
import { discoverModels } from "../catalog.js";
import { refreshModelMetadata } from "../model-refresh.js";
import { providerFailureDiagnostic } from "../provider-failure.js";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ProviderError } from "../providers/provider.js";
import { startGateway } from "../server.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

const scopes = ["openid", "resource.invoke", "chatgpt.tokens.use.direct"];
const login = (expiresAt: number): ChatGPTCredentials => ({ client_id: "oaiapp_test", subject: "test-user", ext_agent_host_id: "urn:uuid:test",
  access_token: "old-access", refresh_token: "old-refresh", id_token: "id", scopes, expires_at: expiresAt });
async function loginFile(expiresAt: number): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-background-refresh-"));
  const path = join(directory, "codex.json"); await writePrivateJson(path, login(expiresAt));
  return { directory, path };
}
const refreshReply = (over: Record<string, unknown> = {}) => new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", id_token: "id2",
  token_type: "Bearer", expires_in: 3600, scope: scopes.join(" "), ...over }), { status: 200 });
interface Calls { urls: string[] }
async function withFetch<T>(fake: (url: string, init?: RequestInit) => Promise<Response>, run: (calls: Calls) => Promise<T>): Promise<T> {
  const original = globalThis.fetch; const calls: Calls = { urls: [] };
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => { const url = String(input); calls.urls.push(url); return fake(url, init); }) as typeof fetch;
  try { return await run(calls); } finally { globalThis.fetch = original; }
}
const stored = async (path: string) => JSON.parse(await readFile(path, "utf8")) as ChatGPTCredentials;
async function inferError(credentialFile: string): Promise<ProviderError> {
  const provider = new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, models: { "codex/test": "test" } });
  try { for await (const _event of provider.infer({ model: "test", input: "hi" }, new AbortController().signal)) {} }
  catch (error) { assert.ok(error instanceof ProviderError); return error; }
  throw new Error("inference unexpectedly succeeded");
}

test("a background token request never refreshes an expired or near-expiry login", async () => {
  for (const expiresAt of [0, Date.now() + 60_000]) {
    const { path } = await loginFile(expiresAt);
    await withFetch(async () => refreshReply(), async calls => {
      await assert.rejects(accessToken(path, { refresh: false }), error => error instanceof ChatGPTRefreshDeferred && !(error instanceof ChatGPTLoginRequired));
      assert.deepEqual(calls.urls, [], "no network call for a deferred refresh");
    });
    assert.equal((await stored(path)).refresh_token, "old-refresh", "the stored refresh token is untouched");
  }
  const { path } = await loginFile(Date.now() + 3_600_000);
  await withFetch(async () => refreshReply(), async calls => {
    assert.equal(await accessToken(path, { refresh: false }), "old-access", "a valid token is still served");
    assert.deepEqual(calls.urls, []);
  });
});

async function metadataConfig(directory: string, credentialFile: string): Promise<string> {
  const configPath = join(directory, "gateway.json");
  await writePrivateJson(configPath, { version: 1, port: 3457, stateDirectory: directory, providers: [
    { id: "codex", type: "codex-subscription", credentialFile, models: { "codex/test": "test" } },
  ] } satisfies GatewayConfig);
  return configPath;
}
const skippedEvents = async (directory: string) => { await flushTelemetry(); return (await readTelemetry(directory, Date.now() - 60_000)).filter(event => event.event === "model_metadata_skipped"); };
async function telemetryText(directory: string): Promise<string> {
  const folder = join(directory, "telemetry"); let text = "";
  for (const name of await readdir(folder)) text += await readFile(join(folder, name), "utf8");
  return text;
}

test("the six-hour metadata refresh skips an expired Codex login without a token request and records why", async () => {
  const { directory, path } = await loginFile(0);
  const configPath = await metadataConfig(directory, path);
  configureTelemetry(directory, "server");
  await withFetch(async () => refreshReply(), async calls => {
    assert.deepEqual(await refreshModelMetadata(configPath), []);
    assert.deepEqual(calls.urls, [], "neither the token endpoint nor the model catalog is called");
  });
  assert.equal((await stored(path)).refresh_token, "old-refresh");
  const skipped = await skippedEvents(directory);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].provider, "codex"); assert.equal(skipped[0].reason, "refresh_deferred");
  assert.deepEqual(Object.keys(skipped[0]).sort(), ["at", "component", "event", "host", "pid", "provider", "reason"]);
});

test("the six-hour metadata refresh records any other failure as discovery_failed without its text", async () => {
  const secret = "sk-secret-discovery-text";
  const { directory, path } = await loginFile(Date.now() + 3_600_000);
  const configPath = await metadataConfig(directory, path);
  configureTelemetry(directory, "server");
  await withFetch(async () => new Response(secret, { status: 500 }), async calls => {
    assert.deepEqual(await refreshModelMetadata(configPath), []);
    assert.deepEqual(calls.urls, ["https://api.openai.com/v1/models"], "a valid login is used without a token request");
  });
  assert.deepEqual(await refreshModelMetadata(configPath, async () => { throw new Error(secret); }), []);
  const skipped = await skippedEvents(directory);
  assert.equal(skipped.length, 2);
  for (const event of skipped) {
    assert.equal(event.provider, "codex"); assert.equal(event.reason, "discovery_failed");
    assert.deepEqual(Object.keys(event).sort(), ["at", "component", "event", "host", "pid", "provider", "reason"]);
  }
  const text = await telemetryText(directory);
  for (const leak of [secret, "old-access", "old-refresh"]) assert.ok(!text.includes(leak), `${leak} must not appear in telemetry`);
});

test("a real request and an explicit discover still refresh an expired login", async () => {
  const { path } = await loginFile(0);
  await withFetch(async url => url.endsWith("/oauth/token") ? refreshReply() : new Response(JSON.stringify({ models: [] }), { status: 200 }), async calls => {
    assert.equal(await accessToken(path), "new-access");
    assert.equal(calls.urls.filter(url => url.endsWith("/oauth/token")).length, 1);
  });
  assert.equal((await stored(path)).refresh_token, "new-refresh");
  const second = await loginFile(0);
  await withFetch(async url => url.endsWith("/oauth/token") ? refreshReply() : new Response(JSON.stringify({ models: [] }), { status: 200 }), async calls => {
    await discoverModels({ id: "codex", type: "codex-subscription", credentialFile: second.path, models: {} });
    assert.equal(calls.urls.filter(url => url.endsWith("/oauth/token")).length, 1);
  });
});

test("a refresh reply without the plan scope keeps the rotated token, asks for sign-in and never requests another token", async () => {
  // [reply change, refresh token kept on file, scopes kept on file]
  const cases: Array<[Record<string, unknown>, string, string[]]> = [
    [{ scope: "openid offline_access" }, "new-refresh", ["openid", "offline_access"]],
    [{ scope: undefined }, "new-refresh", []],
    [{ scope: "openid", token_type: "mac" }, "new-refresh", ["openid"]],
    [{ scope: "openid", refresh_token: undefined }, "old-refresh", ["openid"]],
  ];
  for (const [over, refreshToken, keptScopes] of cases) {
    const { path } = await loginFile(0);
    await withFetch(async () => refreshReply(over), async calls => {
      await assert.rejects(accessToken(path), ChatGPTLoginRequired, `${JSON.stringify(over)} needs the user`);
      // Later calls report the same without spending the rotated token.
      await assert.rejects(accessToken(path), ChatGPTLoginRequired);
      const error = await inferError(path);
      assert.equal(error.code, "authentication"); assert.equal(error.status, 401); assert.equal(error.message, "ChatGPT provider requires login");
      assert.equal(calls.urls.filter(url => url.endsWith("/oauth/token")).length, 1, `${JSON.stringify(over)} makes exactly one token request`);
    });
    const after = await stored(path);
    assert.equal(after.refresh_token, refreshToken, "a reply that fails validation cannot lose the rotated token");
    assert.equal(after.access_token, "old-access", "an unvalidated access token is not adopted");
    assert.deepEqual(after.scopes, keptScopes, "only the scopes this reply granted stay on file");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test("a malformed refresh reply is temporary: the rotated token is saved and the next real request refreshes with it", async () => {
  const malformed: Array<Record<string, unknown>> = [{ token_type: "mac" }, { token_type: 5 }, { token_type: undefined }, { access_token: 5 },
    { access_token: "" }, { access_token: undefined }, { expires_in: 0 }, { expires_in: "3600" }];
  for (const over of malformed) for (const rotated of ["rotated-refresh", undefined]) {
    const { path } = await loginFile(0);
    const sent: Array<string | null> = [];
    await withFetch(async (_url, init) => {
      sent.push(new URLSearchParams(String(init?.body)).get("refresh_token"));
      return sent.length === 1 ? refreshReply({ ...over, refresh_token: rotated }) : refreshReply();
    }, async () => {
      const error = await inferError(path);
      assert.equal(error.code, "upstream_unavailable", `${JSON.stringify(over)} is temporary`); assert.equal(error.status, 503); assert.equal(error.upstream, undefined);
      const after = await stored(path);
      assert.equal(after.refresh_token, rotated ?? "old-refresh", "a reply that fails validation cannot lose the rotated token");
      assert.equal(after.access_token, "old-access", "an unvalidated access token is not adopted");
      assert.deepEqual(after.scopes, scopes); assert.equal(after.expires_at, 0);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal(await accessToken(path), "new-access", "the next real request refreshes again");
      assert.deepEqual(sent, ["old-refresh", rotated ?? "old-refresh"], "one token request per request, the second with the saved token");
    });
    assert.equal((await stored(path)).refresh_token, "new-refresh");
  }
});

test("a valid refresh reply without a new refresh token is used and the stored refresh token kept", async () => {
  const { path } = await loginFile(0);
  await withFetch(async () => refreshReply({ refresh_token: undefined }), async calls => {
    assert.equal(await accessToken(path), "new-access");
    assert.equal(await accessToken(path), "new-access", "the saved access token serves later requests");
    assert.equal(calls.urls.filter(url => url.endsWith("/oauth/token")).length, 1);
  });
  const after = await stored(path);
  assert.equal(after.refresh_token, "old-refresh"); assert.equal(after.access_token, "new-access"); assert.equal(after.id_token, "id2");
  assert.deepEqual(after.scopes, scopes); assert.ok(after.expires_at > Date.now() + 3_000_000);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("a process waiting on the refresh lock does not request a token after another process found the login unusable", async () => {
  const { path } = await loginFile(0);
  const lock = `${path}.refresh-lock`;
  await writeFile(lock, String(process.pid), { mode: 0o600 });
  await withFetch(async () => refreshReply(), async calls => {
    const waiting = accessToken(path);
    await delay(150);
    // What the other process leaves behind after a reply without the plan scope.
    await writePrivateJson(path, { ...login(0), refresh_token: "new-refresh", scopes: ["openid"] });
    await unlink(lock);
    await assert.rejects(waiting, ChatGPTLoginRequired);
    assert.deepEqual(calls.urls, [], "the waiting process makes no token request");
  });
  assert.equal((await stored(path)).refresh_token, "new-refresh");
});

test("an unreadable reply and any other HTTP error status are temporary", async () => {
  for (const [status, body, upstreamCode] of [[200, "not json", undefined], [200, "null", undefined], [200, "[]", undefined], [404, JSON.stringify({ error: "invalid_request" }), "invalid_request"], [408, "", "none"]] as const) {
    const { path } = await loginFile(0);
    await withFetch(async () => new Response(body, { status }), async calls => {
      const error = await inferError(path);
      assert.equal(error.code, "upstream_unavailable"); assert.equal(error.status, 503);
      assert.equal(error.upstream?.code, upstreamCode); assert.equal(error.upstream?.httpStatus, upstreamCode ? status : undefined);
      assert.equal(calls.urls.filter(url => url.endsWith("/oauth/token")).length, 1);
    });
    assert.equal((await stored(path)).refresh_token, "old-refresh");
  }
});

test("a rejected refresh records only a fixed OAuth error code", async () => {
  const secret = "sk-secret-description refresh_token=old-refresh";
  const cases: Array<[number, string, string, string, number]> = [
    [400, JSON.stringify({ error: { code: "refresh_token_reused", message: secret } }), "refresh_token_reused", "authentication", 401],
    [401, JSON.stringify({ error: "invalid_grant", error_description: secret }), "invalid_grant", "authentication", 401],
    [403, JSON.stringify({ error: secret }), "other", "authentication", 401],
    [400, "not json " + secret, "none", "authentication", 401],
    [503, JSON.stringify({ error: "temporarily_unavailable", error_description: secret }), "temporarily_unavailable", "upstream_unavailable", 503],
  ];
  for (const [status, body, expected, code, httpStatus] of cases) {
    const { path } = await loginFile(0);
    await withFetch(async () => new Response(body, { status }), async () => {
      const error = await inferError(path);
      assert.equal(error.code, code); assert.equal(error.status, httpStatus);
      assert.equal(error.upstream?.code, expected); assert.equal(error.upstream?.event, "oauth_refresh"); assert.equal(error.upstream?.httpStatus, status);
      if (expected !== "none") assert.ok(error.message.includes(expected));
      const diagnostic = providerFailureDiagnostic({ requestId: "00000000-0000-4000-8000-000000000000", durationMs: 5, failure: error });
      assert.equal(diagnostic.upstreamCode, expected); assert.equal(diagnostic.upstreamEvent, "oauth_refresh");
      for (const text of [error.message, JSON.stringify(diagnostic)]) for (const leak of ["sk-secret", "description", "old-refresh", "old-access"]) assert.ok(!text.includes(leak), `${leak} must not appear`);
    });
  }
  assert.equal(oauthErrorCode(JSON.stringify({ code: "invalid_grant" })), "invalid_grant");
  assert.equal(oauthErrorCode(JSON.stringify({ error: 5 })), "none");
  assert.equal(oauthErrorCode("null"), "none");
});

test("a failed login refresh is never retried inside the provider, so the single-use token is spent once", async t => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  const directory = await mkdtemp(join(tmpdir(), "gateway-refresh-retry-"));
  configureTelemetry(directory, "server");
  for (const [status, expectedCode, expectedStatus] of [[500, "upstream_unavailable", 503], [503, "upstream_unavailable", 503], [400, "authentication", 401]] as const) {
    const { path } = await loginFile(0);
    await withFetch(async () => new Response(JSON.stringify({ error: "server_error" }), { status }), async calls => {
      const started = Date.now();
      const error = await inferError(path);
      assert.equal(error.code, expectedCode); assert.equal(error.status, expectedStatus);
      assert.equal(error.upstream?.code, "server_error"); assert.equal(error.upstream?.event, "oauth_refresh");
      assert.equal(calls.urls.filter(url => url.endsWith("/oauth/token")).length, 1, `HTTP ${status} makes exactly one token request`);
      assert.ok(Date.now() - started < 900, "no retry backoff is waited");
    });
  }
  await flushTelemetry();
  assert.equal((await readTelemetry(directory, Date.now() - 60_000)).filter(event => event.event === "provider_retry").length, 0);
  assert.ok(!logged.some(line => line.includes("provider_retry")));
});

test("request_failed telemetry names the OAuth error code and holds no token or reply text", async () => {
  const secret = "sk-secret-error-description";
  const { directory, path } = await loginFile(0);
  configureTelemetry(directory, "server");
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, providers: [{ id: "codex", type: "codex-subscription", credentialFile: path, models: { alias: "test" } }] });
  const server = await startGateway(config, provider => new ResponsesAPI(provider), undefined, { onFailure: () => {} });
  try {
    const gateway = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const authorization = `Bearer ${await gatewayToken(directory)}`;
    const real = globalThis.fetch;
    await withFetch(async (url, init) => url.startsWith(gateway) ? real(url, init)
      : new Response(JSON.stringify({ error: "refresh_token_reused", error_description: secret }), { status: 400 }), async calls => {
      const reply = await globalThis.fetch(`${gateway}/v1/responses`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ model: "alias", input: "hi" }) });
      const body = await reply.text();
      assert.equal(reply.status, 401);
      assert.equal(calls.urls.filter(url => url.endsWith("/oauth/token")).length, 1);
      for (const leak of [secret, "old-refresh", "old-access"]) assert.ok(!body.includes(leak), `${leak} must not reach the client`);
    });
    await flushTelemetry();
    const failed = (await readTelemetry(directory, Date.now() - 60_000)).filter(event => event.event === "request_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].upstreamCode, "refresh_token_reused"); assert.equal(failed[0].upstreamEvent, "oauth_refresh");
    assert.equal(failed[0].code, "authentication"); assert.equal(failed[0].status, 401);
    const text = await telemetryText(directory);
    for (const leak of [secret, "error_description", "old-refresh", "old-access", "new-refresh", "new-access"]) assert.ok(!text.includes(leak), `${leak} must not appear in telemetry`);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await flushTelemetry(); }
});
