import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { accountCommand, accountDoctor } from "../account-command.js";
import { emailHash, identityPath, nativeIdentityPath } from "../account-login.js";
import { writeFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { accountFixture } from "./account-fixture.js";

const run = async (f: Awaited<ReturnType<typeof accountFixture>>, args: string[], extra: Record<string, unknown> = {}) => {
  const out: string[] = []; const code = await accountCommand(args, { configPath: f.configPath, nativeHome: f.nativeHome, stdio: "ignore", write: text => out.push(text), preflightTimeoutMs: 8000, env: { ...process.env, WORK_TOKEN: "tok-secret-value" }, ...extra });
  return { code, out: out.join("") };
};
const withNative = async () => { const f = await accountFixture(); await writeFile(nativeIdentityPath(f.state), JSON.stringify({ version: 1, emailSha256: emailHash("primary@example.test") }), { mode: 0o600 }); return f; };

test("add needs --type for a new name, writes valid config, and keeps the stored type", async () => {
  const f = await accountFixture();
  assert.match((await run(f, ["add", "codex3"])).out, /Choose --type codex or --type claude/);
  assert.equal((await run(f, ["add", "codex3", "--type", "codex", "--label", "Codex 3"])).code, 0);
  assert.equal((await run(f, ["add", "work", "--type", "claude"])).code, 0);
  const config = await loadConfig(f.configPath); assert.deepEqual(config.accountEngines, [{ id: "codex3", type: "codex", label: "Codex 3" }]);
  assert.equal(config.providers.find(p => p.id === "work")?.type, "claude-subscription");
  assert.match((await run(f, ["add", "codex3", "--type", "claude"])).out, /cannot become claude/);
  await run(f, ["add", "codex3", "--label", "Renamed"]); assert.equal((await loadConfig(f.configPath)).accountEngines![0].label, "Renamed");
  assert.equal((await run(f, ["add", "BAD NAME", "--type", "codex"])).code, 1);
});
test("login auto-adds an unknown name when --type is given and fails without it", async () => {
  const f = await withNative();
  assert.match((await run(f, ["login", "codex3", "--codex", f.codex])).out, /Choose --type/);
  const r = await run(f, ["login", "codex3", "--type", "codex", "--codex", f.codex]); assert.equal(r.code, 0); assert.match(r.out, /codex3: signed in \(plan: pro\)/);
  assert.deepEqual((await loadConfig(f.configPath)).accountEngines, [{ id: "codex3", type: "codex", label: "codex3" }]);
});
test("status, list and doctor never contain an email or token, and doctor spawns nothing", async () => {
  const f = await withNative(); await run(f, ["login", "codex3", "--type", "codex", "--codex", f.codex]);
  const before = (await f.calls()).length; const rows = await accountDoctor(f.configPath, f.nativeHome); assert.equal((await f.calls()).length, before);
  assert.deepEqual(rows.map(r => [r.id, r.type, r.ready]), [["codex3", "codex", true]]);
  const status = await run(f, ["status", "codex3", "--codex", f.codex]); assert.match(status.out, /logged in/);
  const json = await run(f, ["status", "--json", "--codex", f.codex]); const list = await run(f, ["list"]);
  for (const text of [status.out, json.out, list.out, JSON.stringify(rows), await readFile(identityPath(f.state, "codex3"), "utf8")]) assert.doesNotMatch(text, /example\.test|tok-secret|@|eyJ/);
  assert.equal(JSON.parse(json.out)[0].identity, "verified");
});
test("claude accounts sign in under their own directory and refuse the default login's identity", async () => {
  const f = await accountFixture(); const claude = ["--claude", f.claude];
  const ok = await run(f, ["login", "work", "--type", "claude", ...claude], { discover: async () => [{ model: "sonnet-9", metadata: {} }] }); assert.equal(ok.code, 0, ok.out);
  const calls = (await f.calls()).filter(c => c.claude); assert.deepEqual(calls[1].claude, ["auth", "login", "--claudeai"]); assert.match(calls[1].dir, /accounts\/work\/claude$/);
  assert.deepEqual((await loadConfig(f.configPath)).providers.find(p => p.id === "work")!.models, { "work/sonnet-9": "sonnet-9" });
  await writeFile(f.claudeEmail, "main@example.test"); // the second sign-in is the default user
  const clash = await run(f, ["login", "other", "--type", "claude", ...claude]); assert.equal(clash.code, 1); assert.match(clash.out, /same Claude user as the default Claude login/);
  await assert.rejects(readFile(identityPath(f.state, "other")), { code: "ENOENT" });
  assert.doesNotMatch(ok.out + clash.out, /example\.test/);
});
test("a token profile reads the variable once, stores it privately and passes it only to that account", async () => {
  const f = await accountFixture(); const r = await run(f, ["login", "tok", "--type", "claude", "--claude", f.claude, "--token-env", "WORK_TOKEN"], { discover: async () => [] });
  assert.equal(r.code, 0, r.out); assert.doesNotMatch(r.out, /tok-secret/);
  assert.equal(JSON.stringify(await f.calls()).includes("tok-secret"), false); assert.ok((await f.calls()).some(c => c.claude && c.hasToken));
  assert.equal((await readFile(`${f.state}/accounts/tok/claude/oauth-token`, "utf8")).trim(), "tok-secret-value");
});
test("logout --remove drops the account from the configuration", async () => {
  const f = await withNative(); await run(f, ["login", "codex3", "--type", "codex", "--codex", f.codex]);
  assert.equal((await run(f, ["logout", "codex3", "--codex", f.codex, "--remove"])).code, 0); assert.equal((await loadConfig(f.configPath)).accountEngines, undefined);
});
