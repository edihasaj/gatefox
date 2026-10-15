import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { accessToken, ChatGPTLoginRequired, ChatGPTRefreshDeferred, oauthErrorCode, type ChatGPTCredentials } from "../auth/chatgpt.js";
import { discoverModels } from "../catalog.js";
import { refreshModelMetadata } from "../model-refresh.js";
import { providerFailureDiagnostic } from "../provider-failure.js";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ProviderError } from "../providers/provider.js";
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

test("the six-hour metadata refresh skips an expired Codex login without a token request and records why", async () => {
  const { directory, path } = await loginFile(0);
  const configPath = join(directory, "gateway.json");
  await writePrivateJson(configPath, { version: 1, port: 3457, stateDirectory: directory, providers: [
    { id: "codex", type: "codex-subscription", credentialFile: path, models: { "codex/test": "test" } },
  ] } satisfies GatewayConfig);
  configureTelemetry(directory, "server");
  await withFetch(async () => refreshReply(), async calls => {
    assert.deepEqual(await refreshModelMetadata(configPath), []);
    assert.deepEqual(calls.urls, [], "neither the token endpoint nor the model catalog is called");
  });
  assert.equal((await stored(path)).refresh_token, "old-refresh");
  await flushTelemetry();
  const skipped = (await readTelemetry(directory, Date.now() - 60_000)).filter(event => event.event === "model_metadata_skipped");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].provider, "codex"); assert.equal(skipped[0].reason, "refresh_deferred");
  assert.deepEqual(Object.keys(skipped[0]).sort(), ["at", "component", "event", "host", "pid", "provider", "reason"]);
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

test("the rotated refresh token is saved before the reply is validated", async () => {
  const { path } = await loginFile(0);
  await withFetch(async () => refreshReply({ scope: "openid" }), async () => {
    await assert.rejects(accessToken(path), error => error instanceof Error && !(error instanceof ChatGPTLoginRequired));
  });
  const after = await stored(path);
  assert.equal(after.refresh_token, "new-refresh", "a reply that fails validation cannot lose the rotated token");
  assert.equal(after.access_token, "old-access", "an unvalidated access token is not adopted");
  assert.deepEqual(after.scopes, scopes);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  // The next request spends the saved token, not the spent one.
  let sent = "";
  await withFetch(async (_url, init) => { sent = String((init?.body as URLSearchParams).get("refresh_token")); return refreshReply({ refresh_token: "newer-refresh" }); }, async () => {
    assert.equal(await accessToken(path), "new-access");
  });
  assert.equal(sent, "new-refresh"); assert.equal((await stored(path)).refresh_token, "newer-refresh");
  // A reply without a replacement token keeps the old one and still fails.
  const second = await loginFile(0);
  await withFetch(async () => refreshReply({ refresh_token: undefined }), async () => { await assert.rejects(accessToken(second.path)); });
  assert.equal((await stored(second.path)).refresh_token, "old-refresh");
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
