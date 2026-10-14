import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJson } from "../config.js";
import { accessToken, ChatGPTLoginRequired } from "../auth/chatgpt.js";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ProviderError } from "../providers/provider.js";

const scopes = ["openid", "resource.invoke", "chatgpt.tokens.use.direct"];
async function expiredLogin(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "gateway-refresh-errors-")), "codex.json");
  await writePrivateJson(path, { client_id: "oaiapp_test", subject: "test-user", ext_agent_host_id: "urn:uuid:test", access_token: "old", refresh_token: "old-refresh", id_token: "id", scopes, expires_at: 0 });
  return path;
}
async function withFetch<T>(fake: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch; globalThis.fetch = fake;
  try { return await run(); } finally { globalThis.fetch = original; }
}
async function inferError(credentialFile: string): Promise<ProviderError> {
  const provider = new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, models: { "codex/test": "test" } });
  try { for await (const _event of provider.infer({ model: "test", input: "hi" }, new AbortController().signal)) {} }
  catch (error) { assert.ok(error instanceof ProviderError); return error; }
  throw new Error("inference unexpectedly succeeded");
}

test("a token refresh that fails on the network is temporary, so Codex retries instead of ending the chat", async () => {
  const path = await expiredLogin();
  await withFetch(async () => { throw new TypeError("fetch failed"); }, async () => {
    await assert.rejects(accessToken(path), error => !(error instanceof ChatGPTLoginRequired));
    const error = await inferError(path);
    assert.equal(error.code, "upstream_unavailable"); assert.equal(error.status, 503);
  });
  await withFetch(async () => new Response("{}", { status: 503 }), async () => assert.equal((await inferError(path)).code, "upstream_unavailable"));
});

test("a rejected grant or a missing login still asks for a new sign-in", async () => {
  const path = await expiredLogin();
  await withFetch(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }), async () => {
    await assert.rejects(accessToken(path), ChatGPTLoginRequired);
    assert.equal((await inferError(path)).code, "authentication");
  });
  assert.equal((await inferError(join(tmpdir(), "gateway-no-such-login", "codex.json"))).code, "authentication");
});
