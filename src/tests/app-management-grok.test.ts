import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { handleManagement } from "../app-management.js";
import { providerRoute } from "../app-management/aliases.js";
import { firstSignInURL } from "../app-management/providers.js";
import type { ManagementResult } from "../app-management/types.js";

const dependencies = { lookupCli: async () => true };
type Models = Record<string, string>; type Metadata = Record<string, Record<string, unknown>>;

async function fixture(home = "home-a", models: Models = { "grok/one": "grok-one", "grok/two": "grok-two" }, modelMetadata: Metadata = { "grok/one": { displayName: "One", contextWindow: 4096 }, "grok/two": { displayName: "Two", contextWindow: 4096 } }) {
  const root = await mkdtemp(join(tmpdir(), "gateway-grok-management-")); const path = join(root, "gateway.json"); const state = join(root, "state"); await mkdir(state, { recursive: true });
  const write = (config: object) => writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const config = (grokHome: string, providerModels: Models, metadata: Metadata) => ({ version: 1, port: 3457, stateDirectory: state, providers: [{ id: "grok", label: "Grok", type: "grok-subscription", grokHome: join(root, grokHome), models: providerModels, modelMetadata: metadata }] });
  await write(config(home, models, modelMetadata));
  return { root, path, state, write, config, raw: async () => JSON.parse(await readFile(path, "utf8")), ledger: async () => JSON.parse(await readFile(join(dirname(path), "app-aliases.json"), "utf8")) };
}
async function inspect(path: string): Promise<ManagementResult> {
  const result = await handleManagement({ operation: "inspect", configPath: path }, dependencies); assert.equal(result.ok, true); if (!result.ok) throw new Error("inspect"); return result.result;
}
async function select(path: string, selectedModels: string[]) {
  const current = await inspect(path);
  return handleManagement({ operation: "models", configPath: path, providerId: "grok", revision: current.revision, selectedModels }, dependencies);
}

test("a Grok connection reports its own sign-in state, offers reconnect but no discovery, and writes nothing", async () => {
  const f = await fixture(); const before = await readFile(f.path, "utf8");
  const result = await inspect(f.path); const provider = result.providers![0];
  assert.equal(provider.authState, "needs-sign-in"); assert.equal(provider.canDiscover, false); assert.equal(provider.canReconnect, true);
  assert.deepEqual(provider.models.map(model => [model.id, model.label, model.enabled]), [["grok-one", "One", true], ["grok-two", "Two", true]]);
  assert.match(provider.authDetail, /private home/); assert.equal(await readFile(f.path, "utf8"), before);
  const refused = await handleManagement({ operation: "discover", configPath: f.path, providerId: "grok", revision: result.revision }, dependencies);
  assert.deepEqual(refused.ok ? undefined : refused.error.code, "invalid_request"); assert.equal(await readFile(f.path, "utf8"), before);
});

test("a Grok connection with a written credential is ready, and a missing CLI is reported instead", async () => {
  const signed = await fixture();
  await mkdir(join(signed.root, "home-a"), { mode: 0o700 });
  await writeFile(join(signed.root, "home-a", "auth.json"), "{}", { mode: 0o600 });
  const ready = (await inspect(signed.path)).providers![0];
  assert.equal(ready.authState, "ready"); assert.equal(ready.canReconnect, true); assert.match(ready.authDetail, /Signed in/);

  const absent = await fixture();
  const missing = await handleManagement({ operation: "inspect", configPath: absent.path }, { lookupCli: async () => false });
  assert.equal(missing.ok, true); if (!missing.ok) throw new Error("inspect");
  assert.equal(missing.result.providers![0].authState, "missing-cli"); assert.equal(missing.result.providers![0].canReconnect, false);
});

/** The login itself is mocked, so these tests must not depend on Grok Build being installed on this host. */
async function installedGrok(t: test.TestContext): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-grok-cli-")); const previous = process.env.PATH;
  await writeFile(join(directory, "grok"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  process.env.PATH = `${directory}${delimiter}${previous ?? ""}`;
  t.after(() => { process.env.PATH = previous; });
}

test("Grok reconnect runs the CLI's device-code login in the gateway's private home", async t => {
  await installedGrok(t);
  const f = await fixture(); const snapshot = await inspect(f.path); const before = await readFile(f.path, "utf8");
  const calls: Array<{ command: string; args: string[]; home?: string }> = [];
  const signed = await handleManagement({ operation: "authenticate", configPath: f.path, providerId: "grok", revision: snapshot.revision }, { ...dependencies,
    runLogin: async (command, args, env) => { calls.push({ command, args, home: env.GROK_HOME }); await writeFile(join(f.root, "home-a", "auth.json"), "{}", { mode: 0o600 }); } });
  assert.equal(signed.ok, true); if (!signed.ok) throw new Error("authenticate");
  assert.equal(signed.result.providers![0].authState, "ready");
  assert.deepEqual(calls.map(call => call.args), [["login", "--device-auth"]]);
  assert.equal(resolve(calls[0].home!), resolve(f.root, "home-a"), "the login writes only to the gateway's private home");
  assert.equal(await readFile(f.path, "utf8"), before, "signing in never rewrites provider configuration");
});

test("Grok sign-in reports failure when the CLI exits without writing a credential", async () => {
  const f = await fixture(); const snapshot = await inspect(f.path);
  const failed = await handleManagement({ operation: "authenticate", configPath: f.path, providerId: "grok", revision: snapshot.revision },
    { ...dependencies, runLogin: async () => {} });
  assert.equal(failed.ok, false); if (failed.ok) throw new Error("expected failure");
  assert.equal(failed.error.code, "authentication_failed");
  assert.equal((await inspect(f.path)).providers![0].authState, "needs-sign-in", "a clean exit alone never marks the connection ready");
});

test("only a printed https sign-in URL is opened, never other CLI output", () => {
  assert.equal(firstSignInURL("Waiting...\n  https://accounts.x.ai/oauth2/device?user_code=AB12-CD34\nDone"), "https://accounts.x.ai/oauth2/device?user_code=AB12-CD34");
  assert.equal(firstSignInURL("Confirm (https://auth.x.ai/oauth2/authorize?x=1)."), "https://auth.x.ai/oauth2/authorize?x=1");
  assert.equal(firstSignInURL("http://127.0.0.1:56517/callback"), undefined);
  assert.equal(firstSignInURL("nothing to sign in"), undefined);
});

test("deselecting a Grok model and enabling it again restores its exact alias and metadata", async () => {
  const f = await fixture(); const original = (await f.raw()).providers[0];
  assert.equal((await select(f.path, ["grok-one"])).ok, true);
  let provider = (await f.raw()).providers[0]; assert.deepEqual(provider.models, { "grok/one": "grok-one" });
  const listed = (await inspect(f.path)).providers![0].models; assert.deepEqual(listed.map(model => [model.id, model.enabled, model.label]), [["grok-one", true, "One"], ["grok-two", false, "Two"]]);
  assert.equal((await select(f.path, ["grok-one", "grok-two"])).ok, true);
  provider = (await f.raw()).providers[0]; assert.deepEqual(provider.models, original.models); assert.deepEqual(provider.modelMetadata, original.modelMetadata);
});

test("a re-enabled Grok model uses configured metadata edited after it was cached", async () => {
  const f = await fixture();
  assert.equal((await select(f.path, ["grok-one"])).ok, true);
  const edited = await f.raw(); edited.providers[0].modelMetadata["grok/one"] = { displayName: "One Edited", contextWindow: 5000 }; await f.write(edited);
  // Removing a different model than the one edited must not resurrect the stale copy of the edited one.
  const added = await f.raw(); added.providers[0].models["grok/two"] = "grok-two"; added.providers[0].modelMetadata["grok/two"] = { displayName: "Two", contextWindow: 2000 }; await f.write(added);
  assert.equal((await select(f.path, ["grok-two"])).ok, true);
  assert.equal((await select(f.path, ["grok-one", "grok-two"])).ok, true);
  const provider = (await f.raw()).providers[0]; assert.deepEqual(provider.modelMetadata["grok/one"], { displayName: "One Edited", contextWindow: 5000 });
  assert.equal((await inspect(f.path)).providers![0].models.find(model => model.id === "grok-one")?.label, "One Edited");
});

test("an upstream model with several aliases and distinct metadata returns whole after being disabled", async () => {
  const f = await fixture("home-a", { "grok/one": "grok-one", "grok/two": "grok-two", "grok/two-fast": "grok-two" },
    { "grok/one": { displayName: "One" }, "grok/two": { displayName: "Two", contextWindow: 2000 }, "grok/two-fast": { displayName: "Two Fast", contextWindow: 3000 } });
  const original = (await f.raw()).providers[0];
  assert.equal((await select(f.path, ["grok-one"])).ok, true); assert.deepEqual((await f.raw()).providers[0].models, { "grok/one": "grok-one" });
  assert.equal((await select(f.path, ["grok-one", "grok-two"])).ok, true);
  const provider = (await f.raw()).providers[0];
  assert.deepEqual(Object.entries(provider.models).sort(), Object.entries(original.models).sort());
  assert.deepEqual(provider.modelMetadata, original.modelMetadata);
});

test("a Grok alias preserves accepted metadata beyond the old ledger cap", async () => {
  const metadata = { displayName: "One", contextWindow: 4096, providerNote: "x".repeat(17 * 1024) };
  const f = await fixture("home-a", { "grok/one": "grok-one", "grok/two": "grok-two" }, { "grok/one": metadata, "grok/two": { displayName: "Two", contextWindow: 4096 } });
  assert.equal((await select(f.path, ["grok-two"])).ok, true);
  assert.equal((await select(f.path, ["grok-one", "grok-two"])).ok, true);
  assert.deepEqual((await f.raw()).providers[0].modelMetadata["grok/one"], metadata);
});

test("a changed Grok home never reclaims or reuses another home's catalog or aliases", async () => {
  const f = await fixture();
  assert.equal((await select(f.path, ["grok-one"])).ok, true);
  assert.equal((await f.ledger()).aliases["grok/two"].model, "grok-two");
  // The same provider now points at a different private home with a different model.
  await f.write(f.config("home-b", { "grok/three": "grok-three" }, { "grok/three": { displayName: "Three" } }));
  const refused = await select(f.path, ["grok-one", "grok-three"]); assert.equal(refused.ok, false); assert.equal(refused.ok ? "" : refused.error.code, "invalid_request");
  await f.write(f.config("home-b", { "grok/one": "grok-one", "grok/three": "grok-three" }, { "grok/one": { displayName: "B One" }, "grok/three": { displayName: "Three" } }));
  assert.equal((await select(f.path, ["grok-three"])).ok, true);
  assert.equal((await select(f.path, ["grok-three", "grok-two"])).ok, false);
  const ledger = await f.ledger(); const homeA = JSON.parse(ledger.aliases["grok/two"].route).grokHome; assert.equal(homeA, resolve(f.root, "home-a"));
  assert.equal(JSON.parse(ledger.aliases["grok/one"].route).grokHome, resolve(f.root, "home-b"));
  assert.equal((await select(f.path, ["grok-three", "grok-one"])).ok, true);
  const models = (await f.raw()).providers[0].models; assert.deepEqual(models, { "grok/three": "grok-three", "grok/one": "grok-one" });
});

test("only Grok route fingerprints carry the Grok home", () => {
  const api = { id: "a", type: "responses-api", baseUrl: "https://x.example/v1", models: {} } as never;
  assert.equal(providerRoute(api), JSON.stringify({ type: "responses-api", id: "a", baseUrl: "https://x.example/v1" }));
  assert.notEqual(providerRoute({ id: "g", type: "grok-subscription", grokHome: "/a", models: {} } as never), providerRoute({ id: "g", type: "grok-subscription", grokHome: "/b", models: {} } as never));
});

test("client-only configurations cannot be edited through connection mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-client-management-")); const path = join(root, "gateway.json"); const state = join(root, "state"); await mkdir(state, { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, port: 1, stateDirectory: state, providers: [], clientOnly: true }), { mode: 0o600 }); const before = await readFile(path, "utf8");
  const revision = (await inspect(path)).revision;
  for (const request of [{ operation: "rename", providerId: "grok", label: "X" }, { operation: "remove", providerId: "grok" }, { operation: "models", providerId: "grok", selectedModels: ["m"] },
    { operation: "prepare", provider: { label: "X", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1" } }]) {
    const result = await handleManagement({ ...request, configPath: path, revision }, dependencies); assert.equal(result.ok, false);
    assert.equal(await readFile(path, "utf8"), before);
  }
});
