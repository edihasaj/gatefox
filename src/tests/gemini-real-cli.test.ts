import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ensureGeminiHome, geminiBuiltInTools, geminiCommand, geminiPolicyFile, hasGeminiLogin } from "../providers/gemini-home.js";
import { geminiLogin } from "../providers/gemini-login.js";
import { GeminiSubscription } from "../providers/gemini.js";
import { ProviderError } from "../providers/provider.js";

/**
 * Checks against the real Gemini CLI, which only run where 0.70.x is installed. They run no inference. The policy check is
 * offline and always runs; the two that start the real CLI are opt-in (`GATEWAY_TEST_REAL_GEMINI=1`) because they exercise its
 * sign-in code, which the CLI may answer with a network call to Google's token endpoint.
 */
const run = promisify(execFile);
type Core = { loadPoliciesFromToml(paths: string[], tier: (path: string) => number): Promise<{ rules: Array<Record<string, unknown>>; errors: Array<Record<string, unknown>> }>;
  createPolicyEngineConfig(settings: object, mode: unknown, defaults: string, interactive: boolean): Promise<Record<string, unknown>>;
  PolicyEngine: new (config: Record<string, unknown>) => { check(call: { name: string; args: object }, server?: string): Promise<{ decision: string; rule?: { source?: string } }> };
  ApprovalMode: { DEFAULT: unknown } };

async function realCli(t: TestContext): Promise<{ bundle: string } | undefined> {
  const command = await geminiCommand().catch(() => undefined);
  if (!command) { t.skip("the Gemini CLI is not installed"); return undefined; }
  const version = (await run(command, ["--version"], { env: { PATH: process.env.PATH, HOME: process.env.HOME } }).catch(() => ({ stdout: "" }))).stdout.trim();
  if (!version.startsWith("0.70.")) { t.skip(`these checks were written against Gemini CLI 0.70.x, not ${version || "an unknown version"}`); return undefined; }
  return { bundle: dirname(await realpath(command)) };
}
/** The bundle's core chunk, which exports the policy loader; chunk names are hashes, so it is found by what it holds. */
async function core(bundle: string): Promise<Core> {
  for (const name of (await readdir(bundle)).filter(file => /^chunk-.*\.js$/.test(file))) {
    if ((await readFile(join(bundle, name), "utf8")).includes("async function loadPoliciesFromToml(")) return await import(pathToFileURL(join(bundle, name)).href) as Core;
  }
  throw new Error("the policy loader was not found in the Gemini CLI bundle");
}

test("the CLI's own policy loader reads the managed policy file, and tells a malformed one from a good one", { timeout: 60000 }, async t => {
  const cli = await realCli(t); if (!cli) return;
  const root = await mkdtemp(join(tmpdir(), "gemini-real-policy-")); const saved = process.env.GEMINI_CLI_HOME;
  try {
    const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
    await ensureGeminiHome(home, { requireLogin: false });
    const bundle = await core(cli.bundle);
    const policies = dirname(geminiPolicyFile(home));
    const load = () => bundle.loadPoliciesFromToml([policies], () => 4);

    // A good file: parsed with no error and no warning (an unrecognised tool name would be reported as one).
    const good = await load();
    assert.deepEqual(good.errors, [], "the loader reports neither an error nor a warning for the gateway's file");
    assert.equal(good.rules.length, 2 + geminiBuiltInTools.length, "every rule in the file was loaded: the ask rule, one deny per built-in, and the catch-all");
    process.env.GEMINI_CLI_HOME = home;
    const engine = new bundle.PolicyEngine(await bundle.createPolicyEngineConfig({}, bundle.ApprovalMode.DEFAULT, join(cli.bundle, "policies"), true));
    const decide = async (name: string) => (await engine.check({ name, args: {} }, undefined));
    const asked = await decide("mcp_gateway_lookup");
    assert.equal(asked.decision, "ask_user", "a caller tool goes to the gateway's permission answer");
    assert.match(String(asked.rule?.source), /gateway\.toml/, "and it is this file that says so");
    for (const name of ["read_file", "grep_search", "glob", "list_directory", "google_web_search", "run_shell_command", "invoke_agent", "mcp_other_tool"]) {
      const denied = await decide(name);
      assert.equal(denied.decision, "deny", `${name} is denied, where the CLI's bundled defaults would allow or ask`);
      assert.match(String(denied.rule?.source), /gateway\.toml/);
    }

    // Malformed TOML: the loader reports it (stderr is not the channel) and loads nothing — and the bundled defaults then allow read_file.
    await writeFile(geminiPolicyFile(home), `${await readFile(geminiPolicyFile(home), "utf8")}\n[[rule\n`);
    const malformed = await load();
    assert.deepEqual(malformed.errors.map(error => error.errorType), ["toml_parse"]);
    assert.equal(malformed.rules.length, 0, "a file that does not parse contributes no rule at all");
    const fallback = new bundle.PolicyEngine(await bundle.createPolicyEngineConfig({}, bundle.ApprovalMode.DEFAULT, join(cli.bundle, "policies"), true));
    assert.equal((await fallback.check({ name: "read_file", args: {} }, undefined)).decision, "allow", "which is why the gateway rewrites the file before every spawn and checks it");

    // A well-formed file with an invalid rule fails schema validation the same way.
    await writeFile(geminiPolicyFile(home), '[[rule]]\ntoolName = "mcp_gateway_*"\ndecision = "maybe"\npriority = 5000\n');
    assert.deepEqual((await load()).errors.map(error => error.errorType), ["schema_validation"]);
  } finally { if (saved === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = saved; await rm(root, { recursive: true, force: true }); }
});

const real = process.env.GATEWAY_TEST_REAL_GEMINI === "1" ? undefined : "set GATEWAY_TEST_REAL_GEMINI=1 to start the real Gemini CLI";

test("the real CLI accepts the answered consent and asks for the sign-in URL through the opener", { timeout: 60000, skip: real }, async t => {
  if (!await realCli(t)) return;
  const root = await mkdtemp(join(tmpdir(), "gemini-real-login-"));
  try {
    const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
    const control = new AbortController(); const urls: string[] = [];
    // The login is cancelled the moment the URL arrives: the sign-in itself is never completed.
    const outcome = await geminiLogin({ home, signal: control.signal, timeoutMs: 40000, openUrl: url => { urls.push(url); control.abort(); } }).then(() => "signed in", error => (error as Error).message);
    assert.equal(outcome, "cancelled");
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.equal(await hasGeminiLogin(home), false, "no credential: the flow stopped at the browser");
    assert.deepEqual((await readdir(join(home, ".gemini"))).filter(name => name === "tmp" || name === "history"), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("with a sign-in that cannot refresh, the real CLI asks for a browser, the stand-in catches it, and the request is a 401", { timeout: 90000, skip: real }, async t => {
  if (!await realCli(t)) return;
  const root = await mkdtemp(join(tmpdir(), "gemini-real-boot-"));
  try {
    const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
    await ensureGeminiHome(home, { requireLogin: false });
    await writeFile(join(home, ".gemini/oauth_creds.json"), JSON.stringify({ access_token: "bogus", refresh_token: "bogus-refresh", expiry_date: 1, token_type: "Bearer" }), { mode: 0o600 });
    const provider = new GeminiSubscription({ id: "gemini-real", type: "gemini-subscription", geminiHome: home, models: { alias: "gemini-3.1-pro-preview" } });
    const input = [{ type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text: "never sent" }] }];
    const failure = await (async () => { for await (const event of provider.infer({ model: "gemini-3.1-pro-preview", input }, new AbortController().signal, { threadId: "real-boot" })) void event; })().then(() => undefined, error => error as ProviderError);
    assert.ok(failure instanceof ProviderError);
    assert.equal(failure.status, 401);
    assert.equal(failure.code, "authentication");
  } finally { await rm(root, { recursive: true, force: true }); }
});
