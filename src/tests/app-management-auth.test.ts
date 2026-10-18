import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleManagement } from "../app-management.js";
import { childLogin } from "../app-management/providers.js";

test("rejects traversal, unsafe URLs, a missing HTTPS key, and secret-bearing failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-management-auth-")); const path = join(root, "gateway.json");
  for (const request of [
    { operation: "inspect", configPath: "relative.json" },
    { operation: "prepare", configPath: path, provider: { label: "Bad", type: "responses-api", baseUrl: "https://key@example.test/v1", apiKey: "secret" } },
    { operation: "prepare", configPath: path, provider: { label: "Missing", type: "responses-api", baseUrl: "https://example.test/v1" } },
    { operation: "discover", configPath: path, draftId: "../../gateway.json" },
  ]) {
    const response = await handleManagement(request); assert.equal(response.ok, false); assert.equal(JSON.stringify(response).includes("secret"), false);
  }
});

test("maps sign-in failures without serializing credential material", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-management-auth-")); const path = join(root, "gateway.json");
  const prepare = await handleManagement({ operation: "prepare", configPath: path, provider: { label: "Codex", type: "codex-subscription" } }, { lookupCli: async () => true, signIn: async () => { throw new Error("token=secret"); } });
  assert.equal(prepare.ok, true); if (!prepare.ok) return;
  const auth = await handleManagement({ operation: "authenticate", configPath: path, draftId: prepare.result.draft!.id }, { lookupCli: async () => true, signIn: async () => { throw new Error("token=secret"); } });
  assert.deepEqual(auth, { ok: false, error: { code: "authentication_failed", message: "Sign-in did not complete." } });
});

test("refuses stale edits, invalid model choices, mismatched drafts, and removing the last provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-management-auth-")); const path = join(root, "gateway.json"); const other = join(root, "other.json");
  const config = { version: 1, port: 3457, stateDirectory: join(root, "state"), providers: [
    { id: "one", type: "responses-api", baseUrl: "http://127.0.0.1:3457/v1", credentialFile: join(root, "state", "one-key"), models: { "one/model": "model" } },
    { id: "two", type: "responses-api", baseUrl: "http://127.0.0.1:3457/v1", credentialFile: join(root, "state", "two-key"), models: { "two/model": "model" } },
  ] };
  await writeFile(path, JSON.stringify(config)); await chmod(path, 0o600);
  const inspected = await handleManagement({ operation: "inspect", configPath: path }); assert.equal(inspected.ok, true); if (!inspected.ok) return;
  await writeFile(path, JSON.stringify({ ...config, timeoutMs: 1000 })); await chmod(path, 0o600);
  const stale = await handleManagement({ operation: "models", configPath: path, providerId: "one", revision: inspected.result.revision, selectedModels: ["model"] });
  assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, "configuration_changed");
  const current = await handleManagement({ operation: "inspect", configPath: path }); assert.equal(current.ok, true); if (!current.ok) return;
  const empty = await handleManagement({ operation: "models", configPath: path, providerId: "one", revision: current.result.revision, selectedModels: [] });
  assert.equal(empty.ok, false);
  const unknown = await handleManagement({ operation: "models", configPath: path, providerId: "one", revision: current.result.revision, selectedModels: ["not-cached"] });
  assert.equal(unknown.ok, false);
  const draft = await handleManagement({ operation: "prepare", configPath: path, provider: { label: "Draft", type: "claude-subscription" } }, { lookupCli: async () => true });
  assert.equal(draft.ok, true); if (!draft.ok) return;
  const mismatch = await handleManagement({ operation: "discover", configPath: other, draftId: draft.result.draft!.id }); assert.equal(mismatch.ok, false);
  const removed = await handleManagement({ operation: "remove", configPath: path, providerId: "two", revision: current.result.revision }); assert.equal(removed.ok, true); if (!removed.ok) return;
  const last = await handleManagement({ operation: "remove", configPath: path, providerId: "one", revision: removed.result.revision }); assert.equal(last.ok, false); if (!last.ok) assert.equal(last.error.code, "invalid_configuration");
});

test("subscription logins isolate new provider homes, preserve Claude email hints, and scrub default homes", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-management-auth-")); const state = join(root, "state"); await mkdir(state);
  const draftPath = join(root, "draft.json");
  const draft = await handleManagement({ operation: "prepare", configPath: draftPath, provider: { label: "Claude", type: "claude-subscription", accountEmail: "person@example.test" } }, { lookupCli: async () => true });
  assert.equal(draft.ok, true); if (!draft.ok) return;
  const privateHome = join(root, "state", "connections", draft.result.draft!.id, "auth");
  const draftCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const authenticated = await handleManagement({ operation: "authenticate", configPath: draftPath, draftId: draft.result.draft!.id }, {
    lookupCli: async () => true, runLogin: async (_command, args, env) => { draftCalls.push({ args, env }); },
  });
  assert.equal(authenticated.ok, true); assert.deepEqual(draftCalls[0]?.args, ["auth", "login", "--claudeai", "--email", "person@example.test"]);
  assert.equal(draftCalls[0]?.env.CLAUDE_CONFIG_DIR, privateHome);
  for (const type of ["claude-subscription", "copilot-subscription"] as const) {
    const path = join(root, `${type}.json`); await writeFile(path, JSON.stringify({ version: 1, port: 3457, stateDirectory: state, providers: [{ id: "provider", type, models: { alias: "model" } }] }), { mode: 0o600 });
    const inspected = await handleManagement({ operation: "inspect", configPath: path }, { lookupCli: async () => true }); assert.equal(inspected.ok, true); if (!inspected.ok) continue;
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const result = await handleManagement({ operation: "authenticate", configPath: path, providerId: "provider", revision: inspected.result.revision }, {
      lookupCli: async () => true, runLogin: async (command, args, env) => { calls.push({ command, args, env }); },
    });
    assert.equal(result.ok, true); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, type === "claude-subscription" ? ["auth", "login", "--claudeai"] : ["login", "--web-flow"]);
    assert.equal(calls[0]!.env.ANTHROPIC_AUTH_TOKEN, undefined); assert.equal(calls[0]!.env.COPILOT_GITHUB_TOKEN, undefined);
    if (type === "claude-subscription") assert.equal(calls[0]!.env.CLAUDE_CONFIG_DIR, undefined);
    if (type === "copilot-subscription") assert.equal(calls[0]!.env.COPILOT_HOME, undefined);
  }
});

test("does not spawn a login when authentication is already aborted", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-management-auth-")); const path = join(root, "gateway.json"); const control = new AbortController(); control.abort();
  const prepared = await handleManagement({ operation: "prepare", configPath: path, provider: { label: "Claude", type: "claude-subscription" } }, { lookupCli: async () => true }); assert.equal(prepared.ok, true); if (!prepared.ok) return;
  let spawned = 0;
  const result = await handleManagement({ operation: "authenticate", configPath: path, draftId: prepared.result.draft!.id }, { lookupCli: async () => true, signal: control.signal, runLogin: async () => { spawned++; } });
  assert.equal(result.ok, false); assert.equal(spawned, 0);
});

test("Codex uses a verified private stored identity without requiring the Codex CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-management-auth-")); const path = join(root, "gateway.json"); const state = join(root, "state"); const credentials = join(state, "connections", "account", "credentials.json"); await mkdir(join(state, "connections", "account"), { recursive: true });
  await chmod(state, 0o700); await chmod(join(state, "connections"), 0o700); await chmod(join(state, "connections", "account"), 0o700);
  await writeFile(credentials, JSON.stringify({ email: "stored@example.test", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"] }), { mode: 0o600 });
  await writeFile(path, JSON.stringify({ version: 1, port: 3457, stateDirectory: state, providers: [{ id: "codex", type: "codex-subscription", credentialFile: credentials, models: { alias: "gpt" } }] }), { mode: 0o600 });
  const inspected = await handleManagement({ operation: "inspect", configPath: path }, { lookupCli: async () => false }); assert.equal(inspected.ok, true); if (!inspected.ok) return;
  assert.equal(inspected.result.providers?.[0]?.authState, "saved"); assert.equal(inspected.result.providers?.[0]?.canReconnect, true);
  let expected: string | undefined;
  const result = await handleManagement({ operation: "authenticate", configPath: path, providerId: "codex", revision: inspected.result.revision, provider: { accountEmail: "attacker@example.test" } }, {
    lookupCli: async () => false, signIn: async (_path, _name, _open, _signal, email) => { expected = email; },
  });
  assert.equal(result.ok, true); assert.equal(expected, "stored@example.test");
});

test("private state-root credentials reconnect while external API credentials remain external", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-management-auth-")); const state = join(root, "state"); await mkdir(state, { mode: 0o700 }); await chmod(state, 0o700);
  const apiCredential = join(state, "api-key"); const codexCredential = join(state, "credentials.json");
  await writeFile(apiCredential, "credential\n", { mode: 0o600 });
  await writeFile(codexCredential, JSON.stringify({ email: "stored@example.test", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"] }), { mode: 0o600 });
  const path = join(root, "gateway.json"); await writeFile(path, JSON.stringify({ version: 1, port: 3457, stateDirectory: state, providers: [
    { id: "api", type: "responses-api", baseUrl: "http://127.0.0.1:3457/v1", credentialFile: apiCredential, models: { api: "model" } },
    { id: "codex", type: "codex-subscription", credentialFile: codexCredential, models: { codex: "gpt" } },
    { id: "external", type: "responses-api", baseUrl: "http://127.0.0.1:3457/v1", credentialFile: join(root, "external-key"), models: { external: "model" } },
  ] }), { mode: 0o600 });
  await writeFile(join(root, "external-key"), "credential\n", { mode: 0o600 });
  const inspected = await handleManagement({ operation: "inspect", configPath: path }, { lookupCli: async () => false }); assert.equal(inspected.ok, true); if (!inspected.ok) return;
  const providers = new Map(inspected.result.providers?.map(provider => [provider.id, provider]));
  assert.equal(providers.get("api")?.canReconnect, true); assert.equal(providers.get("api")?.authState, "saved");
  assert.equal(providers.get("codex")?.canReconnect, true); assert.equal(providers.get("codex")?.authState, "saved");
  assert.equal(providers.get("external")?.canReconnect, false); assert.equal(providers.get("external")?.authState, "external-credential");
});

test("existing CLI connections are unchecked while new drafts still need sign-in", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-management-auth-")); const path = join(root, "gateway.json"); const state = join(root, "state"); await mkdir(state, { mode: 0o700 }); await chmod(state, 0o700);
  await writeFile(path, JSON.stringify({ version: 1, port: 3457, stateDirectory: state, providers: [{ id: "existing", type: "claude-subscription", models: { alias: "model" } }] }), { mode: 0o600 });
  const existing = await handleManagement({ operation: "inspect", configPath: path }, { lookupCli: async () => true }); assert.equal(existing.ok, true); if (!existing.ok) return;
  assert.equal(existing.result.providers?.[0]?.authState, "unchecked"); assert.equal(existing.result.providers?.[0]?.authDetail, "Provider sign-in has not been checked. Check connection to verify.");
  const draft = await handleManagement({ operation: "prepare", configPath: path, provider: { label: "New Codex", type: "codex-subscription" } }, { lookupCli: async () => false });
  assert.equal(draft.ok, true); if (!draft.ok) return;
  assert.equal(draft.result.draft?.provider.authState, "needs-sign-in");
});

test("aborting a resistant owned login child escalates and waits for its exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-management-auth-")); const marker = join(root, "login.pid"); const fakeClaude = join(root, "fake-claude.mjs");
  await writeFile(fakeClaude, "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.LOGIN_PID_MARKER, String(process.pid), { mode: 0o600 });\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n", { mode: 0o700 }); await chmod(fakeClaude, 0o700);
  const control = new AbortController(); const started = Date.now(); const login = childLogin(fakeClaude, [], { ...process.env, LOGIN_PID_MARKER: marker }, control.signal);
  let pid: number | undefined;
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      const value = await readFile(marker, "utf8").catch(() => ""); pid = Number(value);
      if (Number.isInteger(pid) && pid > 0) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(pid); control.abort(); await assert.rejects(login, /cancelled/); assert.ok(Date.now() - started < 2_000);
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* child already exited */ } }
  }
});

test("a linked state ancestor cannot redirect API-key replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-management-auth-")); const foreign = await mkdtemp(join(tmpdir(), "gateway-foreign-")); const linkedState = join(root, "state"); const credential = join(linkedState, "connections", "account", "api-key");
  await mkdir(join(foreign, "connections", "account"), { recursive: true }); const sentinel = join(foreign, "connections", "account", "api-key"); await writeFile(sentinel, "foreign-sentinel\n", { mode: 0o600 });
  await symlink(foreign, linkedState);
  const path = join(root, "gateway.json"); await writeFile(path, JSON.stringify({ version: 1, port: 3457, stateDirectory: linkedState, providers: [{ id: "api", type: "responses-api", baseUrl: "http://127.0.0.1:3457/v1", credentialFile: credential, models: { alias: "model" } }] }), { mode: 0o600 });
  const inspected = await handleManagement({ operation: "inspect", configPath: path }); assert.equal(inspected.ok, true); if (!inspected.ok) return;
  const result = await handleManagement({ operation: "authenticate", configPath: path, providerId: "api", revision: inspected.result.revision, provider: { apiKey: "replacement" } });
  assert.equal(result.ok, false); assert.equal(await readFile(sentinel, "utf8"), "foreign-sentinel\n");
});
