import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../config.js";
import { antigravityDriver, antigravityPermission, antigravityToolGuard } from "../providers/antigravity-acp.js";
import { antigravityCliDir, antigravityEnv, antigravityManagedSettings, antigravityTokenFile, ensureAntigravityHome, hasAntigravityLogin, provisionAntigravityHome } from "../providers/antigravity-home.js";
import { ProviderError } from "../providers/provider.js";

const base = { version: 1 as const, port: 3457, stateDirectory: "/state", providers: [{ id: "gemini", label: "Gemini", type: "gemini-subscription" as const, models: { "gemini/neon": "gemini-4-neon" } }] };
const catalog = new Set(["exec_command", "read_file"]);
// The options Antigravity CLI 1.5.14 offers on every permission request.
const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }];
const asked = (name: string, rawInput: Record<string, unknown> = {}) => ({ sessionId: "s", options, toolCall: { name, rawInput, status: "pending", title: "Run exec_command" } });
const token = (refresh = "r") => JSON.stringify({ auth_method: "consumer", id_token_email: "user@example.com", token: { access_token: "a", refresh_token: refresh, token_type: "Bearer", expiry: "2026-11-23T10:00:00Z" } });
const sessionRoot = () => mkdtemp(join(tmpdir(), "gateway-gemini-live-"));

test("geminiCli selects gemini or antigravity on a Gemini provider only", () => {
  const config = validateConfig({ ...structuredClone(base), providers: [{ ...base.providers[0]!, geminiCli: "antigravity" as const }] }, "/etc");
  assert.equal(config.providers[0]!.geminiCli, "antigravity");
  assert.throws(() => validateConfig({ ...structuredClone(base), providers: [{ ...base.providers[0]!, geminiCli: "agy" as never }] }, "/etc"), /geminiCli must be/);
  assert.throws(() => validateConfig({ ...structuredClone(base), providers: [{ ...base.providers[0]!, type: "responses-api" as never, baseUrl: "https://x.example/v1", apiKeyEnv: "K", geminiCli: "antigravity" as const }] }, "/e"), /geminiCli must be/);
});

test("only the caller's own gateway tools and reads of the cached gateway schemas are allowed", async () => {
  assert.deepEqual(antigravityPermission(asked("mcp_gateway_exec_command"), catalog), { allowed: true, result: { outcome: { outcome: "selected", optionId: "allow" } } });
  const refused = { allowed: false, result: { outcome: { outcome: "selected", optionId: "deny" } } };
  // A native tool is refused even when its name or title matches a caller tool, and so is a gateway tool outside the catalog.
  assert.deepEqual(antigravityPermission(asked("run_command", { CommandLine: "whoami" }), catalog), refused);
  assert.deepEqual(antigravityPermission(asked("read_file", { Path: "/etc/passwd" }), catalog), refused);
  assert.deepEqual(antigravityPermission(asked("mcp_gateway_apply_patch"), catalog), refused);
  assert.deepEqual(antigravityPermission(asked("mcp_other_exec_command"), catalog), refused);
  const root = await sessionRoot();
  try {
    const schemas = join(root, "home/.gemini/antigravity-cli/mcp/gateway");
    assert.equal(antigravityPermission(asked("read_file", { Path: join(schemas, "exec_command.json") }), catalog).allowed, true);
    assert.equal(antigravityPermission(asked("read_file", { Path: join(schemas, "../../../settings.json") }), catalog).allowed, false);
    assert.equal(antigravityPermission(asked("read_file", { Path: join(root, "home/.gemini/antigravity-cli/antigravity-oauth-token") }), catalog).allowed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
  // Without a rejection option the request is cancelled rather than allowed.
  assert.deepEqual(antigravityPermission({ toolCall: { name: "run_command" }, options: [] }, catalog), { allowed: false, result: { outcome: { outcome: "cancelled" } } });
});

test("the guard ends a session only when a native tool reports that it ran", () => {
  const update = (name: string, status: string) => ({ sessionUpdate: "tool_call_update", toolCallId: "c", name, status, rawInput: {} });
  // The CLI announces every call in_progress before it asks, and a refused call ends failed: neither proves a run.
  assert.equal(antigravityToolGuard(update("run_command", "in_progress"), catalog), undefined);
  assert.equal(antigravityToolGuard(update("run_command", "failed"), catalog), undefined);
  assert.equal(antigravityToolGuard(update("mcp_gateway_exec_command", "completed"), catalog), undefined);
  assert.equal(antigravityToolGuard(update("run_command", "completed"), catalog), "invalid_tool_call");
  assert.equal(antigravityToolGuard(update("mcp_gateway_apply_patch", "completed"), catalog), "invalid_tool_call");
});

test("the driver selects the model, mode and thinking level after session/new and appends the system prompt", () => {
  assert.deepEqual(antigravityDriver.args({ model: "gemini-4-neon" }), ["acp", "--disable-telemetry"]);
  assert.deepEqual(antigravityDriver.sessionConfig!({ model: "gemini-4-neon", effort: "xhigh" }),
    [{ configId: "model", value: "gemini-4-neon" }, { configId: "mode", value: "default" }, { configId: "thought_level", value: "xhigh" }]);
  assert.deepEqual(antigravityDriver.sessionConfig!({ model: "gemini-4-hydrogen" }), [{ configId: "model", value: "gemini-4-hydrogen" }, { configId: "mode", value: "default" }]);
  assert.deepEqual(antigravityDriver.sessionParams!("Be brief."), { _meta: { antigravity: { systemPrompt: { append: "Be brief." } } } });
});

test("the managed settings make every native action ask and never spend AI credits or auto-approve", () => {
  const settings = JSON.parse(antigravityManagedSettings()) as Record<string, unknown>;
  assert.equal(settings.toolPermission, "strict");
  assert.equal(settings.agentMode, "");
  assert.equal(settings.useG1Credits, false);
  assert.equal(settings.modelProvider, "");
  assert.deepEqual((settings.permissions as { deny: string[] }).deny, ["command(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "download_url(*)"]);
});

test("the CLI environment carries no Google, Gemini or Antigravity variable", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GEMINI_API_KEY: "k", GOOGLE_CLOUD_PROJECT: "p", AGY_ADC_AUTH: "true", USER: "edi" });
    const env = antigravityEnv("/private/home");
    assert.equal(env.HOME, "/private/home");
    assert.equal(env.USER, "edi");
    assert.deepEqual(Object.keys(env).filter(name => /^(GEMINI|GOOGLE|AGY|VERTEX)/.test(name)), []);
  } finally { for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved); }
});

test("a session gets a private copy of the sign-in, and only a refreshed usable token is carried back", async () => {
  const home = await mkdtemp(join(tmpdir(), "agy-home-"));
  const root = await sessionRoot();
  try {
    await assert.rejects(ensureAntigravityHome(home), (error: unknown) => error instanceof ProviderError && error.status === 401);
    await ensureAntigravityHome(home, { requireLogin: false });
    await writeFile(antigravityTokenFile(home), JSON.stringify({ token: { access_token: "a" } }), { mode: 0o600 });
    assert.equal(await hasAntigravityLogin(home), false, "a token without a refresh token is not a sign-in");
    await writeFile(antigravityTokenFile(home), token(), { mode: 0o600 });
    assert.equal(await hasAntigravityLogin(home), true);
    await ensureAntigravityHome(home);

    const provisioned = await provisionAntigravityHome(home, root);
    const scratch = join(root, "home");
    assert.equal(provisioned.env.HOME, scratch);
    assert.equal(await readFile(antigravityTokenFile(scratch), "utf8"), token());
    assert.equal((await stat(antigravityTokenFile(scratch))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(antigravityCliDir(scratch), "settings.json"), "utf8"), antigravityManagedSettings());
    assert.deepEqual(JSON.parse(await readFile(join(scratch, ".gemini/config/mcp_config.json"), "utf8")), { mcpServers: {} });

    await writeFile(antigravityTokenFile(scratch), "{}");
    await provisioned.release();
    assert.equal(await readFile(antigravityTokenFile(home), "utf8"), token(), "an unusable token never replaces the sign-in");
    await writeFile(antigravityTokenFile(scratch), token("refreshed"));
    await provisioned.release();
    assert.equal(await readFile(antigravityTokenFile(home), "utf8"), token("refreshed"));
  } finally { await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});

test("a session cannot start without a sign-in", async () => {
  const home = await mkdtemp(join(tmpdir(), "agy-home-"));
  const root = await sessionRoot();
  try {
    await mkdir(antigravityCliDir(home), { recursive: true, mode: 0o700 });
    await assert.rejects(provisionAntigravityHome(home, root), (error: unknown) => error instanceof ProviderError && error.status === 401);
  } finally { await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});
