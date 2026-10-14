import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { accountHomePath } from "../account-engine-home.js";
import { acquireAccountLease } from "../account-lease.js";
import { emailHash, identityPath, loginAccount, logoutAccount, nativeIdentityPath, resolveSignedCodex } from "../account-login.js";
import { accountFixture } from "./account-fixture.js";

const accounts = [{ id: "codex3", label: "Codex 3" }];
const setup = async (extra: Record<string, unknown> = { accountEngines: accounts }, nativeEmail = "primary@example.test") => {
  const f = await accountFixture(extra); await writeFile(nativeIdentityPath(f.state), JSON.stringify({ version: 1, emailSha256: emailHash(nativeEmail) }), { mode: 0o600 });
  return { f, options: { configPath: f.configPath, id: "codex3", codex: f.codex, nativeHome: f.nativeHome, stdio: "ignore" as const, write: () => {}, preflightTimeoutMs: 8000 } };
};

test("login checks status, then device auth, with an absolute account CODEX_HOME, and records only a hash", async () => {
  const { f, options } = await setup(); const out: string[] = [];
  await loginAccount({ ...options, write: text => out.push(text) });
  const calls = await f.calls(); const home = accountHomePath(f.state, "codex3");
  assert.deepEqual(calls.slice(0, 2).map(call => call.a.slice(calls[0].a.indexOf("login"))), [["login", "status"], ["login", "--device-auth"]]);
  assert.ok(calls.length >= 3 && calls.every(call => call.home === home));
  assert.ok(calls.every(call => call.envKeys.length === 0));
  const identity = await readFile(identityPath(f.state, "codex3"), "utf8"); assert.equal((await stat(identityPath(f.state, "codex3"))).mode & 0o777, 0o600);
  assert.doesNotMatch(identity, /example\.test/); assert.equal(JSON.parse(identity).emailSha256, emailHash("second@example.test"));
  assert.ok(out.join("").includes("codex3: signed in (plan: pro)")); assert.doesNotMatch(out.join(""), /example\.test/);
});
test("login refuses when status already reports a login", async () => {
  const { f, options } = await setup(); await loginAccount(options);
  await assert.rejects(loginAccount(options), /already logged in; run gateway account logout codex3/);
  assert.ok(!(await f.calls()).slice(-1)[0].a.includes("--device-auth"));
});
test("login refuses while the lease is held", async () => {
  const { f, options } = await setup(); const release = await acquireAccountLease(f.state, "codex3", "host");
  await assert.rejects(loginAccount(options), /Codex 3 is in use; finish its chats or quit the app first/); assert.equal((await f.calls()).length, 0); await release!();
});
test("an identity equal to the native account is refused and not written, unless a workspace tells them apart", async () => {
  const { f, options } = await setup(undefined, "second@example.test");
  await assert.rejects(loginAccount(options), /same ChatGPT user as the native account/);
  await assert.rejects(stat(identityPath(f.state, "codex3")), { code: "ENOENT" });
  const ws = await setup({ accountEngines: [{ id: "codex3", workspaceId: "ws_2" }] }, "second@example.test");
  assert.equal((await loginAccount(ws.options)).distinctBy, "workspace"); assert.match(await readFile(identityPath(ws.f.state, "codex3"), "utf8"), /ws_2/);
});
test("an identity equal to another configured account is refused", async () => {
  const { f, options } = await setup({ accountEngines: [{ id: "codex3" }, { id: "codex4" }] });
  await loginAccount({ ...options, id: "codex4" }); await assert.rejects(loginAccount(options), /same ChatGPT user as account codex4/);
  await assert.rejects(stat(identityPath(f.state, "codex3")), { code: "ENOENT" });
});
test("login without a recorded native identity is refused before any spawn", async () => {
  const f = await accountFixture({ accountEngines: accounts });
  await assert.rejects(loginAccount({ configPath: f.configPath, id: "codex3", codex: f.codex, nativeHome: f.nativeHome, stdio: "ignore", write: () => {} }), /open the ChatGPT app|reopen it/); assert.equal((await f.calls()).length, 0);
});
test("the gateway SDK build, relative paths and PATH lookups are refused as --codex", async () => {
  const f = await accountFixture(); const sdk = new URL("../../gateway-sdk/gateway-codex", import.meta.url).pathname;
  await assert.rejects(resolveSignedCodex(f.configPath, sdk), /signed codex|not found|own Codex build/); await assert.rejects(resolveSignedCodex(f.configPath, "codex"), /absolute path/);
  await assert.rejects(resolveSignedCodex(f.configPath, join(f.root, "bin")), /executable|not found/);
});
test("logout revokes only the account home and forgets the identity", async () => {
  const { f, options } = await setup(); await loginAccount(options); await logoutAccount(options);
  await assert.rejects(stat(identityPath(f.state, "codex3")), { code: "ENOENT" }); await assert.rejects(stat(join(accountHomePath(f.state, "codex3"), "auth.json")), { code: "ENOENT" });
  assert.ok((await f.calls()).filter(call => call.a.includes("logout")).every(call => call.home === accountHomePath(f.state, "codex3")));
});
