import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runSubscriptionLogin } from "../app-management/providers.js";
import type { ProviderConfig } from "../config.js";
import { ensureGeminiHome, hasGeminiLogin } from "../providers/gemini-home.js";
import { geminiLogin, geminiSignInUrl } from "../providers/gemini-login.js";
import { ProviderError } from "../providers/provider.js";
import { adapter, alive, harness, turn, until, user, type Harness } from "./gemini-live-harness.js";

const rejected = (promise: Promise<unknown>) => promise.then(() => undefined, error => error as Error);
const exists = (path: string) => access(path).then(() => true, () => false);
const loginHome = async (h: Harness) => { const home = join(h.directory, "login-home"); await mkdir(home, { mode: 0o700 }); return home; };
const credentials = async (home: string) => JSON.parse(await readFile(join(home, ".gemini/oauth_creds.json"), "utf8")) as Record<string, string>;
const recorded = async (home: string) => (await readdir(join(home, ".gemini"))).filter(name => name === "tmp" || name === "history");
const finished = async (h: Harness) => {
  for (const pid of await h.pids()) assert.ok(await until(() => !alive(pid)), "the CLI was ended");
  assert.ok(await until(async () => (await h.liveDirs()).length === 0), "the login's disposable home and folders are removed");
};

test("login answers the consent question, opens the URL the CLI asks its browser to open, and trusts only the credential", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const home = await loginHome(h); const urls: string[] = [];
    await geminiLogin({ home, openUrl: url => { urls.push(url); } });
    assert.equal(urls.length, 1, "the URL is opened once");
    assert.match(urls[0], /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    const log = await h.log();
    assert.deepEqual(log.filter(entry => entry.op === "consent").map(entry => entry.yes), [true], "Y was written to stdin once the CLI asked");
    assert.ok(!log.some(entry => entry.op === "no-stand-in"), "the CLI's opener was the gateway's stand-in: the helper alone opens the browser");
    assert.deepEqual(await credentials(home), { access_token: "login-access", refresh_token: "login-refresh" });
    assert.equal((await stat(join(home, ".gemini/oauth_creds.json"))).mode & 0o777, 0o600);
    assert.equal(await hasGeminiLogin(home), true);
    assert.deepEqual(await recorded(home), [], "what the CLI recorded during login stayed in its disposable home");
    await finished(h);
  } finally { await h.restore(); }
});

test("login never runs the CLI in the caller's directory, and keeps it in an empty private folder", { timeout: 40000 }, async () => {
  const h = await harness(); const caller = process.cwd();
  try {
    // A trusted workspace's own settings and .env must not be reachable from the sign-in.
    const workspace = join(h.directory, "workspace"); await mkdir(join(workspace, ".gemini"), { recursive: true });
    await writeFile(join(workspace, ".gemini/settings.json"), "{}"); await writeFile(join(workspace, ".env"), "GEMINI_API_KEY=must-not-load\n");
    process.chdir(workspace);
    const home = await loginHome(h);
    await geminiLogin({ home, openUrl: () => {} });
    process.chdir(caller);
    const spawn = (await h.log()).find(entry => entry.op === "spawn")!;
    assert.deepEqual(spawn.args, [], "no subcommand: the CLI has no login command");
    assert.notEqual(spawn.cwd, workspace);
    assert.ok(!String(spawn.cwd).startsWith(workspace) && String(spawn.cwd).startsWith(await realpath(h.scratch)), "the working directory is the gateway's own scratch folder");
    assert.equal(spawn.cwdEntries, 0, "empty");
    assert.equal(spawn.cwdMode, 0o700, "private");
    assert.notEqual(spawn.home, home, "and the CLI's home is disposable too");
    assert.deepEqual(spawn.browserEnv, { ci: false, ssh: false, browser: false, debian: false });
    assert.deepEqual(spawn.leaked, [], "no API key reaches the sign-in");
    assert.equal(await exists(join(home, ".env")) || await exists(join(home, ".gemini/.env")), false, "the gateway never creates a .env file");
    await finished(h);
  } finally { process.chdir(caller); await h.restore(); }
});

test("login is judged by the credential file alone, never by the exit code", { timeout: 60000 }, async () => {
  const h = await harness();
  try {
    // A clean exit with no credential is a failed login: this is what the old stdin-closed run did.
    process.env.GATEWAY_TEST_GEMINI_LOGIN = "exit0";
    const first = await loginHome(h);
    const error = await rejected(geminiLogin({ home: first, openUrl: () => {}, pollMs: 50 }));
    assert.match(String(error?.message), /did not complete/);
    assert.equal(await hasGeminiLogin(first), false);
    // A failing exit after the credential was written is a successful one.
    process.env.GATEWAY_TEST_GEMINI_LOGIN = "creds-exit1";
    await geminiLogin({ home: first, openUrl: () => {}, pollMs: 50 });
    assert.equal(await hasGeminiLogin(first), true);
    // A credential without a refresh token is not a sign-in; the helper gives up at its deadline and ends the CLI.
    process.env.GATEWAY_TEST_GEMINI_LOGIN = "norefresh";
    const second = join(h.directory, "second-home"); await mkdir(second, { mode: 0o700 });
    const timedOut = await rejected(geminiLogin({ home: second, openUrl: () => {}, timeoutMs: 3000, pollMs: 50 }));
    assert.match(String(timedOut?.message), /timed out/);
    assert.equal(await hasGeminiLogin(second), false);
    assert.equal(await exists(join(second, ".gemini/oauth_creds.json")), false, "nothing unusable was installed");
    await finished(h);
  } finally { await h.restore(); }
});

test("only a Google sign-in URL is ever opened", { timeout: 40000 }, async () => {
  assert.equal(geminiSignInUrl("https://accounts.google.com/o/oauth2/v2/auth?x=1\n")?.startsWith("https://accounts.google.com/"), true);
  for (const text of ["", "http://accounts.google.com/o/oauth2", "https://evil.example/o/oauth2", "https://accounts.google.com.evil.example/x", "https://user@accounts.google.com/x", "file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
    assert.equal(geminiSignInUrl(text), undefined, text);
  }
  const h = await harness();
  try {
    process.env.GATEWAY_TEST_GEMINI_LOGIN = "foreignurl"; const opened: string[] = [];
    const home = await loginHome(h);
    await geminiLogin({ home, openUrl: url => { opened.push(url); }, pollMs: 50 });
    assert.deepEqual(opened, [], "a URL that is not Google's is dropped");
    assert.equal(await hasGeminiLogin(home), true, "the credential, not the URL, decides success");
  } finally { await h.restore(); }
});

test("a home holding a .env file is refused before any CLI starts, for sign-in and inference alike", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    for (const where of [".env", ".gemini/.env"]) {
      const home = join(h.directory, `env-${where.replace(/\W/g, "")}`); await mkdir(join(home, ".gemini"), { recursive: true, mode: 0o700 });
      await writeFile(join(home, where), "GEMINI_API_KEY=must-not-load\n");
      for (const attempt of [() => geminiLogin({ home, openUrl: () => {} }), () => ensureGeminiHome(home, { requireLogin: false })]) {
        const error = await rejected(attempt());
        assert.ok(error instanceof ProviderError, where);
        assert.equal(error.status, 400); assert.match(error.message, /\.env/);
      }
    }
    assert.equal((await h.log()).length, 0, "no CLI was started");
    // The inference path checks the persistent home too.
    await writeFile(join(h.home, ".env"), "GEMINI_API_KEY=must-not-load\n");
    const error = await rejected(turn(adapter(), [user("start [plain]")]));
    assert.ok(error instanceof ProviderError && error.status === 400);
    assert.equal((await h.log()).length, 0, "the request was refused before a CLI started");
  } finally { await h.restore(); }
});

test("cancelling a login ends the CLI and removes its folders", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    process.env.GATEWAY_TEST_GEMINI_LOGIN = "norefresh"; // never produces a usable credential, so the helper keeps waiting
    const control = new AbortController(); const home = await loginHome(h);
    const pending = rejected(geminiLogin({ home, openUrl: () => {}, signal: control.signal, pollMs: 50 }));
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "consent")), "the CLI was asked and answered");
    control.abort();
    assert.match(String((await pending)?.message), /cancelled/);
    await finished(h);
  } finally { await h.restore(); }
});

test("the desktop app's Reconnect uses the same verified flow and opens the URL itself", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const home = await loginHome(h); const urls: string[] = [];
    const provider: ProviderConfig = { id: "gemini", type: "gemini-subscription", geminiHome: home, models: {} };
    await runSubscriptionLogin(provider, { lookupCli: async () => true, openBrowser: async url => { urls.push(url); } });
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^https:\/\/accounts\.google\.com\//);
    assert.equal(await hasGeminiLogin(home), true);
    assert.deepEqual(await recorded(home), []);
    await finished(h);
  } finally { await h.restore(); }
});
