import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const cli = fileURLToPath(new URL("../cli.js", import.meta.url));

async function setup(signedInAs: string) {
  const root = await mkdtemp(join(tmpdir(), "gw-claude-login-")); const bin = join(root, "bin"); const home = join(root, "claude-2"); const state = join(root, "state");
  await mkdir(bin); await mkdir(home); await mkdir(state, { mode: 0o700 });
  const log = join(root, "calls.log");
  await writeFile(join(bin, "claude"), `#!/bin/sh
echo "$*" >> '${log}'
case "$*" in
  "auth login"*) printf '{"oauthAccount":{"emailAddress":"%s"}}' '${signedInAs}' > "$CLAUDE_CONFIG_DIR/.claude.json" ;;
  "auth logout") rm -f "$CLAUDE_CONFIG_DIR/.claude.json" ;;
esac
`, { mode: 0o755 });
  const config = join(root, "gateway.json");
  await writeFile(config, JSON.stringify({ version: 1, port: 3999, stateDirectory: state, providers: [{ id: "claude-secondary", type: "claude-subscription", authDirectory: home, models: { "claude-secondary/x": "x" } }] }), { mode: 0o600 });
  const run = () => promisify(execFile)(process.execPath, [cli, "login", "claude-secondary", "--config", config, "--account-email", "Right@Example.test"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  return { run, log, home };
}

test("Claude login with --account-email pre-fills the address and accepts the matching account", { skip: process.platform === "win32" }, async () => {
  const f = await setup("right@example.test");
  const result = await f.run();
  assert.match(result.stdout, /claude-secondary: signed in/);
  assert.deepEqual((await readFile(f.log, "utf8")).trim().split("\n"), ["auth login --email Right@Example.test"]);
});

test("Claude login that lands on another account is signed out and fails with both addresses", { skip: process.platform === "win32" }, async () => {
  const f = await setup("work@example.test");
  await assert.rejects(f.run(), (error: { stderr?: string }) => /signed in as work@example\.test, not Right@Example\.test; that login was signed out/.test(error.stderr ?? ""));
  assert.deepEqual((await readFile(f.log, "utf8")).trim().split("\n"), ["auth login --email Right@Example.test", "auth logout"]);
  await assert.rejects(access(join(f.home, ".claude.json")));
});
