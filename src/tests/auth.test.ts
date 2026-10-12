import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateIdToken, signIn, accessToken, type ChatGPTCredentials } from "../auth/chatgpt.js";
import { writePrivateJson } from "../config.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "test-key" };
const claims = { iss: "https://auth.openai.com", aud: "oaiapp_test", exp: Math.floor(Date.now() / 1000) + 3600, nonce: "test-nonce", sub: "test-user" };
function jwt(payload: typeof claims & { email?: string } = claims): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.${sign("RSA-SHA256", Buffer.from(`${header}.${body}`), keys.privateKey).toString("base64url")}`;
}
const scopes = "openid offline_access resource.invoke chatgpt.tokens.use.direct";

test("ID tokens require valid signature, audience, issuer, expiry, and nonce", async () => {
  assert.equal((await validateIdToken(jwt(), claims.aud, claims.nonce, [jwk])).subject, claims.sub);
  for (const changed of [{ iss: "https://wrong.test" }, { aud: "wrong" }, { exp: 1 }, { nonce: "wrong" }]) {
    await assert.rejects(validateIdToken(jwt({ ...claims, ...changed }), claims.aud, claims.nonce, [jwk]));
  }
  const tampered = jwt().split("."); tampered[1] = Buffer.from(JSON.stringify({ ...claims, sub: "forged" })).toString("base64url");
  await assert.rejects(validateIdToken(tampered.join("."), claims.aud, claims.nonce, [jwk]));
});

test("sign-in validates callback state, uses the issued client ID and exact PKCE callback, and stores private credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-auth-")); const path = join(directory, "codex.json");
  const original = globalThis.fetch; let authorize: URL; let exchangeCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://auth.openai.com/.well-known/jwks.json") return Response.json({ keys: [jwk] });
    if (url === "https://auth.openai.com/api/accounts/oauth/token") {
      exchangeCount++; const body = new URLSearchParams(String(init!.body));
      assert.equal(body.get("client_id"), "oaiapp_test");
      assert.equal(body.get("redirect_uri"), authorize.searchParams.get("redirect_uri"));
      assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), authorize.searchParams.get("code_challenge"));
      return Response.json({ access_token: "test-access", refresh_token: "test-refresh", id_token: jwt({ ...claims, nonce: authorize.searchParams.get("nonce")! }), token_type: "Bearer", expires_in: 3600, scope: scopes });
    }
    return original(input, init);
  };
  try {
    await signIn(path, "Gateway Test", async url => {
      authorize = new URL(url);
      assert.equal(authorize.searchParams.get("client_id"), "dynamic_agent_client");
      assert.equal(authorize.searchParams.get("agent_name_hint"), "Gateway Test");
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "test-code"); callback.searchParams.set("client_id", "oaiapp_test"); callback.searchParams.set("state", "wrong");
      assert.equal((await original(callback)).status, 400);
      assert.equal(exchangeCount, 0);
      callback.searchParams.set("state", authorize.searchParams.get("state")!);
      assert.equal((await original(callback)).status, 200);
    });
    const saved = JSON.parse(await readFile(path, "utf8")) as ChatGPTCredentials;
    assert.equal(saved.client_id, "oaiapp_test"); assert.equal(saved.subject, "test-user");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { globalThis.fetch = original; }
});

test("returning sign-in cannot replace an account with a different verified subject", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-auth-")); const path = join(directory, "codex.json");
  const prior: ChatGPTCredentials = { client_id: "oaiapp_test", subject: "original-user", ext_agent_host_id: "urn:uuid:test", access_token: "old-access", id_token: "old-id", scopes: scopes.split(" "), expires_at: Date.now() + 3600000 };
  await writePrivateJson(path, prior);
  const original = globalThis.fetch; let nonce = "";
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/.well-known/jwks.json")) return Response.json({ keys: [jwk] });
    if (String(input).endsWith("/oauth/token")) return Response.json({ access_token: "new-access", id_token: jwt({ ...claims, nonce }), token_type: "Bearer", expires_in: 3600, scope: scopes });
    return original(input, init);
  };
  try {
    await assert.rejects(signIn(path, "Gateway Test", async url => {
      const authorize = new URL(url); nonce = authorize.searchParams.get("nonce")!;
      assert.equal(authorize.searchParams.get("client_id"), prior.client_id);
      const callback = new URL(authorize.searchParams.get("redirect_uri")!); callback.searchParams.set("code", "test-code"); callback.searchParams.set("state", authorize.searchParams.get("state")!);
      await original(callback);
    }), /different account/);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), prior);
  } finally { globalThis.fetch = original; }
});

async function emailSignIn(path: string, expectedEmail: string, returnedEmail?: string): Promise<void> {
  const original = globalThis.fetch; let nonce = "";
  globalThis.fetch = async input => {
    if (String(input) === "https://auth.openai.com/.well-known/jwks.json") return Response.json({ keys: [jwk] });
    if (String(input) === "https://auth.openai.com/api/accounts/oauth/token") return Response.json({
      access_token: "email-fixture-access", refresh_token: "email-fixture-refresh", token_type: "Bearer", expires_in: 3600, scope: scopes,
      id_token: jwt({ ...claims, nonce, ...(returnedEmail === undefined ? {} : { email: returnedEmail }) }),
    });
    throw new Error("Unexpected external authentication request");
  };
  try {
    await signIn(path, "Gateway Email Test", async url => {
      const authorize = new URL(url); nonce = authorize.searchParams.get("nonce")!;
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "email-fixture-code");
      callback.searchParams.set("state", authorize.searchParams.get("state")!);
      callback.searchParams.set("client_id", claims.aud);
      assert.equal((await original(callback)).status, 200);
    }, undefined, expectedEmail);
  } finally { globalThis.fetch = original; }
}

test("requested sign-in account accepts a verified email case-insensitively", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-auth-email-")); const path = join(directory, "codex.json");
  await emailSignIn(path, "  edi@fixture.invalid  ", "EDI@fixture.invalid");
  const saved = JSON.parse(await readFile(path, "utf8")) as ChatGPTCredentials;
  assert.equal(saved.email, "EDI@fixture.invalid");
  assert.equal(saved.subject, claims.sub); assert.equal(saved.access_token, "email-fixture-access");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("wrong or missing verified email never creates or replaces credential files", async () => {
  for (const returnedEmail of ["other@fixture.invalid", undefined]) {
    for (const existing of [false, true]) {
      const directory = await mkdtemp(join(tmpdir(), "gateway-auth-email-")); const path = join(directory, "codex.json");
      const prior: ChatGPTCredentials = { client_id: claims.aud, subject: claims.sub, email: "edi@fixture.invalid",
        ext_agent_host_id: "urn:uuid:email-test", access_token: "unchanged-access", refresh_token: "unchanged-refresh",
        id_token: "unchanged-id", scopes: scopes.split(" "), expires_at: Date.now() + 3600000 };
      if (existing) await writePrivateJson(path, prior);
      const before = existing ? await readFile(path) : undefined;
      await assert.rejects(emailSignIn(path, "edi@fixture.invalid", returnedEmail), /different account/);
      if (existing) assert.deepEqual(await readFile(path), before);
      else await assert.rejects(stat(path), { code: "ENOENT" });
    }
  }
});

test("invalid requested email is rejected before authorization or network activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-auth-email-")); const path = join(directory, "codex.json");
  const original = globalThis.fetch; let requests = 0; let openings = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Authentication network must not start"); };
  try {
    for (const email of ["", " ", "edi", "edi@localhost", "edi @fixture.invalid", "edi@fixture.invalid\nother@fixture.invalid"]) {
      await assert.rejects(signIn(path, "Gateway Email Test", () => { openings++; }, undefined, email), /Requested account email is invalid/);
    }
    assert.equal(openings, 0); assert.equal(requests, 0);
    await assert.rejects(stat(path), { code: "ENOENT" });
    await assert.rejects(stat(join(directory, "host.json")), { code: "ENOENT" });
  } finally { globalThis.fetch = original; }
});

test("concurrent refresh rotates credentials once and atomically preserves registration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-refresh-")); const path = join(directory, "codex.json");
  await writePrivateJson(path, { client_id: "oaiapp_test", subject: "test-user", ext_agent_host_id: "urn:uuid:test", access_token: "old-access", refresh_token: "old-refresh", id_token: "old-id", scopes: scopes.split(" "), expires_at: 0 });
  const original = globalThis.fetch; let count = 0;
  globalThis.fetch = async (_input, init) => {
    count++; const body = new URLSearchParams(String(init!.body));
    assert.equal(body.get("grant_type"), "refresh_token"); assert.equal(body.get("client_id"), "oaiapp_test");
    return Response.json({ access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer", expires_in: 3600, scope: scopes });
  };
  try {
    assert.deepEqual(await Promise.all([accessToken(path), accessToken(path)]), ["new-access", "new-access"]);
    assert.equal(count, 1);
    const saved = JSON.parse(await readFile(path, "utf8")) as ChatGPTCredentials;
    assert.equal(saved.refresh_token, "new-refresh"); assert.equal(saved.subject, "test-user"); assert.equal(saved.id_token, "old-id");
    assert.equal(await accessToken(path), "new-access"); assert.equal(count, 1);
  } finally { globalThis.fetch = original; }
});
