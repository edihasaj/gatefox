import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Keep the native CLI on its subscription login, even when API exports exist. Host Claude Code
 * session variables (a gateway started from a Claude Code shell) are dropped too: they make a live
 * CLI act between requests, a desktop entrypoint adds a post-turn summary request to every turn, and
 * CLAUDE_CODE_EFFORT_LEVEL would replace the per-model default effort that discovery reads.
 * Token-profile accounts are the one exception: `authDirectory`'s own `oauth-token` is passed back as
 * CLAUDE_CODE_OAUTH_TOKEN, so this account's CLI signs in as this account and never as the host shell's.
 */
export function claudeEnvironment(authDirectory?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("ANTHROPIC_") || name === "CLAUDECODE" || name.startsWith("CLAUDE_CODE_") || name.startsWith("CLAUDE_AGENT_SDK_")) delete env[name];
  }
  if (authDirectory) {
    env.CLAUDE_CONFIG_DIR = authDirectory;
    const token = accountToken(authDirectory);
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  return env;
}

/** The account's stored token, only from a regular private file this user owns; the value is never logged. */
function accountToken(authDirectory: string): string | undefined {
  try {
    const path = join(authDirectory, "oauth-token");
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077) return;
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return;
  }
}
