import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readdir, symlink, readlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { accountEnvironment, accountPinnedArgs, assertAccountId, prepareAccountHome, accountHomePath } from "../account-engine-home.js";
import { accountFixture } from "./account-fixture.js";

test("an account home links shared chat storage, never auth or config, and is private", async () => {
  const f = await accountFixture(); const home = await prepareAccountHome(f.state, "codex3", { model: "native", model_provider: "x", sqlite_home: f.nativeHome }, f.nativeHome);
  assert.equal(home, accountHomePath(f.state, "codex3")); assert.equal((await lstat(home)).mode & 0o777, 0o700);
  for (const name of ["sessions", "archived_sessions", "thread-writer-locks"]) assert.equal(await readlink(join(home, name)), join(f.nativeHome, name));
  const names = await readdir(home); assert.ok(!names.includes("auth.json")); assert.equal((await lstat(join(home, "config.toml"))).isSymbolicLink(), false);
  const config = await readFile(join(home, "config.toml"), "utf8");
  assert.match(config, /"cli_auth_credentials_store" = "file"/); assert.match(config, /"forced_login_method" = "chatgpt"/);
  assert.doesNotMatch(config, /must-never-be-copied|"model" =|model_provider/); assert.match(config, /memories" = false/);
});
test("a symlinked state path and a home inside the native home are refused", async () => {
  const f = await accountFixture(); await mkdir(join(f.root, "real")); await symlink(join(f.root, "real"), join(f.root, "linked"));
  await assert.rejects(prepareAccountHome(join(f.root, "linked"), "codex3", {}, f.nativeHome));
  await assert.rejects(prepareAccountHome(join(f.nativeHome, "state"), "codex3", {}, f.nativeHome), /separate from the native/);
  await assert.rejects(prepareAccountHome(f.state, "codex3", {}, f.state), /separate from the native/);
});
test("the pinned keys survive a snapshot rewrite, including the workspace", async () => {
  const f = await accountFixture(); await prepareAccountHome(f.state, "a", { forced_login_method: "api", cli_auth_credentials_store: "keyring" }, f.nativeHome, "ws_1");
  const config = await readFile(join(accountHomePath(f.state, "a"), "config.toml"), "utf8");
  assert.match(config, /"forced_login_method" = "chatgpt"/); assert.doesNotMatch(config, /keyring|"api"/); assert.match(config, /"forced_chatgpt_workspace_id" = "ws_1"/);
  assert.deepEqual(accountPinnedArgs(), ["-c", 'cli_auth_credentials_store="file"', "-c", 'forced_login_method="chatgpt"']);
  assert.throws(() => accountPinnedArgs("bad value"));
});
test("the environment strips API keys and sets the remote-control flag; names are validated", () => {
  process.env.OPENAI_API_KEY = "x"; process.env.CODEX_ACCESS_TOKEN = "y";
  try { const env = accountEnvironment("/tmp/home"); assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.CODEX_ACCESS_TOKEN, undefined); assert.equal(env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED, "1"); assert.equal(env.CODEX_HOME, "/tmp/home"); }
  finally { delete process.env.OPENAI_API_KEY; delete process.env.CODEX_ACCESS_TOKEN; }
  for (const bad of ["", "A", "../x", "1a", "a".repeat(33)]) assert.throws(() => assertAccountId(bad));
  assertAccountId("codex3");
});
