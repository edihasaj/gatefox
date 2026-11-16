import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { shortFolder } from "./short-folder.js";
import { explainClaudeKeychainFailure, loginKeychainHelper, offerLoginKeychainUnlock, type LoginKeychainStatus } from "../mac-login-keychain.js";
import { ProviderError } from "../providers/provider.js";

const locked: LoginKeychainStatus = { state: "locked", graphic: true, session: 501, boot: "12345678-1234-1234-1234-123456789abc" };
const providers = [{ id: "claude-secondary", type: "claude-subscription" as const, models: {} }];

test("the keychain helper comes only from the current app runtime", () => {
  assert.equal(loginKeychainHelper("/Applications/GateFox.app/Contents/Resources/backend/runtime/bin/node", "darwin"),
    "/Applications/GateFox.app/Contents/MacOS/GatewayService");
  assert.equal(loginKeychainHelper("/usr/local/bin/node", "darwin"), undefined);
  assert.equal(loginKeychainHelper("/Applications/GateFox.app/Contents/Resources/backend/runtime/bin/node", "linux"), undefined);
});

test("concurrent starts and cancellation offer only one unlock per boot and GUI session", async () => {
  const f = await shortFolder("gwkc-");
  let status = locked; let prompts = 0;
  const read = async (unlock = false): Promise<LoginKeychainStatus> => {
    if (unlock) { prompts++; return { ...status, state: "cancelled" }; }
    return status;
  };
  const config = { stateDirectory: f.directory, providers };
  try {
    await Promise.all([offerLoginKeychainUnlock(config, read), offerLoginKeychainUnlock(config, read)]);
    await offerLoginKeychainUnlock(config, read);
    assert.equal(prompts, 1);
    const receipt = JSON.parse(await readFile(join(f.directory, "login-keychain-prompt.json"), "utf8"));
    assert.deepEqual(receipt, { boot: locked.boot, session: locked.session });
    status = { ...locked, session: 502 };
    await offerLoginKeychainUnlock(config, read); assert.equal(prompts, 2);
    status = { ...status, boot: "aaaaaaaa-1234-1234-1234-123456789abc" };
    await offerLoginKeychainUnlock(config, read); assert.equal(prompts, 3);
  } finally { await f.remove(); }
});

test("unlocked, unknown, headless and unidentified sessions never prompt", async () => {
  const f = await shortFolder("gwkc-");
  try {
    for (const status of [undefined, { ...locked, state: "unlocked" as const }, { ...locked, state: "unknown" as const },
      { ...locked, graphic: false }, { ...locked, boot: "" }, { ...locked, session: 0 }]) {
      await offerLoginKeychainUnlock({ stateDirectory: f.directory, providers }, async unlock => {
        assert.ok(!unlock); return status;
      });
    }
    for (const config of [{ stateDirectory: f.directory, providers: [] }, { stateDirectory: f.directory, providers, clientOnly: true }]) {
      await offerLoginKeychainUnlock(config, async () => assert.fail("no credential check for clients or non-Claude hosts"));
    }
  } finally { await f.remove(); }
});

test("failed prompting is claimed before UI so a service restart cannot loop", async () => {
  const f = await shortFolder("gwkc-"); let prompts = 0;
  const read = async (unlock = false) => { if (unlock) { prompts++; throw Error("timeout"); } return locked; };
  try {
    await assert.rejects(offerLoginKeychainUnlock({ stateDirectory: f.directory, providers }, read), /timeout/);
    await offerLoginKeychainUnlock({ stateDirectory: f.directory, providers }, read);
    assert.equal(prompts, 1);
  } finally { await f.remove(); }
});

test("only a proven login-unavailable failure with a locked keychain gets the local explanation", async () => {
  const error = new ProviderError("authentication", "Claude subscription requires login", 401,
    { code: "authentication_failed", event: "claude.assistant", reason: "login_unavailable" });
  const mapped = await explainClaudeKeychainFailure(error, async () => locked);
  assert.ok(mapped instanceof ProviderError);
  assert.equal(mapped.upstream?.reason, "keychain_locked"); assert.equal(mapped.status, 401);
  assert.match(mapped.message, /Keychain is locked/);
  assert.equal(await explainClaudeKeychainFailure(error, async () => ({ ...locked, state: "unlocked" })), error);
  assert.equal(await explainClaudeKeychainFailure(error, async () => undefined), error);
  const revoked = new ProviderError("authentication", "revoked", 401, { code: "authentication_failed", reason: "credential_revoked" });
  assert.equal(await explainClaudeKeychainFailure(revoked, async () => assert.fail("revocation is not a local lock")), revoked);
  const other = Error("unrelated");
  assert.equal(await explainClaudeKeychainFailure(other, async () => assert.fail("no probing for unrelated errors")), other);
});
