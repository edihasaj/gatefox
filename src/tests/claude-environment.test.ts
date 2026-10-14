import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeEnvironment } from "../providers/claude-environment.js";

/** A private account directory holding `token`; the mode is whatever the test asked for. */
const accountDir = (token: string, mode: number): string => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-claude-env-"));
  writeFileSync(join(directory, "oauth-token"), `${token}\n`, { mode: 0o600 });
  chmodSync(join(directory, "oauth-token"), mode);
  return directory;
};

test("the account's own token file reaches its CLI, and nothing else leaks", () => {
  const directory = accountDir("acct-secret", 0o600);
  try {
    const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const savedEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "host-secret";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    try {
      const env = claudeEnvironment(directory);
      assert.equal(env.CLAUDE_CONFIG_DIR, directory);
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "acct-secret", "the account token replaces the host one");
      assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined, "other host session vars stay stripped");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
      if (savedEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = savedEntrypoint;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a world-readable token is ignored rather than trusted", () => {
  const directory = accountDir("acct-secret", 0o644);
  try {
    assert.equal(claudeEnvironment(directory).CLAUDE_CODE_OAUTH_TOKEN, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a token reached through a symlink is ignored", () => {
  const root = mkdtempSync(join(tmpdir(), "gateway-claude-env-link-"));
  writeFileSync(join(root, "elsewhere"), "elsewhere-secret\n", { mode: 0o600 });
  const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    writeFileSync(join(root, "oauth-token"), "acct-secret\n", { mode: 0o600 });
    assert.notEqual(claudeEnvironment(root).CLAUDE_CODE_OAUTH_TOKEN, undefined, "the same file by name is trusted");
    rmSync(join(root, "oauth-token"));
    symlinkSync(join(root, "elsewhere"), join(root, "oauth-token"));
    assert.equal(claudeEnvironment(root).CLAUDE_CODE_OAUTH_TOKEN, undefined);
  } finally {
    if (saved !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("without an account directory the host token stays stripped", () => {
  const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "host-secret";
  try {
    assert.equal(claudeEnvironment().CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(claudeEnvironment().CLAUDE_CONFIG_DIR, undefined);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
  }
});

test("a directory with no token file strips the host token", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-claude-env-none-"));
  const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "host-secret";
  try {
    const env = claudeEnvironment(directory);
    assert.equal(env.CLAUDE_CONFIG_DIR, directory);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
    rmSync(directory, { recursive: true, force: true });
  }
});
